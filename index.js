/**
 * SHIB (BEP20) Auto Payout Worker
 * --------------------------------------------------
 * - بيقرا طلبات السحب "pending" من Firebase Realtime Database
 * - بيبعت SHIB فعلي على شبكة BNB Smart Chain
 * - بيبعت رسالة تهنئة للمستخدم على Telegram بعد نجاح السحب
 * - لوحة تحكم للأدمن عبر أوامر Telegram Bot
 *
 * Environment Variables المطلوبة في Railway > Variables:
 *   FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_JSON,
 *   RPC_URL, PRIVATE_KEY,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ID
 */

const http = require('http');
const https = require('https');
const cron = require('node-cron');
const admin = require('firebase-admin');
const { ethers } = require('ethers');

// ============================================================
// 1) تحميل وفحص متغيرات البيئة
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

  // Telegram
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramAdminIds: (process.env.TELEGRAM_ADMIN_IDS || required('TELEGRAM_ADMIN_ID'))
    .split(',')
    .map(id => String(id.trim()))
    .filter(Boolean), // قائمة IDs الأدمن مفصولة بفاصلة
  paymentsChannelId: process.env.PAYMENTS_CHANNEL_ID || '@SHIB_Mj', // قناة المدفوعات اللي بينزل فيها اثبات السحوبات
  botAppUrl: process.env.BOT_APP_URL || 'https://t.me/M_SHIBEARNBOT?startapp=8965HU6HOS', // رابط فتح البوت/الميني آب

  // إعدادات التشغيل والأمان
  pollCron: process.env.POLL_CRON || '* * * * *',
  maxWithdrawalAmount: Number(process.env.MAX_WITHDRAWAL_AMOUNT || 100000000),
  confirmations: Number(process.env.CONFIRMATIONS || 2),
  dryRun: String(process.env.DRY_RUN || 'true').toLowerCase() === 'true',
  port: Number(process.env.PORT || 3000),
};

// ============================================================
// 2) Logger
// ============================================================

function ts() { return new Date().toISOString(); }
const logger = {
  info:  (...a) => console.log(`[${ts()}] [INFO]`,  ...a),
  warn:  (...a) => console.warn(`[${ts()}] [WARN]`,  ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, ...a),
};

// ============================================================
// 3) Telegram Helper
// ============================================================

/**
 * بيبعت رسالة Telegram عبر Bot API
 * @param {string|number} chatId  - معرف المحادثة أو المستخدم
 * @param {string}        text    - نص الرسالة (يدعم HTML)
 */
function sendTelegram(chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${config.telegramBotToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) logger.warn(`[Telegram] فشل الإرسال لـ ${chatId}: ${parsed.description}`);
        } catch (_) {}
        resolve();
      });
    });

    req.on('error', (err) => {
      logger.error(`[Telegram] خطأ في الإرسال لـ ${chatId}:`, err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

/**
 * بيبعت صورة + caption عبر Telegram Bot API (sendPhoto)
 * @param {string|number} chatId      - معرف المحادثة (أو @channelusername)
 * @param {string}        photoUrl    - رابط الصورة
 * @param {string}        caption     - نص الرسالة المرفق بالصورة (يدعم HTML)
 * @param {object}        [replyMarkup] - inline_keyboard اختياري
 */
function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup) {
  return new Promise((resolve) => {
    const payload = {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'HTML',
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const body = JSON.stringify(payload);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${config.telegramBotToken}/sendPhoto`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) logger.warn(`[Telegram] فشل إرسال الصورة لـ ${chatId}: ${parsed.description}`);
        } catch (_) {}
        resolve();
      });
    });

    req.on('error', (err) => {
      logger.error(`[Telegram] خطأ في إرسال الصورة لـ ${chatId}:`, err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

/** بيجيب بيانات المستخدم (username, name) من Telegram عبر getChat */
function getTelegramChatInfo(chatId) {
  return new Promise((resolve) => {
    if (!chatId) { resolve(null); return; }
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${config.telegramBotToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      method: 'GET',
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.ok ? parsed.result : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** بيرجع تاريخ ووقت بصيغة "29 Jun 2026, 14:35 UTC" */
function formatDateUTC(date = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

// روابط وصور ثابتة لرسائل الترحيب والسحب
const WELCOME_IMAGE_URL = 'https://res.cloudinary.com/dkqea6vpm/image/upload/v1782744816/ChatGPT_Image_Jun_29_2026_05_51_46_PM_rjgwoq.png';
const WITHDRAWAL_SUCCESS_IMAGE_URL = 'https://res.cloudinary.com/dkqea6vpm/image/upload/v1782744816/ChatGPT_Image_Jun_29_2026_05_52_30_PM_rjklhu.png';
const PAYMENTS_CHANNEL_URL = 'https://t.me/SHIB_Mj';

/** بيبعت رسالة الترحيب للمستخدمين العاديين (غير الأدمن) */
async function sendWelcomeMessage(chatId) {
  const caption =
    `🐕 <b>Welcome to SHIB Rewards!</b>\n\n` +
    `Complete simple tasks, invite friends, and earn SHIBA every day.\n\n` +
    `🚀 Finish tasks to collect rewards.\n` +
    `🎁 Claim daily bonuses.\n` +
    `👥 Invite friends for extra earnings.\n` +
    `💸 Withdraw your SHIBA when you reach the minimum amount.\n\n` +
    `Start earning now and grow your SHIBA balance!`;

  const replyMarkup = {
    inline_keyboard: [
      [{ text: '📢 Payments Channel', url: PAYMENTS_CHANNEL_URL }],
      [{ text: '🚀 Open App', url: config.botAppUrl }],
    ],
  };

  await sendTelegramPhoto(chatId, WELCOME_IMAGE_URL, caption, replyMarkup);
}

/** بيبعت رسالة تهنئة للمستخدم بعد نجاح السحب (بالإنجليزي + صورة) */
async function notifyUserSuccess(groupId, amount, txHash) {
  if (!groupId) return; // flat structure - مفيش user ID
  const txUrl = `https://bscscan.com/tx/${txHash}`;
  const amountFormatted = Number(amount).toLocaleString('en-US');

  const caption =
    `🎉 <b>Withdrawal Completed Successfully!</b>\n\n` +
    `Your SHIB withdrawal has been processed and sent to your wallet. ✅\n\n` +
    `💎 <b>Amount:</b> ${amountFormatted} SHIB\n` +
    `🌐 <b>Network:</b> BEP-20\n` +
    `🔗 <b>Transaction:</b> <a href="${txUrl}">View on BscScan</a>\n\n` +
    `⏱ It may take a few minutes to appear in your wallet depending on network congestion.\n\n` +
    `Thank you for using SHIB Rewards! 🐕🚀`;

  const replyMarkup = { inline_keyboard: [[{ text: '🔗 View Transaction', url: txUrl }]] };

  await sendTelegramPhoto(groupId, WITHDRAWAL_SUCCESS_IMAGE_URL, caption, replyMarkup);
  logger.info(`[Telegram] Sent success message to user ${groupId}`);
}

/** بيبعت إثبات السحب في قناة المدفوعات */
async function notifyPaymentsChannel(groupId, amount, walletAddress, txHash) {
  const txUrl = `https://bscscan.com/tx/${txHash}`;
  const amountFormatted = Number(amount).toLocaleString('en-US');
  const chatInfo = await getTelegramChatInfo(groupId);
  const username = chatInfo && chatInfo.username ? `@${chatInfo.username}` : 'N/A';
  const fullName = chatInfo
    ? [chatInfo.first_name, chatInfo.last_name].filter(Boolean).join(' ') || 'N/A'
    : 'N/A';

  const caption =
    `🎉 <b>Withdrawal Completed Successfully!</b>\n\n` +
    `A new SHIB withdrawal has been processed successfully. ✅\n\n` +
    `👤 <b>User Information</b>\n` +
    `• User ID: <code>${groupId || 'N/A'}</code>\n` +
    `• Username: <code>${username}</code>\n` +
    `• Name: <code>${fullName}</code>\n\n` +
    `💸 <b>Withdrawal Details</b>\n` +
    `• Amount: ${amountFormatted} SHIB\n` +
    `• Network: BEP-20\n` +
    `• Wallet: <code>${walletAddress}</code>\n` +
    `• Transaction ID: <code>${txHash}</code>\n` +
    `• Status: Completed ✅\n` +
    `• Date: ${formatDateUTC()}\n\n` +
    `Thank you for using SHIB Rewards! 🐕🚀`;

  const replyMarkup = { inline_keyboard: [[{ text: '🔗 View Transaction', url: txUrl }]] };

  await sendTelegramPhoto(config.paymentsChannelId, WITHDRAWAL_SUCCESS_IMAGE_URL, caption, replyMarkup);
  logger.info(`[Telegram] تم إرسال إثبات السحب لقناة المدفوعات (${config.paymentsChannelId})`);
}

/** بيبعت إشعار للأدمن عند فشل سحب */
async function notifyAdminFailure(groupId, withdrawalId, amount, walletAddress, errorMessage) {
  const message =
    `⚠️ <b>فشل تنفيذ سحب!</b>\n\n` +
    `👤 <b>المستخدم:</b> ${groupId || 'غير معروف'}\n` +
    `🆔 <b>ID السحب:</b> <code>${withdrawalId}</code>\n` +
    `💎 <b>المبلغ:</b> ${Number(amount).toLocaleString('en-US')} SHIB\n` +
    `👛 <b>المحفظة:</b> <code>${walletAddress}</code>\n\n` +
    `❌ <b>السبب:</b> ${errorMessage}`;

  for (const adminId of config.telegramAdminIds) await sendTelegram(adminId, message);
}

/** بيبعت إشعار للأدمن لما السحب يتخطى الحد الأقصى - الطلب فضل pending ومحتاج تدخل يدوي */
async function notifyAdminOverLimit(groupId, withdrawalId, amount, walletAddress) {
  const message =
    `⏳ <b>طلب سحب متجاوز الحد الأقصى - في حالة انتظار</b>\n\n` +
    `👤 <b>المستخدم:</b> ${groupId || 'غير معروف'}\n` +
    `🆔 <b>ID السحب:</b> <code>${withdrawalId}</code>\n` +
    `💎 <b>المبلغ:</b> ${Number(amount).toLocaleString('en-US')} SHIB\n` +
    `🔒 <b>الحد الأقصى الحالي:</b> ${config.maxWithdrawalAmount.toLocaleString('en-US')} SHIB\n` +
    `👛 <b>المحفظة:</b> <code>${walletAddress}</code>\n\n` +
    `⚠️ تم ترك الطلب في حالة <b>pending</b> ولن يُرفض تلقائياً.\n` +
    `لتنفيذه: رفّع الحد الأقصى عبر /setmax أو نفّذ السحب يدوياً، أو هيتحاول تلقائياً تاني في الدورة الجاية.`;

  for (const adminId of config.telegramAdminIds) await sendTelegram(adminId, message);
}

// ============================================================
// 4) Firebase Admin SDK
// ============================================================

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.firebaseServiceAccountJSON);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON غير صالح كـ JSON.');
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

async function getPendingWithdrawals() {
  const snapshot = await db().ref('withdrawals').once('value');
  const all = snapshot.val() || {};
  const pending = [];

  for (const key of Object.keys(all)) {
    const node = all[key] || {};

    // Flat: withdrawals/{withdrawalId}
    if (typeof node.status === 'string') {
      if (node.status === 'pending') {
        pending.push({ groupId: null, withdrawalId: key, amount: node.amount, walletAddress: node.walletAddress, ts: node.ts });
      }
      continue;
    }

    // Nested: withdrawals/{groupId}/{withdrawalId}
    for (const withdrawalId of Object.keys(node)) {
      const item = node[withdrawalId];
      if (item && item.status === 'pending') {
        pending.push({ groupId: key, withdrawalId, amount: item.amount, walletAddress: item.walletAddress, ts: item.ts });
      }
    }
  }
  return pending;
}

function withdrawalPath(groupId, withdrawalId) {
  return groupId ? `withdrawals/${groupId}/${withdrawalId}` : `withdrawals/${withdrawalId}`;
}

async function claimWithdrawal(groupId, withdrawalId) {
  const statusRef = db().ref(`${withdrawalPath(groupId, withdrawalId)}/status`);
  try {
    const result = await statusRef.transaction((current) => {
      if (current === 'pending') return 'processing';
      return undefined;
    });
    if (result.committed && result.snapshot.val() === 'processing') return true;
  } catch (txErr) {
    logger.warn(`[claim-tx] transaction فشل (${txErr.message}) - هنجرب read+write بديل`);
  }
  const snap = await statusRef.once('value');
  const current = snap.val();
  if (current !== 'pending') return false;
  await statusRef.set('processing');
  return true;
}

async function markCompleted(groupId, withdrawalId, txHash) {
  await db().ref(withdrawalPath(groupId, withdrawalId)).update({ status: 'completed', txHash, completedAt: Date.now() });
  notifiedOverLimitIds.delete(withdrawalId);
}

async function markFailed(groupId, withdrawalId, errorMessage) {
  await db().ref(withdrawalPath(groupId, withdrawalId)).update({ status: 'failed', error: String(errorMessage).slice(0, 500), failedAt: Date.now() });
}

/** بيرجع حالة الطلب لـ pending - بيستخدم لما المبلغ يتخطى الحد الأقصى بدل ما يترفض */
async function revertToPending(groupId, withdrawalId) {
  await db().ref(withdrawalPath(groupId, withdrawalId)).update({ status: 'pending' });
}

// تتبع الطلبات اللي تم تنبيه الأدمن عنها بسبب تخطي الحد الأقصى (لمنع تكرار التنبيه كل دقيقة)
const notifiedOverLimitIds = new Set();

// ============================================================
// 5) BNB Smart Chain / SHIB transfer logic
// ============================================================

/** خطأ مخصص: المبلغ متجاوز الحد الأقصى - بيستخدم لمنع تحويل الطلب لـ failed */
class MaxAmountExceededError extends Error {}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
];

let provider, wallet, contract, cachedDecimals;

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
  if (!contract) contract = new ethers.Contract(config.shibContractAddress, ERC20_ABI, getWallet());
  return contract;
}

async function getDecimals() {
  if (cachedDecimals === undefined) cachedDecimals = await getContract().decimals();
  return cachedDecimals;
}

async function getShibBalance() {
  const decimals = await getDecimals();
  const raw = await getContract().balanceOf(getWallet().address);
  return ethers.formatUnits(raw, decimals);
}

async function getNativeBalance() {
  const raw = await getProvider().getBalance(getWallet().address);
  return ethers.formatEther(raw);
}

async function sendShib(toAddress, amountHuman) {
  if (!ethers.isAddress(toAddress)) throw new Error(`عنوان محفظة غير صالح: ${toAddress}`);
  const amountNumber = Number(amountHuman);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) throw new Error(`مبلغ غير صالح: ${amountHuman}`);
  if (amountNumber > config.maxWithdrawalAmount) {
    throw new MaxAmountExceededError(`المبلغ ${amountNumber} أكبر من الحد الأقصى (${config.maxWithdrawalAmount}).`);
  }
  const decimals = await getDecimals();
  const amountWei = ethers.parseUnits(amountNumber.toString(), decimals);
  const balanceWei = await getContract().balanceOf(getWallet().address);
  if (balanceWei < amountWei) throw new Error('رصيد SHIB في المحفظة غير كافٍ.');

  if (config.dryRun) {
    logger.warn(`[DRY_RUN] تخطي الإرسال: ${amountNumber} SHIB -> ${toAddress}`);
    return `DRYRUN-${Date.now()}`;
  }

  const tx = await getContract().transfer(toAddress, amountWei);
  logger.info(`Tx submitted: ${tx.hash}`);
  const receipt = await tx.wait(config.confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`فشلت المعاملة. tx: ${tx.hash}`);
  return tx.hash;
}

// ============================================================
// 6) معالجة السحوبات
// ============================================================

let isRunning = false;
let isPaused = false; // حالة الإيقاف المؤقت

async function processOneWithdrawal({ groupId, withdrawalId, amount, walletAddress }) {
  const label = `${groupId}/${withdrawalId}`;
  const claimed = await claimWithdrawal(groupId, withdrawalId);
  if (!claimed) {
    logger.info(`تخطي ${label} - تم حجزها بالفعل أو حالتها تغيرت.`);
    return;
  }
  try {
    logger.info(`بدء السحب ${label}: ${amount} SHIB -> ${walletAddress}`);
    const txHash = await sendShib(walletAddress, amount);
    await markCompleted(groupId, withdrawalId, txHash);
    logger.info(`تم بنجاح ${label}. tx: ${txHash}`);
    // إشعار المستخدم بالنجاح + نشر إثبات السحب في قناة المدفوعات
    await notifyUserSuccess(groupId, amount, txHash);
    await notifyPaymentsChannel(groupId, amount, walletAddress, txHash);
  } catch (err) {
    logger.error(`فشل السحب ${label}:`, err.message || err);

    // لو السبب إن المبلغ متخطي الحد الأقصى: سيبه pending من غير ما نغير حالته لـ failed
    if (err instanceof MaxAmountExceededError) {
      await revertToPending(groupId, withdrawalId);
      if (!notifiedOverLimitIds.has(withdrawalId)) {
        notifiedOverLimitIds.add(withdrawalId);
        await notifyAdminOverLimit(groupId, withdrawalId, amount, walletAddress);
      }
      return;
    }

    await markFailed(groupId, withdrawalId, err.message || String(err));
    await notifyAdminFailure(groupId, withdrawalId, amount, walletAddress, err.message || String(err));
  }
}

async function processPendingWithdrawals() {
  if (isPaused) {
    logger.info('السحب التلقائي متوقف مؤقتاً (paused).');
    return;
  }
  if (isRunning) {
    logger.warn('دورة فحص سابقة لسه شغالة، هنتخطى هذه الدورة.');
    return;
  }
  isRunning = true;
  try {
    const pending = await getPendingWithdrawals();
    if (pending.length === 0) { logger.info('لا توجد طلبات pending.'); return; }
    logger.info(`وجدت ${pending.length} طلب/طلبات pending.`);
    for (const withdrawal of pending) {
      await processOneWithdrawal(withdrawal);
    }
  } catch (err) {
    logger.error('خطأ غير متوقع:', err.message || err);
  } finally {
    isRunning = false;
  }
}

// ============================================================
// 7) لوحة تحكم الأدمن عبر Telegram Bot (Polling)
// ============================================================

let lastUpdateId = 0;

/**
 * بيجيب updates جديدة من Telegram
 */
async function fetchTelegramUpdates() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${config.telegramBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
      method: 'GET',
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve({ ok: false, result: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: false, result: [] }));
    req.end();
  });
}

/**
 * معالجة أوامر الأدمن
 */
async function handleAdminCommand(chatId, text) {
  const cmd = text.trim().split(' ')[0].toLowerCase();
  const args = text.trim().split(' ').slice(1);

  // التحقق من صلاحية الأدمن (احتياطي - الفلترة الأساسية بتحصل في pollTelegramCommands)
  if (!config.telegramAdminIds.includes(String(chatId))) {
    await sendWelcomeMessage(chatId);
    return;
  }

  try {
    // ─────────────────────────────────────────
    if (cmd === '/balance' || cmd === '/رصيد') {
      await sendTelegram(chatId, '⏳ جاري جلب الأرصدة...');
      const shib = await getShibBalance();
      const bnb  = await getNativeBalance();
      const shibFormatted = Number(shib).toLocaleString('en-US', { maximumFractionDigits: 0 });
      await sendTelegram(chatId,
        `💼 <b>رصيد المحفظة</b>\n\n` +
        `💎 SHIB: <b>${shibFormatted}</b>\n` +
        `⛽ BNB (gas): <b>${Number(bnb).toFixed(6)}</b>\n\n` +
        `👛 <code>${getWallet().address}</code>`
      );

    // ─────────────────────────────────────────
    } else if (cmd === '/pending' || cmd === '/معلق') {
      await sendTelegram(chatId, '⏳ جاري جلب السحوبات المعلقة...');
      const pending = await getPendingWithdrawals();
      if (pending.length === 0) {
        await sendTelegram(chatId, '✅ لا توجد سحوبات معلقة حالياً.');
        return;
      }
      let msg = `📋 <b>السحوبات المعلقة (${pending.length})</b>\n\n`;
      for (const p of pending.slice(0, 10)) { // أول 10 فقط لتجنب الرسالة الطويلة
        msg += `👤 ${p.groupId || 'N/A'} | 💎 ${Number(p.amount).toLocaleString('en-US')} SHIB\n`;
        msg += `👛 <code>${p.walletAddress}</code>\n`;
        msg += `🆔 <code>${p.withdrawalId}</code>\n\n`;
      }
      if (pending.length > 10) msg += `... و ${pending.length - 10} سحب آخر.`;
      await sendTelegram(chatId, msg);

    // ─────────────────────────────────────────
    } else if (cmd === '/setmax' || cmd === '/حدأقصى') {
      const newMax = Number(args[0]);
      if (!newMax || newMax <= 0) {
        await sendTelegram(chatId, '❌ استخدام صحيح: /setmax &lt;المبلغ&gt;\nمثال: /setmax 500000');
        return;
      }
      const oldMax = config.maxWithdrawalAmount;
      config.maxWithdrawalAmount = newMax;
      await sendTelegram(chatId,
        `✅ <b>تم تغيير الحد الأقصى للسحب</b>\n\n` +
        `القديم: ${oldMax.toLocaleString('en-US')} SHIB\n` +
        `الجديد: ${newMax.toLocaleString('en-US')} SHIB`
      );

    // ─────────────────────────────────────────
    } else if (cmd === '/pause' || cmd === '/إيقاف') {
      if (isPaused) {
        await sendTelegram(chatId, '⚠️ السحب التلقائي متوقف بالفعل.');
        return;
      }
      isPaused = true;
      await sendTelegram(chatId, '⏸ <b>تم إيقاف السحب التلقائي مؤقتاً.</b>\nلاستئنافه أرسل /resume');

    // ─────────────────────────────────────────
    } else if (cmd === '/resume' || cmd === '/استئناف') {
      if (!isPaused) {
        await sendTelegram(chatId, '⚠️ السحب التلقائي يعمل بالفعل.');
        return;
      }
      isPaused = false;
      await sendTelegram(chatId, '▶️ <b>تم استئناف السحب التلقائي.</b>');

    // ─────────────────────────────────────────
    } else if (cmd === '/stats' || cmd === '/إحصائيات') {
      await sendTelegram(chatId, '⏳ جاري الحساب...');
      const snapshot = await db().ref('withdrawals').once('value');
      const all = snapshot.val() || {};
      let total = 0, completed = 0, failed = 0, pending = 0, processing = 0;
      let totalShibSent = 0;

      for (const key of Object.keys(all)) {
        const node = all[key] || {};
        if (typeof node.status === 'string') {
          total++;
          if (node.status === 'completed') { completed++; totalShibSent += Number(node.amount) || 0; }
          else if (node.status === 'failed') failed++;
          else if (node.status === 'pending') pending++;
          else if (node.status === 'processing') processing++;
        } else {
          for (const wid of Object.keys(node)) {
            const item = node[wid];
            if (!item || !item.status) continue;
            total++;
            if (item.status === 'completed') { completed++; totalShibSent += Number(item.amount) || 0; }
            else if (item.status === 'failed') failed++;
            else if (item.status === 'pending') pending++;
            else if (item.status === 'processing') processing++;
          }
        }
      }

      await sendTelegram(chatId,
        `📊 <b>إحصائيات السحوبات</b>\n\n` +
        `📦 الإجمالي: <b>${total}</b>\n` +
        `✅ مكتمل: <b>${completed}</b>\n` +
        `⏳ معلق: <b>${pending}</b>\n` +
        `⚙️ قيد المعالجة: <b>${processing}</b>\n` +
        `❌ فاشل: <b>${failed}</b>\n\n` +
        `💎 إجمالي SHIB المُرسل: <b>${totalShibSent.toLocaleString('en-US')}</b>\n\n` +
        `🤖 حالة البوت: ${isPaused ? '⏸ متوقف' : '▶️ يعمل'}\n` +
        `🔒 الحد الأقصى: ${config.maxWithdrawalAmount.toLocaleString('en-US')} SHIB`
      );

    // ─────────────────────────────────────────
    } else if (cmd === '/run' || cmd === '/تشغيل') {
      if (isRunning) {
        await sendTelegram(chatId, '⚠️ دورة معالجة جارية بالفعل.');
        return;
      }
      await sendTelegram(chatId, '▶️ تشغيل دورة معالجة يدوية...');
      processPendingWithdrawals().then(async () => {
        await sendTelegram(chatId, '✅ انتهت دورة المعالجة اليدوية.');
      });

    // ─────────────────────────────────────────
    } else if (cmd === '/help' || cmd === '/مساعدة') {
      await sendTelegram(chatId,
        `🤖 <b>لوحة تحكم SHIB Auto Payout</b>\n\n` +
        `<b>💼 المحفظة:</b>\n` +
        `/balance - عرض رصيد SHIB و BNB\n\n` +
        `<b>📋 السحوبات:</b>\n` +
        `/pending - السحوبات المعلقة\n` +
        `/stats - إحصائيات كاملة\n` +
        `/run - تشغيل دورة معالجة يدوية\n\n` +
        `<b>⚙️ الإعدادات:</b>\n` +
        `/setmax &lt;مبلغ&gt; - تغيير الحد الأقصى\n\n` +
        `<b>🔄 التحكم:</b>\n` +
        `/pause - إيقاف السحب التلقائي\n` +
        `/resume - استئناف السحب التلقائي\n\n` +
        `<b>الحالة:</b> ${isPaused ? '⏸ متوقف' : '▶️ يعمل'} | DRY_RUN: ${config.dryRun ? '✅' : '❌'}`
      );

    // ─────────────────────────────────────────
    } else {
      await sendTelegram(chatId, `❓ أمر غير معروف: <code>${cmd}</code>\nأرسل /help لقائمة الأوامر.`);
    }

  } catch (err) {
    logger.error('[Admin Command] خطأ:', err.message);
    await sendTelegram(chatId, `❌ خطأ في تنفيذ الأمر:\n<code>${err.message}</code>`);
  }
}

/**
 * حلقة polling لاستقبال أوامر الأدمن
 */
async function pollTelegramCommands() {
  try {
    const data = await fetchTelegramUpdates();
    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (!msg.text.startsWith('/')) continue;

      const chatId = msg.chat.id;

      // مستخدم عادي (غير أدمن) بيبعت أي أمر -> رسالة ترحيب منظمة بدل رسالة "غير مصرح"
      if (!config.telegramAdminIds.includes(String(chatId))) {
        logger.info(`[Telegram] أمر من مستخدم عادي ${chatId}: ${msg.text}`);
        await sendWelcomeMessage(chatId);
        continue;
      }

      logger.info(`[Telegram] أمر من ${chatId}: ${msg.text}`);
      await handleAdminCommand(chatId, msg.text);
    }
  } catch (err) {
    logger.error('[Telegram Polling] خطأ:', err.message);
  }
}

// ============================================================
// 8) Health Server + Main
// ============================================================

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', dryRun: config.dryRun, paused: isPaused }));
  });
  server.listen(config.port, () => logger.info(`Health server on port ${config.port}`));
}

async function main() {
  logger.info(`بدء تشغيل shib-auto-payout. DRY_RUN=${config.dryRun}`);
  if (config.dryRun) logger.warn('وضع DRY_RUN - لن يتم إرسال SHIB فعلي. حط DRY_RUN=false لتفعيل الإرسال.');

  startHealthServer();

  try {
    const nativeBalance = await getNativeBalance();
    const shibBalance   = await getShibBalance();
    logger.info(`رصيد المحفظة: ${shibBalance} SHIB | ${nativeBalance} ${config.nativeTokenSymbol}`);
  } catch (err) {
    logger.error('فشل قراءة رصيد المحفظة:', err.message);
  }

  // إرسال رسالة بدء تشغيل للأدمن
  for (const adminId of config.telegramAdminIds) await sendTelegram(adminId,
    `🚀 <b>تم تشغيل SHIB Auto Payout Bot</b>\n\n` +
    `🔒 DRY_RUN: ${config.dryRun ? 'مفعّل (لا إرسال فعلي)' : '❌ معطّل (إرسال حقيقي)'}\n` +
    `⏱ الجدول: ${config.pollCron}\n` +
    `🔝 الحد الأقصى: ${config.maxWithdrawalAmount.toLocaleString('en-US')} SHIB\n\n` +
    `أرسل /help لقائمة أوامر لوحة التحكم.`
  );

  await processPendingWithdrawals();
  cron.schedule(config.pollCron, processPendingWithdrawals);
  logger.info(`تمت الجدولة على: ${config.pollCron}`);

  // polling أوامر الأدمن كل 3 ثواني
  setInterval(pollTelegramCommands, 3000);
  logger.info('Telegram admin polling started (every 3s).');
}

main().catch((err) => {
  logger.error('فشل تشغيل الأداة:', err.message || err);
  process.exit(1);
});
