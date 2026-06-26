# SHIB Auto Payout - نسخة ملف واحد (index.js)

كل منطق الأداة (Firebase + BNB Chain + الجدولة) في ملف `index.js` واحد، علشان النشر يكون أسهل.

## الملفات

- `index.js` - كل الكود
- `package.json` - التبعيات (ethers, firebase-admin, node-cron)

## النشر على Railway (الطريقة المباشرة)

1. ارفع المجلد ده (الملفين) على ريبو GitHub، أو استخدم `railway up` من جهازك مباشرة بدون GitHub لو حابب.
2. في Railway: **New Project > Deploy from GitHub repo** (أو من CLI).
3. روح على تبويب **Variables** في السيرفس بتاعك وضيف المتغيرات دي واحد واحد:

| اسم المتغير | القيمة |
|---|---|
| `FIREBASE_DATABASE_URL` | `https://pkdjpsd-default-rtdb.firebaseio.com` (رابطك) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | محتوى ملف service account كامل (JSON) في سطر واحد |
| `RPC_URL` | رابط RPC لشبكة BNB Smart Chain، مثلاً `https://bsc-dataseed.binance.org/` |
| `PRIVATE_KEY` | مفتاح محفظتك الخاص (بدون مسافات) |
| `SHIB_CONTRACT_ADDRESS` | `0x2859e4544C4bB03966803b044A93563Bd2D0DD4D` (افتراضي، سيبه كما هو) |
| `NATIVE_TOKEN_SYMBOL` | `BNB` |
| `POLL_CRON` | `* * * * *` (كل دقيقة) |
| `MAX_WITHDRAWAL_AMOUNT` | `100000000` (حد أقصى أمان لكل عملية سحب) |
| `CONFIRMATIONS` | `2` |
| `DRY_RUN` | `true` (سيبها true في أول تشغيل، وبعد التأكد حوّلها لـ `false`) |

4. Railway هيشغّل `npm start` تلقائيًا (موجودة في `package.json`).
5. تابع تبويب **Deployments > Logs** بعد ما تضغط Deploy.

## للحصول على FIREBASE_SERVICE_ACCOUNT_JSON

1. روح Firebase Console > ⚙️ Project Settings > Service Accounts
2. دوس "Generate new private key" → هينزل ملف JSON
3. افتح الملف، انسخ كل محتواه (سطر واحد بدون تنسيق)، وحطه كقيمة المتغير في Railway

## تنبيه أمان

- **متحطش `PRIVATE_KEY` في الكود أو في GitHub أبدًا** - فقط في Railway Variables.
- لو مش حاطط `.env` محليًا، الكود لازم يشتغل بمتغيرات بيئة حقيقية (export في التيرمينال أو من خلال Railway).
- خلي `DRY_RUN=true` في أول تشغيل وراجع الـ logs قبل ما تحط `DRY_RUN=false`.
