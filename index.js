/**
 * SHIB (BEP20) Auto Payout Worker - نسخة ملف واحد
 * --------------------------------------------------
 * بيقرا طلبات السحب "pending" من Firebase Realtime Database
 * وبيبعت SHIB فعلي على شبكة BNB Smart Chain، وبيحدّث الحالة بعد كل عملية.
 *
 * كل القيم (المفاتيح، الروابط، إلخ) بتيجي من Environment Variables
 * المفروض تتحط في Railway > Variables - مفيش أي بيانات حساسة في الكود ده.
 */

const http = require('http');
const cron = require('node-cron');
const admin = require('firebase-admin');
const { ethers } = require('ethers');

// ============================================================
// 1) تحميل وفحص متغيرات البيئة (Environment Variables)
// ============================================================

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`متغير بيئة ناقص: ${name} - ضيفه في Railway > Variables`);
  }
  return value;
}

const config = {
  // Firebase
  firebaseDatabaseURL: required('FIREBASE_DATABASE_URL'),
  firebaseServiceAccountJSON: required('FIREBASE_SERVICE_ACCOUNT_JSON'),

  // BNB Smart Chain / Wallet
  rpcUrl: required('RPC_URL'),
  privateKey: required('PRIVATE_KEY'),
  shibContractAddress: process.env.SHIB_CONTRACT_ADDRESS || '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D',
  nativeTokenSymbol: process.env.NATIVE_TOKEN_SYMBOL || 'BNB',

  // إعدادات التشغيل والأمان
  pollCron: process.env.POLL_CRON || '* * * * *',
  maxWithdrawalAmount: Number(process.env.MAX_WITHDRAWAL_AMOUNT || 100000000),
  confirmations: Number(process.env.CONFIRMATIONS || 2),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  port: Number(process.env.PORT || 3000),
};

// ============================================================
// 2) Logger بسيط
// ============================================================

function ts() {
  return new Date().toISOString();
}
const logger = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, ...a),
};

// ============================================================
// 3) Firebase Admin SDK
// ============================================================

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.firebaseServiceAccountJSON);
  } catch (err) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON غير صالح كـ JSON. تأكد إنك نسخت محتوى ملف service account كامل في سطر واحد داخل Railway Variables.'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.firebaseDatabaseURL,
  });

  firebaseInitialized = true;
  logger.info('Firebase Admin SDK initialized.');
}

function db() {
  initFirebase();
  return admin.database();
}

/**
 * يرجع كل طلبات السحب اللي status بتاعها "pending"
 * بيدعم هيكلين:
 *   - Flat:  withdrawals/{withdrawalId}/{amount,status,ts,walletAddress}
 *   - Nested: withdrawals/{groupId}/{withdrawalId}/{amount,status,ts,walletAddress}
 *
 * بيكتشف الهيكل تلقائيًا: لو القيمة عندها "status" مباشرة → flat، غير كده → nested.
 */
async function getPendingWithdrawals() {
  const snapshot = await db().ref('withdrawals').once('value');
  const all = snapshot.val() || {};
  const pending = [];

  for (const key of Object.keys(all)) {
    const node = all[key] || {};

    // Flat structure: withdrawals/{withdrawalId} له status مباشرة
    if (typeof node.status === 'string') {
      if (node.status === 'pending') {
        pending.push({
          groupId: null,          // مفيش groupId في الهيكل الـ flat
          withdrawalId: key,
          amount: node.amount,
          walletAddress: node.walletAddress,
          ts: node.ts,
        });
      }
      continue;
    }

    // Nested structure: withdrawals/{groupId}/{withdrawalId}
    for (const withdrawalId of Object.keys(node)) {
      const item = node[withdrawalId];
      if (item && item.status === 'pending') {
        pending.push({
          groupId: key,
          withdrawalId,
          amount: item.amount,
          walletAddress: item.walletAddress,
          ts: item.ts,
        });
      }
    }
  }
  return pending;
}

/**
 * يحجز الطلب بتحويل حالته من pending لـ processing بشكل atomic
 * عشان يمنع تنفيذ نفس الطلب مرتين لو حصل تداخل بين تشغيلتين.
 */
// بيبني الـ Firebase path بناءً على هيكل البيانات (flat أو nested)
function withdrawalPath(groupId, withdrawalId) {
  return groupId
    ? `withdrawals/${groupId}/${withdrawalId}`
    : `withdrawals/${withdrawalId}`;
}

async function claimWithdrawal(groupId, withdrawalId) {
  const statusRef = db().ref(`${withdrawalPath(groupId, withdrawalId)}/status`);
  const result = await statusRef.transaction((current) => {
    if (current === 'pending') return 'processing';
    return undefined; // إلغاء الـ transaction لو الحالة مش pending
  });
  return result.committed && result.snapshot.val() === 'processing';
}

async function markCompleted(groupId, withdrawalId, txHash) {
  await db().ref(withdrawalPath(groupId, withdrawalId)).update({
    status: 'completed',
    txHash,
    completedAt: Date.now(),
  });
}

async function markFailed(groupId, withdrawalId, errorMessage) {
  await db().ref(withdrawalPath(groupId, withdrawalId)).update({
    status: 'failed',
    error: String(errorMessage).slice(0, 500),
    failedAt: Date.now(),
  });
}

// ============================================================
// 4) BNB Smart Chain / SHIB transfer logic
// ============================================================

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
];

let provider;
let wallet;
let contract;
let cachedDecimals;

function getProvider() {
  if (!provider) provider = new ethers.JsonRpcProvider(config.rpcUrl);
  return provider;
}

function getWallet() {
  if (!wallet) {
    const pk = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    wallet = new ethers.Wallet(pk, getProvider());
  }
  return wallet;
}

function getContract() {
  if (!contract) {
    contract = new ethers.Contract(config.shibContractAddress, ERC20_ABI, getWallet());
  }
  return contract;
}

async function getDecimals() {
  if (cachedDecimals === undefined) {
    cachedDecimals = await getContract().decimals();
  }
  return cachedDecimals;
}

async function getShibBalance() {
  const decimals = await getDecimals();
  const raw = await getContract().balanceOf(getWallet().address);
  return ethers.formatUnits(raw, decimals);
}

async function getNativeBalance() {
  const raw = await getProvider().getBalance(getWallet().address);
  return ethers.formatEther(raw); // BNB و ETH كلاهما 18 decimal
}

/**
 * يبعت كمية SHIB (بالعدد البشري) لعنوان معين، ويرجع txHash لو نجح.
 */
async function sendShib(toAddress, amountHuman) {
  if (!ethers.isAddress(toAddress)) {
    throw new Error(`عنوان محفظة غير صالح: ${toAddress}`);
  }

  const amountNumber = Number(amountHuman);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    throw new Error(`مبلغ غير صالح: ${amountHuman}`);
  }

  if (amountNumber > config.maxWithdrawalAmount) {
    throw new Error(
      `المبلغ ${amountNumber} أكبر من الحد الأقصى المسموح (${config.maxWithdrawalAmount}). راجع الطلب يدويًا.`
    );
  }

  const decimals = await getDecimals();
  const amountWei = ethers.parseUnits(amountNumber.toString(), decimals);

  const balanceWei = await getContract().balanceOf(getWallet().address);
  if (balanceWei < amountWei) {
    throw new Error('رصيد SHIB في المحفظة غير كافٍ لتنفيذ هذا السحب.');
  }

  if (config.dryRun) {
    logger.warn(`[DRY_RUN] هيتم تخطي الإرسال الفعلي. كان المفروض يتبعت ${amountNumber} SHIB لـ ${toAddress}`);
    return `DRYRUN-${Date.now()}`;
  }

  const tx = await getContract().transfer(toAddress, amountWei);
  logger.info(`Tx submitted: ${tx.hash} -> waiting for ${config.confirmations} confirmation(s)...`);
  const receipt = await tx.wait(config.confirmations);

  if (!receipt || receipt.status !== 1) {
    throw new Error(`فشلت معاملة البلوكتشين (status != 1). tx: ${tx.hash}`);
  }
  return tx.hash;
}

// ============================================================
// 5) منطق المعالجة الرئيسي + الجدولة + health server
// ============================================================

let isRunning = false; // قفل بسيط لمنع تشغيل دورتين فوق بعض

async function processOneWithdrawal({ groupId, withdrawalId, amount, walletAddress }) {
  const label = `${groupId}/${withdrawalId}`;

  const claimed = await claimWithdrawal(groupId, withdrawalId);
  if (!claimed) {
    logger.info(`تخطي ${label} - تم حجزها بالفعل أو حالتها تغيرت.`);
    return;
  }

  try {
    logger.info(`بدء تنفيذ السحب ${label}: ${amount} SHIB -> ${walletAddress}`);
    const txHash = await sendShib(walletAddress, amount);
    await markCompleted(groupId, withdrawalId, txHash);
    logger.info(`تم بنجاح ${label}. tx: ${txHash}`);
  } catch (err) {
    logger.error(`فشل تنفيذ السحب ${label}:`, err.message || err);
    await markFailed(groupId, withdrawalId, err.message || String(err));
  }
}

async function processPendingWithdrawals() {
  if (isRunning) {
    logger.warn('دورة فحص سابقة لسه شغالة، هنتخطى هذه الدورة.');
    return;
  }
  isRunning = true;

  try {
    const pending = await getPendingWithdrawals();
    if (pending.length === 0) {
      logger.info('لا توجد طلبات سحب pending حاليًا.');
      return;
    }

    logger.info(`وجدت ${pending.length} طلب/طلبات pending. بدء المعالجة بالتتابع...`);
    for (const withdrawal of pending) {
      await processOneWithdrawal(withdrawal); // بالتتابع لتجنب مشاكل nonce
    }
  } catch (err) {
    logger.error('خطأ غير متوقع خلال دورة الفحص:', err.message || err);
  } finally {
    isRunning = false;
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', dryRun: config.dryRun }));
  });
  server.listen(config.port, () => {
    logger.info(`Health check server listening on port ${config.port}`);
  });
}

async function main() {
  logger.info(`بدء تشغيل shib-auto-payout. DRY_RUN=${config.dryRun}`);
  if (config.dryRun) {
    logger.warn(
      'الأداة شغالة في وضع DRY_RUN - لن يتم إرسال أي SHIB فعلي. لتفعيل الإرسال الحقيقي حط DRY_RUN=false في Railway Variables.'
    );
  }

  startHealthServer();

  try {
    const nativeBalance = await getNativeBalance();
    const shibBalance = await getShibBalance();
    logger.info(`رصيد المحفظة الحالي: ${shibBalance} SHIB | ${nativeBalance} ${config.nativeTokenSymbol} (للـ gas)`);
  } catch (err) {
    logger.error('فشل في قراءة رصيد المحفظة عند البدء - تحقق من RPC_URL و PRIVATE_KEY:', err.message || err);
  }

  await processPendingWithdrawals(); // أول دورة فورًا عند الإقلاع
  cron.schedule(config.pollCron, processPendingWithdrawals);
  logger.info(`تمت الجدولة على: ${config.pollCron}`);
}

main().catch((err) => {
  logger.error('فشل تشغيل الأداة:', err.message || err);
  process.exit(1);
});
