// ==================== TeliTask Pro Configuration ====================
// সকল ভেরিয়েবল এই ফাইল থেকে কন্ট্রোল করুন

module.exports = {

  // ---- Telegram Bot Token ----
  BOT_TOKEN: 'YOUR_BOT_TOKEN_HERE',

  // ---- Admin Telegram IDs (হার্ডকোডেড, শুধুমাত্র এই ID গুলো এডমিন প্যানেল দেখতে পারবে) ----
  ADMIN_IDS: [123456789, 987654321],

  // ---- MongoDB Connection URI ----
  MONGODB_URI: 'mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/TeliTaskPro?retryWrites=true&w=majority',

  // ---- Task Group ID (স্ক্রিনশট ফরওয়ার্ড হবে এই গ্রুপে) ----
  TASK_GROUP_ID: -1001234567890,

  // ---- Summary Group ID (সামারি মেসেজ এই গ্রুপে থাকবে) ----
  SUMMARY_GROUP_ID: -1001234567890,

  // ---- ডিফল্ট টাস্ক রিওয়ার্ড (USD) ----
  DEFAULT_TASK_REWARD: 5,

  // ---- সর্বনিম্ন উত্তোলনের পরিমাণ (USD) ----
  WITHDRAW_MIN: 10,

  // ---- উত্তোলনের মাধ্যম ----
  WITHDRAW_METHODS: ['bKash', 'Nagad'],

  // ---- VPN মনিটরিং এনাবল/ডিসেবল ----
  VPN_CHECK_ENABLED: false,

  // ---- ডুপ্লিকেট অ্যাকাউন্ট প্রটেকশন এনাবল/ডিসেবল ----
  DUPLICATE_CHECK_ENABLED: true,

  // ---- ডেইলি টাস্ক রিসেট আওয়ার (UTC, 0 = মধ্যরাত) ----
  DAILY_RESET_HOUR: 0,

  // ---- বট ডিসপ্লে নাম ----
  BOT_NAME: 'TeliTask Pro',

  // ---- ওয়েলকাম মেসেজ ----
  WELCOME_MESSAGE: '👋 স্বাগতম, Hi!TeliTask Pro-তে আপনাকে স্বাগতম। টাস্ক করুন, পয়েন্ট অর্জন করুন এবং সহজেই টাকা উত্তোলন করুন!\n\nনিচের বাটনে ক্লিক করে অ্যাপটি খুলুন 👇',

  // ---- প্রতি পেজে কতগুলো আইটেম দেখাবে ----
  ITEMS_PER_PAGE: 5,

  // ---- টাস্ক সাবমিশনের সময় লিমিট ডিফল্ট (মিনিট) ----
  DEFAULT_TIME_LIMIT: 30,

  // ---- ডেইলি টাস্ক লিমিট ডিফল্ট ----
  DEFAULT_DAILY_LIMIT: 100,
};
