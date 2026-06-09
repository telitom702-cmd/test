// ==================== TeliTask Pro - Main Bot File ====================

const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const config = require('./config');

// ---- ১. বট ইনিশিয়ালাইজ ----
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// ---- ২. লগ হেল্পার ----
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ---- ৩. ইন-মেমোরি স্টেট ----
// ইউজার কনভার্সেশন স্টেট
const userStates = new Map();
// টাস্ক শুরুর সময় ট্র্যাকিং
const taskStartTimes = new Map();
// সামারি মেসেজ ID
let summaryMessageId = null;

// ==================== Database Connection ====================
mongoose.connect(config.MONGODB_URI)
  .then(() => log('✅ MongoDB সফলভাবে কানেক্ট হয়েছে'))
  .catch(err => { log('❌ MongoDB কানেকশন ব্যর্থ: ' + err.message); process.exit(1); });

// ==================== Mongoose Models ====================

// ---- User Model ----
const UserSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true, index: true },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  username: { type: String, default: '' },
  balance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
  vpnDetected: { type: Boolean, default: false },
  ipAddress: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
});
const User = mongoose.model('User', UserSchema);

// ---- Task Model ----
const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  link: { type: String, default: '' },
  reward: { type: Number, default: config.DEFAULT_TASK_REWARD },
  timeLimitMinutes: { type: Number, default: config.DEFAULT_TIME_LIMIT },
  dailyLimit: { type: Number, default: config.DEFAULT_DAILY_LIMIT },
  perUserLimit: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true },
  todaySubmissions: { type: Number, default: 0 },
  lastResetDate: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});
const Task = mongoose.model('Task', TaskSchema);

// ---- TaskSubmission Model ----
const SubmissionSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  taskTitle: { type: String, required: true },
  userName: { type: String, default: '' },
  userUsername: { type: String, default: '' },
  screenshotFileId: { type: String, required: true },
  screenshotGroupMsgId: { type: Number, default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  startedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: Number, default: null },
  date: { type: String, default: () => new Date().toISOString().split('T')[0] },
});
const Submission = mongoose.model('Submission', SubmissionSchema);

// ---- Withdraw Model ----
const WithdrawSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  userName: { type: String, default: '' },
  userUsername: { type: String, default: '' },
  method: { type: String, enum: ['bKash', 'Nagad'], required: true },
  accountNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: Number, default: null },
});
const Withdraw = mongoose.model('Withdraw', WithdrawSchema);

// ---- Notification Model ----
const NotificationSchema = new mongoose.Schema({
  type: { type: String, enum: ['global', 'personal'], required: true },
  targetUserId: { type: Number, default: null },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  sentTo: [{ type: Number }],
});
const Notification = mongoose.model('Notification', NotificationSchema);

// ---- Settings Model ----
const SettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
});
const Settings = mongoose.model('Settings', SettingsSchema);

// ==================== Helper Functions ====================

// আজকের তারিখ YYYY-MM-DD
const getToday = () => new Date().toISOString().split('T')[0];

// এডমিন কিনা চেক
const isAdmin = (id) => config.ADMIN_IDS.includes(id);

// ইউজার অটো-লগইন বা তৈরি
async function getOrCreateUser(msg) {
  const { id, first_name, last_name, username } = msg.from;
  let user = await User.findOne({ telegramId: id });
  if (!user) {
    // ডুপ্লিকেট চেক (IP ভিত্তিক - যদি IP থাকে)
    user = new User({
      telegramId: id,
      firstName: first_name || '',
      lastName: last_name || '',
      username: username || '',
    });
    await user.save();
    log(`নতুন ইউজার রেজিস্টার: ${id} (${first_name})`);
    // নতুন ইউজার হলে সামারি আপডেট
    updateSummary();
  } else {
    user.lastActive = new Date();
    await user.save();
  }
  return user;
}

// টাস্কের ডেইলি কাউন্টার রিসেট চেক
async function checkDailyReset(task) {
  const today = getToday();
  if (task.lastResetDate !== today) {
    task.todaySubmissions = 0;
    task.lastResetDate = today;
    await task.save();
  }
  return task;
}

// সেটিংস পড়া
async function getSetting(key, defaultValue = null) {
  const s = await Settings.findOne({ key });
  return s ? s.value : defaultValue;
}

// সেটিংস সেভ
async function setSetting(key, value) {
  await Settings.findOneAndUpdate({ key }, { value }, { upsert: true });
}

// ইনলাইন কীবোর্ড হেল্পার
function makeKeyboard(buttons) {
  // buttons: [[{text, callback_data}], ...]
  return { reply_markup: { inline_keyboard: buttons } };
}

// ==================== ৪. Start Command & Star Handler ====================

bot.onText(/\/start/, async (msg) => {
  try {
    const user = await getOrCreateUser(msg);

    // ব্যান চেক
    if (user.isBanned) {
      return bot.sendMessage(msg.chat.id, '🚫 আপনার অ্যাকাউন্ট ব্যান করা হয়েছে। এডমিনের সাথে যোগাযোগ করুন।');
    }

    // ভেরিফিকেশন চেক
    if (!user.isVerified) {
      return bot.sendMessage(msg.chat.id,
        '🔒 নিরাপত্তা যাচাই\n\nআপনার অ্যাকাউন্ট ভেরিফাই করতে নিচের বাটনে ক্লিক করুন:',
        makeKeyboard([[{ text: '✅ ভেরিফাই করুন', callback_data: 'verify_me' }]])
      );
    }

    // ভিপিএন ডিটেকশন সতর্কতা
    if (user.vpnDetected) {
      await bot.sendMessage(msg.chat.id, '⚠️ আপনার অ্যাকাউন্টে VPN/Proxy ব্যবহারের সন্দেহ পাওয়া গেছে। এডমিন আপনার অ্যাকাউন্ট রিভিউ করতে পারে।');
    }

    // মেইন মেনু
    const mainMenu = makeKeyboard([
      [{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }],
      [{ text: '👤 আমার প্রোফাইল', callback_data: 'menu_profile' }],
      [{ text: '💰 ওয়ালেট', callback_data: 'menu_wallet' }],
      [{ text: '📊 আমার সাবমিশন', callback_data: 'menu_submissions' }],
      [{ text: '🔔 নোটিফিকেশন', callback_data: 'menu_notifications' }],
      ...(isAdmin(user.telegramId) ? [[{ text: '👨‍💼 এডমিন প্যানেল', callback_data: 'admin_menu' }]] : []),
    ]);

    bot.sendMessage(msg.chat.id, config.WELCOME_MESSAGE, mainMenu);
  } catch (err) {
    log('Start error: ' + err.message);
  }
});

// ---- স্টার হ্যান্ডলার ----
bot.on('message', async (msg) => {
  try {
    // টেলিগ্রাম স্টার ট্রানজ্যাকশন চেক
    if (msg.transaction && msg.transaction.total_amount > 0) {
      const user = await getOrCreateUser(msg);
      if (user.isBanned) return;

      if (!user.isVerified) {
        return bot.sendMessage(msg.chat.id,
          '🔒 আপনার অ্যাকাউন্ট ভেরিফাই করুন।',
          makeKeyboard([[{ text: '✅ ভেরিফাই করুন', callback_data: 'verify_me' }]])
        );
      }

      const mainMenu = makeKeyboard([
        [{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }],
        [{ text: '👤 আমার প্রোফাইল', callback_data: 'menu_profile' }],
        [{ text: '💰 ওয়ালেট', callback_data: 'menu_wallet' }],
        [{ text: '📊 আমার সাবমিশন', callback_data: 'menu_submissions' }],
      ]);

      bot.sendMessage(msg.chat.id,
        `⭐ ধন্যবাদ! আপনি ${msg.transaction.total_amount} স্টার পাঠিয়েছেন!\n\n${config.WELCOME_MESSAGE}`,
        mainMenu
      );
      return;
    }

    // successful_payment হ্যান্ডল (পুরনো ভার্সন)
    if (msg.successful_payment) {
      const user = await getOrCreateUser(msg);
      if (user.isBanned || !user.isVerified) return;

      const mainMenu = makeKeyboard([
        [{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }],
        [{ text: '👤 আমার প্রোফাইল', callback_data: 'menu_profile' }],
        [{ text: '💰 ওয়ালেট', callback_data: 'menu_wallet' }],
      ]);

      bot.sendMessage(msg.chat.id,
        `⭐ পেমেন্ট সফল! ${msg.successful_payment.total_amount / 100} ${msg.successful_payment.currency}\n\n${config.WELCOME_MESSAGE}`,
        mainMenu
      );
      return;
    }

    // ---- ফটো মেসেজ (স্ক্রিনশট আপলোড) ----
    if (msg.photo && msg.chat.type === 'private') {
      await handleScreenshotUpload(msg);
      return;
    }

    // ---- টেক্সট মেসেজ (কনভার্সেশন স্টেট হ্যান্ডলিং) ----
    if (msg.text && msg.chat.type === 'private') {
      await handleTextMessage(msg);
    }
  } catch (err) {
    log('Message handler error: ' + err.message);
  }
});

// ==================== ৫. Screenshot Upload Handler ====================

async function handleScreenshotUpload(msg) {
  const userId = msg.from.id;
  const state = userStates.get(userId);

  // স্টেট চেক - শুধুমাত্র টাস্ক আপলোড স্টেটে ফটো গ্রহণ
  if (!state || !state.step.startsWith('upload_screenshot_')) {
    return; // রিলেভ্যান্ট স্টেট না থাকলে ইগনোর
  }

  const taskId = state.step.replace('upload_screenshot_', '');
  const user = await User.findOne({ telegramId: userId });
  if (!user || user.isBanned || !user.isVerified) return;

  try {
    const task = await Task.findById(taskId);
    if (!task || !task.isActive) {
      userStates.delete(userId);
      return bot.sendMessage(msg.chat.id, '❌ এই টাস্কটি আর সক্রিয় নেই।');
    }

    // টাইম লিমিট চেক
    const startKey = `${userId}_${taskId}`;
    const startTime = taskStartTimes.get(startKey);
    if (startTime) {
      const elapsed = (Date.now() - startTime) / 60000;
      if (elapsed > task.timeLimitMinutes) {
        taskStartTimes.delete(startKey);
        userStates.delete(userId);
        return bot.sendMessage(msg.chat.id,
          `⏰ সময় শেষ! আপনার ${elapsed.toFixed(1)} মিনিট লেগেছে, কিন্তু লিমিট ছিল ${task.timeLimitMinutes} মিনিট।`
        );
      }
    }

    // ডেইলি লিমিট চেক
    await checkDailyReset(task);
    if (task.todaySubmissions >= task.dailyLimit) {
      userStates.delete(userId);
      return bot.sendMessage(msg.chat.id, '❌ আজকের টাস্কের ডেইলি লিমিট শেষ হয়েছে।');
    }

    // পার ইউজার লিমিট চেক (One Limit Task)
    const today = getToday();
    const existingSubmission = await Submission.findOne({
      userId, taskId, date: today,
      status: { $in: ['pending', 'approved'] }
    });
    if (existingSubmission) {
      userStates.delete(userId);
      return bot.sendMessage(msg.chat.id, '❌ আপনি আজ এই টাস্কটি ইতিমধ্যে সাবমিট করেছেন। (One Limit Task)');
    }

    // সবচেয়ে বড় ফটো নেওয়া
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    // সাবমিশন তৈরি
    const submission = new Submission({
      userId,
      taskId,
      taskTitle: task.title,
      userName: user.firstName,
      userUsername: user.username || '',
      screenshotFileId: fileId,
      status: 'pending',
      startedAt: startTime ? new Date(startTime) : null,
      date: today,
    });
    await submission.save();

    // টাস্কের ডেইলি কাউন্টার বাড়ানো
    task.todaySubmissions += 1;
    await task.save();

    // ক্লিনআপ
    taskStartTimes.delete(startKey);
    userStates.delete(userId);

    // গ্রুপে ফরওয়ার্ড (sendPhoto দিয়ে বাটন সহ)
    const groupMsg = await bot.sendPhoto(config.TASK_GROUP_ID, fileId,
      `📸 **Task Submission**\n━━━━━━━━━━━━━━━━━━\n📋 Task: ${task.title}\n👤 User: ${user.firstName} ${user.lastName || ''}(@${user.username || 'N/A'})\n🆔 ID: \`${userId}\`\n💰 Reward: $${task.reward}\n⏰ Time: ${new Date().toLocaleString('bn-BD')}\n━━━━━━━━━━━━━━━━━━`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Activate', callback_data: `group_approve_${submission._id}` },
              { text: '❌ Reject', callback_data: `group_reject_${submission._id}` },
            ]
          ]
        }
      }
    );

    // গ্রুপ মেসেজ ID সেভ
    submission.screenshotGroupMsgId = groupMsg.message_id;
    await submission.save();

    // ইউজারকে কনফার্মেশন
    bot.sendMessage(msg.chat.id,
      '✅ আপনার স্ক্রিনশট সফলভাবে জমা হয়েছে!\n\nএডমিন রিভিউ করে Activate বা Reject করবে। ফলাফল আপনাকে নোটিফাই করা হবে।',
      makeKeyboard([
        [{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }],
        [{ text: '📊 আমার সাবমিশন', callback_data: 'menu_submissions' }],
      ])
    );

    // সামারি আপডেট
    updateSummary();

  } catch (err) {
    log('Screenshot upload error: ' + err.message);
    bot.sendMessage(msg.chat.id, '❌ স্ক্রিনশট আপলোডে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
    userStates.delete(userId);
  }
}

// ==================== ৬. Text Message Handler (Conversation States) ====================

async function handleTextMessage(msg) {
  const userId = msg.from.id;
  const text = msg.text.trim();
  const state = userStates.get(userId);

  if (!state) return; // কোনো অ্যাক্টিভ স্টেট না থাকলে ইগনোর

  const user = await User.findOne({ telegramId: userId });
  if (!user || user.isBanned) { userStates.delete(userId); return; }

  try {
    switch (state.step) {

      // ---- এডমিন: টাস্ক তৈরি ফ্লো ----
      case 'task_title':
        state.data.title = text;
        state.step = 'task_desc';
        userStates.set(userId, state);
        bot.sendMessage(userId, '📝 এখন টাস্কের Description লিখুন:');
        break;

      case 'task_desc':
        state.data.description = text;
        state.step = 'task_link';
        userStates.set(userId, state);
        bot.sendMessage(userId, '🔗 এখন টাস্কের Link দিন:');
        break;

      case 'task_link':
        state.data.link = text;
        state.step = 'task_reward';
        userStates.set(userId, state);
        bot.sendMessage(userId, `💰 রিওয়ার্ড পরিমাণ লিখুন (USD, ডিফল্ট: ${config.DEFAULT_TASK_REWARD}):`);
        break;

      case 'task_reward': {
        const reward = parseFloat(text) || config.DEFAULT_TASK_REWARD;
        state.data.reward = reward;
        state.step = 'task_time';
        userStates.set(userId, state);
        bot.sendMessage(userId, `⏰ টাইম লিমিট লিখুন (মিনিট, ডিফল্ট: ${config.DEFAULT_TIME_LIMIT}):`);
        break;
      }

      case 'task_time': {
        const time = parseInt(text) || config.DEFAULT_TIME_LIMIT;
        state.data.timeLimitMinutes = time;
        state.step = 'task_daily_limit';
        userStates.set(userId, state);
        bot.sendMessage(userId, `📊 ডেইলি লিমিট লিখুন (ডিফল্ট: ${config.DEFAULT_DAILY_LIMIT}):`);
        break;
      }

      case 'task_daily_limit': {
        const dailyLimit = parseInt(text) || config.DEFAULT_DAILY_LIMIT;
        // টাস্ক তৈরি
        const task = new Task({
          title: state.data.title,
          description: state.data.description,
          link: state.data.link,
          reward: state.data.reward,
          timeLimitMinutes: state.data.timeLimitMinutes,
          dailyLimit,
          perUserLimit: 1,
          lastResetDate: getToday(),
        });
        await task.save();
        userStates.delete(userId);
        bot.sendMessage(userId,
          `✅ টাস্ক সফলভাবে তৈরি হয়েছে!\n\n📋 ${task.title}\n💰 $${task.reward}\n⏰ ${task.timeLimitMinutes} মিনিট\n📊 ডেইলি লিমিট: ${dailyLimit}`,
          makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]])
        );
        break;
      }

      // ---- উত্তোলন: একাউন্ট নম্বর ----
      case 'withdraw_number':
        if (!/^[\d+\-\s]{7,20}$/.test(text)) {
          return bot.sendMessage(userId, '❌ সঠিক নম্বর দিন (যেমন: 01712345678):');
        }
        state.data.accountNumber = text.replace(/\s/g, '');
        state.step = 'withdraw_amount';
        userStates.set(userId, state);
        bot.sendMessage(userId, `💰 উত্তোলনের পরিমাণ লিখুন (সর্বনিম্ন $${config.WITHDRAW_MIN}, আপনার ব্যালেন্স: $${user.balance}):`);
        break;

      // ---- উত্তোলন: পরিমাণ ----
      case 'withdraw_amount': {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount < config.WITHDRAW_MIN) {
          return bot.sendMessage(userId, `❌ সর্বনিম্ন $${config.WITHDRAW_MIN} উত্তোলন করতে পারবেন।`);
        }
        if (amount > user.balance) {
          return bot.sendMessage(userId, `❌ আপনার ব্যালেন্সে পর্যাপ্ত পরিমাণ নেই। বর্তমান ব্যালেন্স: $${user.balance}`);
        }
        state.data.amount = amount;
        state.step = 'withdraw_confirm';
        userStates.set(userId, state);
        bot.sendMessage(userId,
          `📋 **Withdraw Confirmation**\n━━━━━━━━━━━━━━━━━━\n📱 Method: ${state.data.method}\n🔢 Number: ${state.data.accountNumber}\n💰 Amount: $${amount}\n━━━━━━━━━━━━━━━━━━\n\nকনফার্ম করতে নিচের বাটনে ক্লিক করুন:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ কনফার্ম', callback_data: `withdraw_confirm_${amount}_${state.data.method}` }],
                [{ text: '❌ বাতিল', callback_data: 'menu_wallet' }],
              ]
            }
          }
        );
        break;
      }

      // ---- এডমিন: Ban User ID ----
      case 'admin_ban_id': {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
          return bot.sendMessage(userId, '❌ সঠিক Telegram ID দিন (শুধুমাত্র সংখ্যা):');
        }
        if (config.ADMIN_IDS.includes(targetId)) {
          return bot.sendMessage(userId, '❌ এডমিনকে ব্যান করা যাবে না!');
        }
        const targetUser = await User.findOneAndUpdate({ telegramId: targetId }, { isBanned: true });
        userStates.delete(userId);
        if (targetUser) {
          bot.sendMessage(userId, `🔒 ইউজার ${targetId} (${targetUser.firstName}) সফলভাবে ব্যান করা হয়েছে।`,
            makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
          // ইউজারকে নোটিফাই
          try {
            await bot.sendMessage(targetId, '🚫 আপনার অ্যাকাউন্ট এডমিন কর্তৃক ব্যান করা হয়েছে।');
          } catch (e) { /* ইউজার বট ব্লক করলে এরর ইগনোর */ }
        } else {
          bot.sendMessage(userId, '❌ এই ID এর কোনো ইউজার পাওয়া যায়নি।',
            makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
        }
        break;
      }

      // ---- এডমিন: Unban User ID ----
      case 'admin_unban_id': {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
          return bot.sendMessage(userId, '❌ সঠিক Telegram ID দিন:');
        }
        const targetUser = await User.findOneAndUpdate({ telegramId: targetId }, { isBanned: false });
        userStates.delete(userId);
        if (targetUser) {
          bot.sendMessage(userId, `🔓 ইউজার ${targetId} (${targetUser.firstName}) সফলভাবে আনব্যান করা হয়েছে।`,
            makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
        } else {
          bot.sendMessage(userId, '❌ এই ID এর কোনো ইউজার পাওয়া যায়নি।',
            makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
        }
        break;
      }

      // ---- এডমিন: Balance Control - User ID ----
      case 'admin_balance_id': {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
          return bot.sendMessage(userId, '❌ সঠিক Telegram ID দিন:');
        }
        const targetUser = await User.findOne({ telegramId: targetId });
        if (!targetUser) {
          return bot.sendMessage(userId, '❌ এই ID এর কোনো ইউজার পাওয়া যায়নি:');
        }
        state.data.targetId = targetId;
        state.data.targetUser = targetUser;
        state.step = 'admin_balance_type';
        userStates.set(userId, state);
        bot.sendMessage(userId,
          `👤 ইউজার: ${targetUser.firstName} (ID: ${targetId})\n💰 বর্তমান ব্যালেন্স: $${targetUser.balance}\n\nযেটা করতে চান সিলেক্ট করুন:`,
          makeKeyboard([
            [{ text: '➕ ব্যালেন্স যোগ করুন', callback_data: 'admin_bal_add' }],
            [{ text: '➖ ব্যালেন্স কমান', callback_data: 'admin_bal_sub' }],
            [{ text: '❌ বাতিল', callback_data: 'admin_menu' }],
          ])
        );
        break;
      }

      // ---- এডমিন: Balance Amount ----
      case 'admin_balance_amount': {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          return bot.sendMessage(userId, '❌ সঠিক পরিমাণ দিন (শুধুমাত্র সংখ্যা):');
        }
        const { targetId, targetUser, balanceType } = state.data;
        if (balanceType === 'add') {
          targetUser.balance += amount;
          targetUser.totalEarned += amount;
        } else {
          targetUser.balance = Math.max(0, targetUser.balance - amount);
        }
        await targetUser.save();
        userStates.delete(userId);
        bot.sendMessage(userId,
          `✅ ব্যালেন্স আপডেট সফল!\n\n👤 ইউজার: ${targetUser.firstName} (ID: ${targetId})\n🔄 অপারেশন: ${balanceType === 'add' ? 'যোগ' : 'বিয়োগ'}\n💰 পরিমাণ: $${amount}\n💵 নতুন ব্যালেন্স: $${targetUser.balance}`,
          makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]])
        );
        break;
      }

      // ---- এডমিন: Personal Notification - User ID ----
      case 'admin_notif_id': {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
          return bot.sendMessage(userId, '❌ সঠিক Telegram ID দিন:');
        }
        const targetUser = await User.findOne({ telegramId: targetId });
        if (!targetUser) {
          return bot.sendMessage(userId, '❌ এই ID এর কোনো ইউজার পাওয়া যায়নি:');
        }
        state.data.targetId = targetId;
        state.data.targetName = targetUser.firstName;
        state.step = 'admin_notif_msg';
        userStates.set(userId, state);
        bot.sendMessage(userId, `📧 ${targetUser.firstName} (ID: ${targetId}) কে নোটিফিকেশন পাঠানো হবে।\n\nএখন মেসেজ লিখুন:`);
        break;
      }

      // ---- এডমিন: Notification Message ----
      case 'admin_notif_msg': {
        const { notifType, targetId, targetName } = state.data;
        if (notifType === 'global') {
          // গ্লোবাল নোটিফিকেশন সেভ ও ব্রডকাস্ট
          const notif = new Notification({ type: 'global', message: text, sentTo: [] });
          await notif.save();
          const allUsers = await User.find({ isBanned: false, isVerified: true });
          let sentCount = 0;
          for (const u of allUsers) {
            try {
              await bot.sendMessage(u.telegramId, `🔔 **Global Notification**\n\n${text}`, { parse_mode: 'Markdown' });
              notif.sentTo.push(u.telegramId);
              sentCount++;
            } catch (e) { /* ইগনোর */ }
          }
          await notif.save();
          userStates.delete(userId);
          bot.sendMessage(userId, `✅ গ্লোবাল নোটিফিকেশন ${sentCount}/${allUsers.length} জনকে পাঠানো হয়েছে।`,
            makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
        } else {
          // পার্সোনাল নোটিফিকেশন
          const notif = new Notification({ type: 'personal', targetUserId: targetId, message: text, sentTo: [targetId] });
          await notif.save();
          try {
            await bot.sendMessage(targetId, `🔔 **Notification**\n\n${text}`, { parse_mode: 'Markdown' });
            userStates.delete(userId);
            bot.sendMessage(userId, `✅ ${targetName} (ID: ${targetId}) কে নোটিফিকেশন পাঠানো হয়েছে।`,
              makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
          } catch (e) {
            userStates.delete(userId);
            bot.sendMessage(userId, `❌ ${targetName} কে মেসেজ পাঠানো যায়নি (সম্ভবত বট ব্লক করেছে)।`,
              makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]]));
          }
        }
        break;
      }

      default:
        userStates.delete(userId);
        break;
    }
  } catch (err) {
    log('Text state handler error: ' + err.message);
    userStates.delete(userId);
    bot.sendMessage(userId, '❌ একটি ত্রুটি হয়েছে। আবার চেষ্টা করুন।');
  }
}

// ==================== ৭. Callback Query Handler ====================

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  const msg = query.message;

  try {
    // অটো লগইন
    const user = await getOrCreateUser(query);

    // ব্যান চেক
    if (user.isBanned) {
      await bot.answerCallbackQuery(query.id, { show_alert: true, text: '🚫 আপনার অ্যাকাউন্ট ব্যান করা হয়েছে।' });
      return;
    }

    // ---- ভেরিফিকেশন ----
    if (data === 'verify_me') {
      user.isVerified = true;
      await user.save();
      await bot.answerCallbackQuery(query.id, { text: '✅ ভেরিফিকেশন সফল!' });
      return bot.sendMessage(userId, config.WELCOME_MESSAGE,
        makeKeyboard([
          [{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }],
          [{ text: '👤 আমার প্রোফাইল', callback_data: 'menu_profile' }],
          [{ text: '💰 ওয়ালেট', callback_data: 'menu_wallet' }],
        ])
      );
    }

    // ---- মেইন মেনু নেভিগেশন ----
    if (data === 'menu_tasks') return showTaskList(userId, 0);
    if (data === 'menu_profile') return showProfile(userId, user);
    if (data === 'menu_wallet') return showWallet(userId, user);
    if (data === 'menu_submissions') return showSubmissions(userId, 0);
    if (data === 'menu_notifications') return showNotifications(userId);

    // ---- টাস্ক পেজিনেশন ----
    if (data.startsWith('tasks_page_')) {
      const page = parseInt(data.split('_')[2]);
      return showTaskList(userId, page);
    }

    // ---- টাস্ক ভিউ ----
    if (data.startsWith('view_task_')) {
      const taskId = data.replace('view_task_', '');
      return showTaskDetails(userId, taskId, user);
    }

    // ---- টাস্ক শুরু ----
    if (data.startsWith('start_task_')) {
      const taskId = data.replace('start_task_', '');
      return startTask(userId, taskId, user);
    }

    // ---- স্ক্রিনশট আপলোড শুরু ----
    if (data.startsWith('upload_task_')) {
      const taskId = data.replace('upload_task_', '');
      userStates.set(userId, { step: `upload_screenshot_${taskId}`, data: {} });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '📸 এখন আপনার স্ক্রিনশট পাঠান (শুধুমাত্র ছবি):\n\n⚠️ টাইম লিমিট চলছে!');
    }

    // ---- সাবমিশন পেজিনেশন ----
    if (data.startsWith('subs_page_')) {
      const page = parseInt(data.split('_')[2]);
      return showSubmissions(userId, page);
    }

    // ---- উত্তোলন মেথড সিলেক্ট ----
    if (data.startsWith('withdraw_method_')) {
      const method = data.replace('withdraw_method_', '');
      userStates.set(userId, { step: 'withdraw_number', data: { method } });
      await bot.answerCallbackQuery(query.id);
      const label = method === 'bKash' ? 'bKash' : 'Nagad';
      return bot.sendMessage(userId, `📱 ${label} নম্বর দিন (যেমন: 01712345678):`);
    }

    // ---- উত্তোলন কনফার্ম ----
    if (data.startsWith('withdraw_confirm_')) {
      const parts = data.replace('withdraw_confirm_', '').split('_');
      const amount = parseFloat(parts[0]);
      const method = parts[1];
      const state = userStates.get(userId);
      if (!state || !state.data.accountNumber) {
        await bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ প্রক্রিয়া রিসেট হয়েছে, আবার চেষ্টা করুন।' });
        return;
      }

      // ব্যালেন্স আবার চেক (পুনরায় যাচাই)
      const freshUser = await User.findOne({ telegramId: userId });
      if (amount > freshUser.balance) {
        userStates.delete(userId);
        await bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ পর্যাপ্ত ব্যালেন্স নেই!' });
        return showWallet(userId, freshUser);
      }

      // উত্তোলন তৈরি
      const withdraw = new Withdraw({
        userId,
        userName: user.firstName,
        userUsername: user.username || '',
        method,
        accountNumber: state.data.accountNumber,
        amount,
      });
      await withdraw.save();

      // ব্যালেন্স কমানো (pending অবস্থায়ই কাটা হবে)
      freshUser.balance -= amount;
      await freshUser.save();

      userStates.delete(userId);
      await bot.answerCallbackQuery(query.id, { text: '✅ উত্তোলনের আবেদন জমা হয়েছে!' });

      bot.sendMessage(userId,
        `✅ **Withdraw Request Submitted**\n━━━━━━━━━━━━━━━━━━\n📱 Method: ${method}\n🔢 Number: ${state.data.accountNumber}\n💰 Amount: $${amount}\n📅 Status: Pending\n━━━━━━━━━━━━━━━━━━\n\nএডমিন রিভিউ করে Activate বা Reject করবে।`,
        { parse_mode: 'Markdown' }
      );
      updateSummary();
      return;
    }

    // ==================== গ্রুপ হ্যান্ডলার (Activate/Reject) ====================
    if (data.startsWith('group_approve_')) {
      const subId = data.replace('group_approve_', '');
      return handleGroupAction(subId, 'approved', userId, query, msg);
    }
    if (data.startsWith('group_reject_')) {
      const subId = data.replace('group_reject_', '');
      return handleGroupAction(subId, 'rejected', userId, query, msg);
    }

    // ==================== এডমিন প্যানেল ====================
    if (!isAdmin(userId)) {
      await bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ অনুমতি নেই!' });
      return;
    }

    // এডমিন মেইন মেনু
    if (data === 'admin_menu') return showAdminMenu(userId);
    if (data === 'admin_users') return showAdminUserMenu(userId);
    if (data === 'admin_tasks') return showAdminTaskMenu(userId);
    if (data === 'admin_withdraws') return showAdminWithdrawList(userId, 0);
    if (data === 'admin_notifs') return showAdminNotifMenu(userId);
    if (data === 'admin_stats') return showAdminStats(userId);

    // এডমিন: ইউজার ম্যানেজমেন্ট
    if (data === 'admin_ban') {
      userStates.set(userId, { step: 'admin_ban_id', data: {} });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '🔒 Ban করার জন্য Telegram ID দিন:');
    }
    if (data === 'admin_unban') {
      userStates.set(userId, { step: 'admin_unban_id', data: {} });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '🔓 Unban করার জন্য Telegram ID দিন:');
    }
    if (data === 'admin_balance') {
      userStates.set(userId, { step: 'admin_balance_id', data: {} });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '💰 ব্যালেন্স পরিবর্তনের জন্য Telegram ID দিন:');
    }
    if (data === 'admin_bal_add') {
      const state = userStates.get(userId);
      if (state && state.data.targetId) {
        state.step = 'admin_balance_amount';
        state.data.balanceType = 'add';
        userStates.set(userId, state);
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, '➕ যোগ করার পরিমাণ লিখুন (USD):');
      }
    }
    if (data === 'admin_bal_sub') {
      const state = userStates.get(userId);
      if (state && state.data.targetId) {
        state.step = 'admin_balance_amount';
        state.data.balanceType = 'sub';
        userStates.set(userId, state);
        await bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, '➖ কমানোর পরিমাণ লিখুন (USD):');
      }
    }

    // এডমিন: টাস্ক ম্যানেজমেন্ট
    if (data === 'admin_create_task') {
      userStates.set(userId, { step: 'task_title', data: {} });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '📝 নতুন টাস্কের Title লিখুন:');
    }
    if (data === 'admin_list_tasks') return showAdminTaskList(userId, 0);
    if (data.startsWith('admin_tasks_page_')) {
      const page = parseInt(data.split('_')[3]);
      return showAdminTaskList(userId, page);
    }
    if (data.startsWith('delete_task_')) {
      const taskId = data.replace('delete_task_', '');
      const task = await Task.findByIdAndDelete(taskId);
      await bot.answerCallbackQuery(query.id, { text: task ? '🗑️ টাস্ক ডিলিট হয়েছে!' : '❌ টাস্ক পাওয়া যায়নি!' });
      if (task) return showAdminTaskList(userId, 0);
    }
    if (data.startsWith('toggle_task_')) {
      const taskId = data.replace('toggle_task_', '');
      const task = await Task.findById(taskId);
      if (task) {
        task.isActive = !task.isActive;
        await task.save();
        await bot.answerCallbackQuery(query.id, { text: task.isActive ? '✅ টাস্ক সক্রিয় করা হয়েছে!' : '⏸️ টাস্ক নিষ্ক্রিয় করা হয়েছে!' });
        return showAdminTaskList(userId, 0);
      }
    }

    // এডমিন: উত্তোলন ম্যানেজমেন্ট
    if (data.startsWith('admin_wd_page_')) {
      const page = parseInt(data.split('_')[3]);
      return showAdminWithdrawList(userId, page);
    }
    if (data.startsWith('approve_wd_')) {
      const wdId = data.replace('approve_wd_', '');
      return handleWithdrawAction(wdId, 'approved', userId, query);
    }
    if (data.startsWith('reject_wd_')) {
      const wdId = data.replace('reject_wd_', '');
      return handleWithdrawAction(wdId, 'rejected', userId, query);
    }

    // এডমিন: নোটিফিকেশন
    if (data === 'admin_global_notif') {
      userStates.set(userId, { step: 'admin_notif_msg', data: { notifType: 'global' } });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '🌍 গ্লোবাল নোটিফিকেশনের মেসেজ লিখুন:\n\n(সকল ভেরিফাইড ইউজারকে পাঠানো হবে)');
    }
    if (data === 'admin_personal_notif') {
      userStates.set(userId, { step: 'admin_notif_id', data: { notifType: 'personal' } });
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(userId, '👤 পার্সোনাল নোটিফিকেশন পাঠানোর জন্য Telegram ID দিন:');
    }

    // ---- অচেনো কলব্যাক ----
    await bot.answerCallbackQuery(query.id);

  } catch (err) {
    log('Callback error: ' + err.message + ' | Data: ' + data);
    try { await bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ একটি ত্রুটি হয়েছে।' }); } catch (e) {}
  }
});

// ==================== ৮. Task List Display ====================

async function showTaskList(userId, page) {
  const tasks = await Task.find({ isActive: true }).sort({ createdAt: -1 });
  const perPage = config.ITEMS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(tasks.length / perPage));
  const pageTasks = tasks.slice(page * perPage, (page + 1) * perPage);

  if (pageTasks.length === 0) {
    return bot.sendMessage(userId, '📋 বর্তমানে কোনো সক্রিয় টাস্ক নেই।',
      makeKeyboard([[{ text: '🔙 মেইন মেনু', callback_data: 'menu_tasks' }]])
    );
  }

  let text = '📋 **Available Tasks**\n━━━━━━━━━━━━━━━━━━\n\n';
  const buttons = [];

  for (const task of pageTasks) {
    await checkDailyReset(task);
    const remaining = Math.max(0, task.dailyLimit - task.todaySubmissions);
    text += `📌 ${task.title}\n💰 $${task.reward} | ⏰ ${task.timeLimitMinutes}min | 📊 বাকি: ${remaining}\n\n`;
    buttons.push([{ text: `📌 ${task.title} ($${task.reward})`, callback_data: `view_task_${task._id}` }]);
  }

  text += `━━━━━━━━━━━━━━━━━━\n📄 Page ${page + 1}/${totalPages} | মোট: ${tasks.length}`;

  // পেজিনেশন বাটন
  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ আগে', callback_data: `tasks_page_${page - 1}` });
  if (page < totalPages - 1) navButtons.push({ text: 'পরে ⬅️', callback_data: `tasks_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([{ text: '🔙 মেইন মেনু', callback_data: 'start' }]);

  bot.sendMessage(userId, text, { parse_mode: 'Markdown', ...makeKeyboard(buttons) });
}

// ==================== ৯. Task Details ====================

async function showTaskDetails(userId, taskId, user) {
  const task = await Task.findById(taskId);
  if (!task || !task.isActive) {
    return bot.sendMessage(userId, '❌ এই টাস্কটি পাওয়া যায়নি বা নিষ্ক্রিয় করা হয়েছে।',
      makeKeyboard([[{ text: '📋 টাস্ক সমূহ', callback_data: 'menu_tasks' }]])
    );
  }

  await checkDailyReset(task);
  const remaining = Math.max(0, task.dailyLimit - task.todaySubmissions);

  // ইউজারের আজকের সাবমিশন চেক
  const today = getToday();
  const userSubmission = await Submission.findOne({
    userId, taskId, date: today,
    status: { $in: ['pending', 'approved'] }
  });

  const alreadyDone = !!userSubmission;
  const startKey = `${userId}_${taskId}`;
  const hasStarted = taskStartTimes.has(startKey);

  let statusText = '';
  if (alreadyDone) {
    statusText = userSubmission.status === 'pending' ? '⏳ রিভিউ অপেক্ষমান' : '✅ সম্পন্ন';
  } else if (hasStarted) {
    const elapsed = ((Date.now() - taskStartTimes.get(startKey)) / 60000).toFixed(1);
    statusText = `⏱️ চলমান (${elapsed}/${task.timeLimitMinutes} min)`;
  } else {
    statusText = '🆕 শুরু করুন';
  }

  const buttons = [];
  if (!alreadyDone) {
    if (!hasStarted) {
      buttons.push([{ text: '🚀 টাস্ক শুরু করুন', callback_data: `start_task_${taskId}` }]);
    } else {
      buttons.push([{ text: '📸 স্ক্রিনশট আপলোড করুন', callback_data: `upload_task_${taskId}` }]);
    }
  }

  // লিংক কপি বাটন
  if (task.link) {
    buttons.push([{ text: '📋 লিংক কপি করুন', copy_text: task.link }]);
  }

  buttons.push([{ text: '🔙 টাস্ক লিস্টে ফিরুন', callback_data: 'menu_tasks' }]);

  bot.sendMessage(userId,
    `📌 **${task.title}**\n━━━━━━━━━━━━━━━━━━\n📝 ${task.description || 'কোনো বিবরণ নেই'}\n\n💰 Reward: $${task.reward}\n⏰ Time Limit: ${task.timeLimitMinutes} মিনিট\n📊 ডেইলি লিমিট বাকি: ${remaining}\n🔄 আপনার স্ট্যাটাস: ${statusText}\n━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'Markdown', ...makeKeyboard(buttons) }
  );
}

// ==================== ১০. Start Task ====================

async function startTask(userId, taskId, user) {
  const task = await Task.findById(taskId);
  if (!task || !task.isActive) {
    return bot.sendMessage(userId, '❌ টাস্ক পাওয়া যায়নি।');
  }

  await checkDailyReset(task);
  if (task.todaySubmissions >= task.dailyLimit) {
    return bot.sendMessage(userId, '❌ আজকের ডেইলি লিমিট শেষ হয়েছে।');
  }

  const today = getToday();
  const existing = await Submission.findOne({
    userId, taskId, date: today,
    status: { $in: ['pending', 'approved'] }
  });
  if (existing) {
    return bot.sendMessage(userId, '❌ আপনি আজ এই টাস্কটি ইতিমধ্যে সাবমিট করেছেন।');
  }

  // টাইমার শুরু
  const startKey = `${userId}_${taskId}`;
  taskStartTimes.set(startKey, Date.now());

  bot.sendMessage(userId,
    `🚀 **টাস্ক শুরু হয়েছে!**\n━━━━━━━━━━━━━━━━━━\n📌 ${task.title}\n⏰ আপনার ${task.timeLimitMinutes} মিনিট আছে\n\n১. নিচের লিংকে যান\n২. কাজ সম্পন্ন করুন\n৩. স্ক্রিনশট নিন\n৪. "স্ক্রিনশট আপলোড" বাটনে ক্লিক করে ছবি পাঠান\n━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '📋 লিংক কপি করুন', copy_text: task.link }],
        [{ text: '📸 স্ক্রিনশট আপলোড করুন', callback_data: `upload_task_${taskId}` }],
        [{ text: '🔙 টাস্ক লিস্ট', callback_data: 'menu_tasks' }],
      ])
    }
  );
}

// ==================== ১১. Group Action (Activate/Reject) ====================

async function handleGroupAction(subId, action, adminId, query, msg) {
  // শুধুমাত্র এডমিন একশন নিতে পারবে
  if (!isAdmin(adminId)) {
    return bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ শুধুমাত্র এডমিন একশন নিতে পারবেন!' });
  }

  const submission = await Submission.findById(subId);
  if (!submission) {
    return bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ সাবমিশন পাওয়া যায়নি!' });
  }

  if (submission.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { show_alert: true, text: `এই সাবমিশন ইতিমধ্যে ${submission.status === 'approved' ? 'Activate' : 'Reject'} হয়েছে!` });
  }

  submission.status = action;
  submission.reviewedAt = new Date();
  submission.reviewedBy = adminId;
  await submission.save();

  // গ্রুপ মেসেজ আপডেট
  try {
    const statusEmoji = action === 'approved' ? '✅ ACTIVATED' : '❌ REJECTED';
    const statusText = action === 'approved'
      ? `✅ **ACTIVATED** by Admin\n💰 Reward: $${(await Task.findById(submission.taskId))?.reward || 'N/A'} credited`
      : `❌ **REJECTED** by Admin\nReason: স্ক্রিনশট গ্রহণযোগ্য নয়`;

    await bot.editMessageCaption(
      `📸 **Task Submission**\n━━━━━━━━━━━━━━━━━━\n📋 Task: ${submission.taskTitle}\n👤 User: ${submission.userName}(@${submission.userUsername || 'N/A'})\n🆔 ID: \`${submission.userId}\`\n⏰ Submitted: ${submission.submittedAt.toLocaleString('bn-BD')}\n━━━━━━━━━━━━━━━━━━\n${statusText}`,
      {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
      }
    );
    // ইনলাইন কীবোর্ড সরানো (reply_markup খালি)
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id });
  } catch (e) {
    log('Group message edit error: ' + e.message);
  }

  // ইউজারকে নোটিফাই
  if (action === 'approved') {
    const task = await Task.findById(submission.taskId);
    const reward = task ? task.reward : 0;
    const userDoc = await User.findOne({ telegramId: submission.userId });
    if (userDoc) {
      userDoc.balance += reward;
      userDoc.totalEarned += reward;
      await userDoc.save();
    }
    try {
      await bot.sendMessage(submission.userId,
        `🎉 **টাস্ক Activate হয়েছে!**\n━━━━━━━━━━━━━━━━━━\n📌 ${submission.taskTitle}\n💰 $${reward} আপনার ব্যালেন্সে যোগ হয়েছে\n💵 বর্তমান ব্যালেন্স: $${userDoc ? userDoc.balance : 0}\n━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { /* ইগনোর */ }
  } else {
    try {
      await bot.sendMessage(submission.userId,
        `❌ **টাস্ক Reject হয়েছে**\n━━━━━━━━━━━━━━━━━━\n📌 ${submission.taskTitle}\nকারণ: আপনার স্ক্রিনশট গ্রহণযোগ্য ছিল না। আবার চেষ্টা করুন।\n━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { /* ইগনোর */ }
  }

  await bot.answerCallbackQuery(query.id, {
    text: action === 'approved' ? '✅ Activate সফল!' : '❌ Reject সফল!'
  });

  // সামারি আপডেট
  updateSummary();
}

// ==================== ১২. Withdraw Action ====================

async function handleWithdrawAction(wdId, action, adminId, query) {
  const withdraw = await Withdraw.findById(wdId);
  if (!withdraw) {
    return bot.answerCallbackQuery(query.id, { show_alert: true, text: '❌ উত্তোলন রিকোয়েস্ট পাওয়া যায়নি!' });
  }

  if (withdraw.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { show_alert: true, text: 'এটি ইতিমধ্যে প্রসেস হয়েছে!' });
  }

  withdraw.status = action;
  withdraw.reviewedAt = new Date();
  withdraw.reviewedBy = adminId;

  if (action === 'rejected') {
    // রিজেক্ট হলে ব্যালেন্স ফেরত
    const userDoc = await User.findOne({ telegramId: withdraw.userId });
    if (userDoc) {
      userDoc.balance += withdraw.amount;
      await userDoc.save();
    }
  } else {
    // এপ্রুভ হলে totalWithdrawn বাড়ানো
    const userDoc = await User.findOne({ telegramId: withdraw.userId });
    if (userDoc) {
      userDoc.totalWithdrawn += withdraw.amount;
      await userDoc.save();
    }
  }

  await withdraw.save();

  // ইউজারকে নোটিফাই
  try {
    if (action === 'approved') {
      await bot.sendMessage(withdraw.userId,
        `✅ **Withdraw Activate হয়েছে!**\n━━━━━━━━━━━━━━━━━━\n📱 Method: ${withdraw.method}\n🔢 Number: ${withdraw.accountNumber}\n💰 Amount: $${withdraw.amount}\n📅 Status: Approved\n━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(withdraw.userId,
        `❌ **Withdraw Reject হয়েছে**\n━━━━━━━━━━━━━━━━━━\n📱 Method: ${withdraw.method}\n🔢 Number: ${withdraw.accountNumber}\n💰 Amount: $${withdraw.amount}\nকারণ: তথ্য সঠিক নয় বা অন্য কারণে।\n💡 $${withdraw.amount} আপনার ব্যালেন্সে ফেরত দেওয়া হয়েছে।\n━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (e) { /* ইগনোর */ }

  await bot.answerCallbackQuery(query.id, {
    text: action === 'approved' ? '✅ Withdraw Activate!' : '❌ Withdraw Reject!'
  });

  showAdminWithdrawList(adminId, 0);
  updateSummary();
}

// ==================== ১৩. Profile ====================

async function showProfile(userId, user) {
  const totalTasks = await Submission.countDocuments({ userId, status: 'approved' });
  const pendingTasks = await Submission.countDocuments({ userId, status: 'pending' });
  const totalWithdraws = await Withdraw.countDocuments({ userId, status: 'approved' });

  bot.sendMessage(userId,
    `👤 **আমার প্রোফাইল**\n━━━━━━━━━━━━━━━━━━\n🆔 ID: \`${userId}\`\n📛 নাম: ${user.firstName} ${user.lastName || ''}\n📝 Username: @${user.username || 'N/A'}\n📅 রেজিস্ট্রেশন: ${user.createdAt.toLocaleDateString('bn-BD')}\n━━━━━━━━━━━━━━━━━━\n💰 ব্যালেন্স: $${user.balance.toFixed(2)}\n📈 মোট আয়: $${user.totalEarned.toFixed(2)}\n💸 মোট উত্তোলন: $${user.totalWithdrawn.toFixed(2)}\n━━━━━━━━━━━━━━━━━━\n✅ সম্পন্ন টাস্ক: ${totalTasks}\n⏳ পেন্ডিং: ${pendingTasks}\n📤 উত্তোলন: ${totalWithdraws}\n━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '💰 ওয়ালেট', callback_data: 'menu_wallet' }],
        [{ text: '📊 আমার সাবমিশন', callback_data: 'menu_submissions' }],
        [{ text: '🔙 মেইন মেনু', callback_data: 'start' }],
      ])
    }
  );
}

// ==================== ১৪. Wallet ====================

async function showWallet(userId, user) {
  const methodButtons = config.WITHDRAW_METHODS.map(m => ({
    text: `📱 ${m}`,
    callback_data: `withdraw_method_${m.toLowerCase()}`
  }));

  bot.sendMessage(userId,
    `💰 **ওয়ালেট**\n━━━━━━━━━━━━━━━━━━\n💵 বর্তমান ব্যালেন্স: **$${user.balance.toFixed(2)}**\n📈 মোট আয়: $${user.totalEarned.toFixed(2)}\n💸 মোট উত্তোলন: $${user.totalWithdrawn.toFixed(2)}\n━━━━━━━━━━━━━━━━━━\nসর্বনিম্ন উত্তোলন: $${config.WITHDRAW_MIN}`,
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        methodButtons,
        [{ text: '📊 আমার সাবমিশন', callback_data: 'menu_submissions' }],
        [{ text: '🔙 মেইন মেনু', callback_data: 'start' }],
      ])
    }
  );
}

// ==================== ১৫. Submissions List ====================

async function showSubmissions(userId, page) {
  const subs = await Submission.find({ userId }).sort({ submittedAt: -1 });
  const perPage = config.ITEMS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(subs.length / perPage));
  const pageSubs = subs.slice(page * perPage, (page + 1) * perPage);

  if (pageSubs.length === 0) {
    return bot.sendMessage(userId, '📊 আপনার কোনো সাবমিশন নেই।',
      makeKeyboard([[{ text: '🔙 মেইন মেনু', callback_data: 'start' }]])
    );
  }

  let text = '📊 **আমার সাবমিশন**\n━━━━━━━━━━━━━━━━━━\n\n';
  for (const sub of pageSubs) {
    const statusEmoji = sub.status === 'approved' ? '✅' : sub.status === 'rejected' ? '❌' : '⏳';
    text += `${statusEmoji} ${sub.taskTitle}\n📅 ${sub.submittedAt.toLocaleDateString('bn-BD')} | তারিখ: ${sub.date}\n\n`;
  }
  text += `━━━━━━━━━━━━━━━━━━\n📄 Page ${page + 1}/${totalPages}`;

  const buttons = [];
  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ আগে', callback_data: `subs_page_${page - 1}` });
  if (page < totalPages - 1) navButtons.push({ text: 'পরে ⬅️', callback_data: `subs_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([{ text: '🔙 মেইন মেনু', callback_data: 'start' }]);

  bot.sendMessage(userId, text, { parse_mode: 'Markdown', ...makeKeyboard(buttons) });
}

// ==================== ১৬. Notifications ====================

async function showNotifications(userId) {
  // গ্লোবাল নোটিফিকেশন (সাম্প্রতিক 5টি)
  const globalNotifs = await Notification.find({ type: 'global' }).sort({ createdAt: -1 }).limit(5);
  // পার্সোনাল নোটিফিকেশন
  const personalNotifs = await Notification.find({ type: 'personal', targetUserId: userId }).sort({ createdAt: -1 }).limit(5);

  let text = '🔔 **নোটিফিকেশন**\n━━━━━━━━━━━━━━━━━━\n\n';

  if (personalNotifs.length > 0) {
    text += '👤 **পার্সোনাল:**\n';
    for (const n of personalNotifs) {
      text += `• ${n.message}\n  📅 ${n.createdAt.toLocaleDateString('bn-BD')}\n\n`;
    }
  }

  if (globalNotifs.length > 0) {
    text += '🌍 **গ্লোবাল:**\n';
    for (const n of globalNotifs) {
      text += `• ${n.message}\n  📅 ${n.createdAt.toLocaleDateString('bn-BD')}\n\n`;
    }
  }

  if (personalNotifs.length === 0 && globalNotifs.length === 0) {
    text += 'কোনো নোটিফিকেশন নেই।\n';
  }

  bot.sendMessage(userId, text, {
    parse_mode: 'Markdown',
    ...makeKeyboard([[{ text: '🔙 মেইন মেনু', callback_data: 'start' }]])
  });
}

// ==================== ১৭. Admin Panel ====================

function showAdminMenu(userId) {
  bot.sendMessage(userId,
    '👨‍💼 **TeliTask Pro - Admin Panel**\n━━━━━━━━━━━━━━━━━━',
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '👥 ইউজার ম্যানেজমেন্ট', callback_data: 'admin_users' }],
        [{ text: '📋 টাস্ক ম্যানেজমেন্ট', callback_data: 'admin_tasks' }],
        [{ text: '💰 উত্তোলন ম্যানেজমেন্ট', callback_data: 'admin_withdraws' }],
        [{ text: '🔔 নোটিফিকেশন', callback_data: 'admin_notifs' }],
        [{ text: '📊 পরিসংখ্যান', callback_data: 'admin_stats' }],
        [{ text: '🔙 মেইন মেনু', callback_data: 'start' }],
      ])
    }
  );
}

function showAdminUserMenu(userId) {
  bot.sendMessage(userId, '👥 **ইউজার ম্যানেজমেন্ট**',
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '🔒 Ban User (ID দিন)', callback_data: 'admin_ban' }],
        [{ text: '🔓 Unban User (ID দিন)', callback_data: 'admin_unban' }],
        [{ text: '💰 ব্যালেন্স পরিবর্তন (ID দিন)', callback_data: 'admin_balance' }],
        [{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }],
      ])
    }
  );
}

function showAdminTaskMenu(userId) {
  bot.sendMessage(userId, '📋 **টাস্ক ম্যানেজমেন্ট**',
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '➕ নতুন টাস্ক তৈরি', callback_data: 'admin_create_task' }],
        [{ text: '📋 টাস্ক লিস্ট ও ডিলিট', callback_data: 'admin_list_tasks' }],
        [{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }],
      ])
    }
  );
}

async function showAdminTaskList(userId, page) {
  const tasks = await Task.find().sort({ createdAt: -1 });
  const perPage = config.ITEMS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(tasks.length / perPage));
  const pageTasks = tasks.slice(page * perPage, (page + 1) * perPage);

  if (pageTasks.length === 0) {
    return bot.sendMessage(userId, 'কোনো টাস্ক নেই।',
      makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]])
    );
  }

  let text = '📋 **টাস্ক লিস্ট**\n━━━━━━━━━━━━━━━━━━\n\n';
  const buttons = [];

  for (const task of pageTasks) {
    const statusEmoji = task.isActive ? '🟢' : '🔴';
    text += `${statusEmoji} ${task.title} | $${task.reward} | লিমিট: ${task.dailyLimit}\n`;
    buttons.push([
      { text: `${task.isActive ? '⏸️ নিষ্ক্রিয়' : '✅ সক্রিয়'}`, callback_data: `toggle_task_${task._id}` },
      { text: '🗑️ ডিলিট', callback_data: `delete_task_${task._id}` },
    ]);
  }

  text += `\n━━━━━━━━━━━━━━━━━━\n📄 Page ${page + 1}/${totalPages}`;

  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ আগে', callback_data: `admin_tasks_page_${page - 1}` });
  if (page < totalPages - 1) navButtons.push({ text: 'পরে ⬅️', callback_data: `admin_tasks_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]);

  bot.sendMessage(userId, text, { parse_mode: 'Markdown', ...makeKeyboard(buttons) });
}

async function showAdminWithdrawList(userId, page) {
  const withdraws = await Withdraw.find().sort({ createdAt: -1 });
  const perPage = config.ITEMS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(withdraws.length / perPage));
  const pageWithdraws = withdraws.slice(page * perPage, (page + 1) * perPage);

  if (pageWithdraws.length === 0) {
    return bot.sendMessage(userId, 'কোনো উত্তোলনের আবেদন নেই।',
      makeKeyboard([[{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]])
    );
  }

  let text = '💰 **উত্তোলনের আবেদনসমূহ**\n━━━━━━━━━━━━━━━━━━\n\n';
  const buttons = [];

  for (const wd of pageWithdraws) {
    const statusEmoji = wd.status === 'approved' ? '✅' : wd.status === 'rejected' ? '❌' : '⏳';
    text += `${statusEmoji} ${wd.userName} | ${wd.method} | ${wd.accountNumber} | $${wd.amount}\n📅 ${wd.createdAt.toLocaleDateString('bn-BD')}\n\n`;

    if (wd.status === 'pending') {
      buttons.push([
        { text: `✅ Activate $${wd.amount}`, callback_data: `approve_wd_${wd._id}` },
        { text: `❌ Reject $${wd.amount}`, callback_data: `reject_wd_${wd._id}` },
      ]);
    }
  }

  text += `━━━━━━━━━━━━━━━━━━\n📄 Page ${page + 1}/${totalPages}`;

  const navButtons = [];
  if (page > 0) navButtons.push({ text: '⬅️ আগে', callback_data: `admin_wd_page_${page - 1}` });
  if (page < totalPages - 1) navButtons.push({ text: 'পরে ⬅️', callback_data: `admin_wd_page_${page + 1}` });
  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }]);

  bot.sendMessage(userId, text, { parse_mode: 'Markdown', ...makeKeyboard(buttons) });
}

function showAdminNotifMenu(userId) {
  bot.sendMessage(userId, '🔔 **নোটিফিকেশন পাঠান**',
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '🌍 গ্লোবাল নোটিফিকেশন', callback_data: 'admin_global_notif' }],
        [{ text: '👤 পার্সোনাল নোটিফিকেশন (ID দিন)', callback_data: 'admin_personal_notif' }],
        [{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }],
      ])
    }
  );
}

async function showAdminStats(userId) {
  const totalUsers = await User.countDocuments();
  const today = getToday();
  const todayUsers = await User.countDocuments({
    createdAt: { $gte: new Date(today) }
  });
  const completedTasks = await Submission.countDocuments({ status: 'approved' });
  const pendingTasks = await Submission.countDocuments({ status: 'pending' });
  const rejectedTasks = await Submission.countDocuments({ status: 'rejected' });
  const totalPayout = await Withdraw.aggregate([
    { $match: { status: 'approved' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  const pendingWithdraws = await Withdraw.countDocuments({ status: 'pending' });
  const bannedUsers = await User.countDocuments({ isBanned: true });
  const activeTasks = await Task.countDocuments({ isActive: true });

  const payoutAmount = totalPayout.length > 0 ? totalPayout[0].total : 0;

  bot.sendMessage(userId,
    `📊 **TeliTask Pro - পরিসংখ্যান**\n━━━━━━━━━━━━━━━━━━\n\n👥 **ইউজার:**\n  মোট: ${totalUsers}\n  আজকের নতুন: ${todayUsers}\n  ব্যান: ${bannedUsers}\n\n📋 **টাস্ক:**\n  সক্রিয়: ${activeTasks}\n  সম্পন্ন: ${completedTasks}\n  পেন্ডিং: ${pendingTasks}\n  রিজেক্ট: ${rejectedTasks}\n\n💰 **আর্থিক:**\n  মোট পেআউট: $${payoutAmount.toFixed(2)}\n  পেন্ডিং উত্তোলন: ${pendingWithdraws}\n━━━━━━━━━━━━━━━━━━\n⏰ ${new Date().toLocaleString('bn-BD')}`,
    {
      parse_mode: 'Markdown',
      ...makeKeyboard([
        [{ text: '🔄 রিফ্রেশ', callback_data: 'admin_stats' }],
        [{ text: '🔙 এডমিন মেনু', callback_data: 'admin_menu' }],
      ])
    }
  );
}

// ==================== ১৮. Group Summary Message System ====================
// গ্রুপে শুধুমাত্র ১টি মেসেজ থাকবে যা Auto Update/Edit হবে

async function updateSummary() {
  try {
    const totalUsers = await User.countDocuments();
    const today = getToday();
    const todayUsers = await User.countDocuments({
      createdAt: { $gte: new Date(today) }
    });
    const completedTasks = await Submission.countDocuments({ status: 'approved' });
    const totalPayout = await Withdraw.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const payoutAmount = totalPayout.length > 0 ? totalPayout[0].total : 0;
    const lastUpdate = new Date().toLocaleString('bn-BD');

    const summaryText =
      `📊 *TeliTask Pro - Live Summary*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total Users: *${totalUsers}*\n` +
      `🆕 Today's New Users: *${todayUsers}*\n` +
      `✅ Completed Tasks: *${completedTasks}*\n` +
      `💰 Total Payout: *$${payoutAmount.toFixed(2)}*\n` +
      `⏰ Last Update: *${lastUpdate}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🤖 ${config.BOT_NAME}`;

    if (summaryMessageId) {
      // বিদ্যমান মেসেজ এডিট করার চেষ্টা
      try {
        await bot.editMessageText(summaryText, {
          chat_id: config.SUMMARY_GROUP_ID,
          message_id: summaryMessageId,
          parse_mode: 'Markdown',
        });
        return;
      } catch (editErr) {
        // মেসেজ খুব পুরনো বা ডিলিট হয়ে থাকলে নতুন পাঠানো
        log('Summary edit failed, sending new: ' + editErr.message);
        summaryMessageId = null;
      }
    }

    // নতুন মেসেজ পাঠানো
    const sent = await bot.sendMessage(config.SUMMARY_GROUP_ID, summaryText, { parse_mode: 'Markdown' });
    summaryMessageId = sent.message_id;
    await setSetting('summaryMessageId', summaryMessageId);

  } catch (err) {
    log('Summary update error: ' + err.message);
  }
}

// বট শুরুতে সেভ করা summaryMessageId লোড করা
async function loadSummaryMessageId() {
  try {
    const savedId = await getSetting('summaryMessageId');
    if (savedId) {
      summaryMessageId = savedId;
      // মেসেজ এখনও আছে কিনা চেক
      try {
        await bot.editMessageText('🔄', {
          chat_id: config.SUMMARY_GROUP_ID,
          message_id: savedId,
        });
        // সাথে সাথে আসল সামারি দিয়ে আপডেট
        updateSummary();
      } catch (e) {
        summaryMessageId = null;
        updateSummary();
      }
    } else {
      updateSummary();
    }
  } catch (err) {
    log('Load summary ID error: ' + err.message);
    updateSummary();
  }
}

// ==================== ১৯. Security: Duplicate Account Protection ====================

// VPN/IP চেকের জন্য ওয়েব এন্ডপয়েন্ট সেটআপ করতে হবে
// এটি একটি বেসিক স্ট্রাকচার - প্রয়োজনে Express সার্ভার যুক্ত করুন
async function checkDuplicateAndVPN(user) {
  if (!config.DUPLICATE_CHECK_ENABLED && !config.VPN_CHECK_ENABLED) return;

  // IP ভিত্তিক চেক করতে হলে একটি ওয়েব ভেরিফিকেশন পেজ লাগবে
  // যেহেতু টেলিগ্রাম বট থেকে সরাসরি IP পাওয়া যায় না,
  // তাই এটি একটি প্লেসহোল্ডার - এডমিন ম্যানুয়ালি VPN ফ্ল্যাগ সেট করতে পারবেন

  if (config.DUPLICATE_CHECK_ENABLED && user.ipAddress) {
    const duplicates = await User.find({
      ipAddress: user.ipAddress,
      telegramId: { $ne: user.telegramId },
    });
    if (duplicates.length > 0) {
      log(`⚠️ ডুপ্লিকেট IP শনাক্ত: ${user.telegramId} ↔ ${duplicates.map(d => d.telegramId).join(', ')}`);
      // এডমিনকে নোটিফাই
      for (const adminId of config.ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId,
            `⚠️ **ডুপ্লিকেট অ্যাকাউন্ট সন্দেহ**\n\nনতুন: ${user.firstName} (ID: ${user.telegramId})\nIP: ${user.ipAddress}\nমিলে যাওয়া: ${duplicates.map(d => `${d.firstName} (${d.telegramId})`).join(', ')}`
          );
        } catch (e) {}
      }
    }
  }
}

// ==================== ২০. Bot Startup ====================

log(`🚀 ${config.BOT_NAME} শুরু হচ্ছে...`);
log(`👨‍💼 Admin IDs: ${config.ADMIN_IDS.join(', ')}`);
log(`📋 Task Group: ${config.TASK_GROUP_ID}`);
log(`📊 Summary Group: ${config.SUMMARY_GROUP_ID}`);

// ডাটাবেস কানেক্ট হলে সামারি লোড করা
setTimeout(() => {
  loadSummaryMessageId();
}, 3000);

// প্রতি ৫ মিনিটে সামারি অটো-রিফ্রেশ
setInterval(() => {
  updateSummary();
}, 5 * 60 * 1000);

// গ্রেসফুল শাটডাউন
process.on('SIGINT', async () => {
  log('🛑 বট বন্ধ হচ্ছে...');
  bot.stopPolling();
  await mongoose.connection.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('❌ Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', (err) => {
  log('❌ Unhandled Rejection: ' + err);
});

log('✅ বট সফলভাবে চালু হয়েছে!');
