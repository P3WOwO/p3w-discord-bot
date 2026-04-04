const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes,
  ActivityType,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const fs = require('fs');
const http = require('http');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('Не хватает TOKEN, CLIENT_ID или GUILD_ID в переменных окружения.');
}

const DATA_DIR = '/data';
const VOICE_DATA_FILE = `${DATA_DIR}/voice_times.json`;
const LIFE_DATA_FILE = `${DATA_DIR}/life_state.json`;
const AI_MEMORY_FILE = `${DATA_DIR}/ai_memory.json`;

const CHECKPOINT_MS = 60 * 1000;
const PRESENCE_REFRESH_MS = 60 * 1000;
const PRESENCE_ROTATE_MS = 60 * 60 * 1000;
const TOP_LIMIT = 7;
const MAX_HISTORY = 12;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let voiceTimes = {};
let activeSessions = new Map();
let checkpointTimer = null;
let presenceRefreshTimer = null;
let presenceRotateTimer = null;

let lifeState = {
  startedAt: null,
  phrase: null,
};

let channelMemory = {};

const PRESENCE_VERBS = [
  'Компиляцию',
  'Сборку',
  'Обработку',
  'Дифракцию',
  'Извержение',
  'Почернение',
  'Проверку',
  'Перезагрузку',
  'Калибровку',
  'Мемификацию',
  'Рендеринг',
  'Оптимизацию',
  'Патчинг',
  'Загрузку',
  'Разборку',
  'Синхронизацию',
  'Фильтрацию',
  'Декодирование',
  'Свертку',
  'Печать',
  'Замес',
  'Шейдинг',
  'Лутинг',
  'Фарминг',
  'Переупаковку',
  'Тюнинг',
  'Бустинг',
  'Троттлинг',
  'Стабилизацию',
];

const PRESENCE_NOUNS = [
  'яиц',
  'костей',
  'коммунизма',
  'света',
  'вулкана',
  'мемов',
  'вайба',
  'кринжа',
  'пикселей',
  'нулей',
  'таблеток',
  'пельменей',
  'креветок',
  'табуреток',
  'пиццы',
  'ламп',
  'обоев',
  'ботинок',
  'пылесоса',
  'чайника',
  'дверей',
  'кошек',
  'кактусов',
  'диванов',
  'проводов',
  'носков',
  'тарелок',
  'клавиатур',
  'мониторов',
  'бананов',
  'швабр',
  'облаков',
  'скрепок',
  'проводков',
  'сосисок',
  'пауков',
  'мышек',
  'арбузов',
  'стульев',
  'пружин',
  'гигабайтов',
  'лагов',
  'фпсов',
  'битов',
  'нейронок',
  'Azi',
  'Никнэйма',
];

const SYSTEM_PROMPT = `
Ты Discord-бот.
Отвечай по-русски.
Учитывай последние сообщения в канале и кто их написал.
Не притворяйся человеком.
Если вопрос короткий — отвечай коротко.
`;

function getNextTargetDayUnix(dayOfMonth = 23) {
  const now = new Date();

  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  target.setDate(dayOfMonth);

  if (target <= now) {
    target.setMonth(target.getMonth() + 1);
    target.setDate(dayOfMonth);
    target.setHours(0, 0, 0, 0);
  }

  return Math.floor(target.getTime() / 1000);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadVoiceData() {
  ensureDataDir();

  if (!fs.existsSync(VOICE_DATA_FILE)) {
    voiceTimes = {};
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(VOICE_DATA_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.voiceTimes && typeof raw.voiceTimes === 'object') {
      voiceTimes = raw.voiceTimes;
    } else if (raw && typeof raw === 'object') {
      voiceTimes = raw;
    } else {
      voiceTimes = {};
    }
  } catch (error) {
    console.error('Не удалось прочитать voice_times.json, начинаю с пустой статистики:', error);
    voiceTimes = {};
  }
}

function saveVoiceData() {
  ensureDataDir();
  fs.writeFileSync(VOICE_DATA_FILE, JSON.stringify({ voiceTimes }, null, 2));
}

function loadLifeData() {
  ensureDataDir();

  if (!fs.existsSync(LIFE_DATA_FILE)) {
    lifeState = {
      startedAt: null,
      phrase: null,
    };
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(LIFE_DATA_FILE, 'utf8'));
    lifeState = {
      startedAt: typeof raw?.startedAt === 'number' ? raw.startedAt : null,
      phrase: typeof raw?.phrase === 'string' ? raw.phrase : null,
    };
  } catch (error) {
    console.error('Не удалось прочитать life_state.json, создаю новый:', error);
    lifeState = {
      startedAt: null,
      phrase: null,
    };
  }
}

function saveLifeData() {
  ensureDataDir();
  fs.writeFileSync(
    LIFE_DATA_FILE,
    JSON.stringify(
      {
        startedAt: lifeState.startedAt,
        phrase: lifeState.phrase,
      },
      null,
      2
    )
  );
}

function loadAIMemory() {
  ensureDataDir();

  if (!fs.existsSync(AI_MEMORY_FILE)) {
    channelMemory = {};
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, 'utf8'));
    channelMemory = raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    console.error('Не удалось прочитать ai_memory.json, начинаю с пустой памяти:', error);
    channelMemory = {};
  }
}

function saveAIMemory() {
  ensureDataDir();
  fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(channelMemory, null, 2));
}

function getKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function addTime(guildId, userId, seconds) {
  if (seconds <= 0) return;

  const key = getKey(guildId, userId);
  voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  saveVoiceData();
}

function getCurrentSessionSeconds(key) {
  const startedAt = activeSessions.get(key);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function getTotalSeconds(guildId, userId) {
  const key = getKey(guildId, userId);
  return (voiceTimes[key] || 0) + getCurrentSessionSeconds(key);
}

function formatTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (d) parts.push(`${d}д`);
  if (h || d) parts.push(`${h}ч`);
  if (m || h || d) parts.push(`${m}м`);
  parts.push(`${s}с`);

  return parts.join(' ');
}

function formatShortTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (d) parts.push(`${d}д`);
  if (h || d) parts.push(`${h}ч`);
  parts.push(`${m}м`);

  return parts.join(' ');
}

function formatTopTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);

  if (d > 0) return `${d}д ${h}ч`;
  return `${h}ч`;
}

function startSession(guildId, userId) {
  const key = getKey(guildId, userId);
  if (!activeSessions.has(key)) {
    activeSessions.set(key, Date.now());
  }
}

function endSession(guildId, userId) {
  const key = getKey(guildId, userId);
  const startedAt = activeSessions.get(key);
  if (!startedAt) return;

  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs > 0) addTime(guildId, userId, secs);

  activeSessions.delete(key);
}

function checkpointSessions(force = false) {
  const now = Date.now();
  let changed = false;

  for (const [key, startedAt] of activeSessions.entries()) {
    const elapsed = Math.floor((now - startedAt) / 1000);
    if (elapsed <= 0) continue;

    if (force || elapsed >= 60) {
      voiceTimes[key] = (voiceTimes[key] || 0) + elapsed;
      activeSessions.set(key, now);
      changed = true;
    }
  }

  if (changed) saveVoiceData();
}

async function restoreCurrentVoiceSessions() {
  const guild = client.guilds.cache.get(GUILD_ID) || (await client.guilds.fetch(GUILD_ID).catch(() => null));
  if (!guild) return;

  activeSessions.clear();

  for (const [userId, voiceState] of guild.voiceStates.cache) {
    if (!voiceState.channelId) continue;
    if (userId === client.user.id) continue;
    startSession(GUILD_ID, userId);
  }
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getRandomPresencePhrase() {
  const a = pickRandom(PRESENCE_VERBS);
  const b = pickRandom(PRESENCE_NOUNS);
  return `${a} ${b}`;
}

function ensureLifeState() {
  if (!lifeState.startedAt) {
    lifeState.startedAt = Date.now();
  }
  if (!lifeState.phrase) {
    lifeState.phrase = getRandomPresencePhrase();
  }
  saveLifeData();
}

function buildLifeSeconds() {
  if (!lifeState.startedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - lifeState.startedAt) / 1000));
}

function buildPresenceActivity() {
  ensureLifeState();
  const lifeSeconds = buildLifeSeconds();

  return {
    name: `Слушает ${lifeState.phrase} • ${formatShortTime(lifeSeconds)}`,
    type: ActivityType.Listening,
    timestamps: {
      start: lifeState.startedAt,
    },
  };
}

async function applyPresence() {
  if (!client.user) return;

  client.user.setPresence({
    status: 'dnd',
    activities: [buildPresenceActivity()],
  });
}

async function refreshPresence() {
  try {
    await applyPresence();
  } catch (error) {
    console.error('Ошибка обновления presence:', error);
  }
}

async function rotatePresencePhrase() {
  ensureLifeState();
  lifeState.phrase = getRandomPresencePhrase();
  saveLifeData();
  await refreshPresence();
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('time')
      .setDescription('Показать время, проведённое в голосовых каналах')
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('Пользователь (если не указать — покажет твоё время)')
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('top')
      .setDescription('Показать топ по времени в голосовых каналах')
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('Пользователь, которого тоже надо показать внизу, если он не в топе')
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('life')
      .setDescription('Показать, сколько живёт бот')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Проверить отклик бота')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('msg')
      .setDescription('Отправить сообщение от имени бота в выбранный канал')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Канал, куда отправить сообщение')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('Текст сообщения')
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Удалить последние N сообщений')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((option) =>
        option
          .setName('amount')
          .setDescription('Сколько удалить')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('jtm')
      .setDescription('Зайти в твой войс')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('ai')
      .setDescription('Спросить Gemini')
      .addStringOption((option) =>
        option
          .setName('prompt')
          .setDescription('Что спросить у бота')
          .setRequired(true)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: [],
  });
}

function getLeaderboard(guildId) {
  const totals = new Map();

  for (const [key, seconds] of Object.entries(voiceTimes)) {
    const [gId, userId] = key.split(':');
    if (gId !== guildId) continue;
    totals.set(userId, (totals.get(userId) || 0) + seconds);
  }

  for (const [key, startedAt] of activeSessions.entries()) {
    const [gId, userId] = key.split(':');
    if (gId !== guildId) continue;
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    totals.set(userId, (totals.get(userId) || 0) + elapsed);
  }

  return [...totals.entries()]
    .map(([userId, seconds]) => ({ userId, seconds }))
    .sort((a, b) => {
      if (b.seconds !== a.seconds) return b.seconds - a.seconds;
      return a.userId.localeCompare(b.userId);
    });
}

async function getMemberName(guild, userId) {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached.displayName || cached.user.username;

  const fetched = await guild.members.fetch(userId).catch(() => null);
  if (fetched) return fetched.displayName || fetched.user.username;

  const user = await client.users.fetch(userId).catch(() => null);
  return user?.username || userId;
}

async function buildTopEmbed(guild, targetUser) {
  const leaderboard = getLeaderboard(guild.id);
  const top = leaderboard.slice(0, TOP_LIMIT);

  const targetIndex = leaderboard.findIndex((entry) => entry.userId === targetUser.id);
  const targetRank = targetIndex >= 0 ? targetIndex + 1 : null;
  const targetTotal = getTotalSeconds(guild.id, targetUser.id);

  let description = '';

  if (leaderboard.length === 0) {
    description = 'Пока никто не провёл время в войсе.';
  } else {
    const rows = [];
    rows.push('```');
    rows.push(`#  Пользователь             Дни/часы`);
    rows.push('-----------------------------------------');

    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      const name = await getMemberName(guild, item.userId);
      const shortName = name.length > 26 ? name.slice(0, 25) + '…' : name;
      const rank = String(i + 1).padEnd(2, ' ');
      const time = formatTopTime(item.seconds);
      rows.push(`${rank} ${shortName.padEnd(28)} ${time}`);
    }

    rows.push('```');
    description = rows.join('\n');
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🏆 Топ по времени в войсе')
    .setDescription(description)
    .setFooter({ text: `Всего людей в таблице: ${leaderboard.length}` })
    .setTimestamp();

  if (targetRank !== null) {
    const targetName = await getMemberName(guild, targetUser.id);
    embed.addFields({
      name: 'Твоё место',
      value: `**#${targetRank}** — **${targetName}**\n**Время:** ${formatTopTime(targetTotal)}`,
      inline: false,
    });
  } else {
    embed.addFields({
      name: 'Твоё место',
      value: `Пока нет данных по **${targetUser.username}**`,
      inline: false,
    });
  }

  return embed;
}

function buildLifeEmbed() {
  ensureLifeState();
  const lifeSeconds = buildLifeSeconds();
  const targetUnix = getNextTargetDayUnix(23);

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('💚 /life')
    .setDescription(
      `**${formatTime(lifeSeconds)}**\n\n` +
      `Следующая дата: <t:${targetUnix}:R>`
    )
    .setTimestamp();
}

function getChannelHistory(channelId) {
  const history = channelMemory[channelId];
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY);
}

function pushMemory(channelId, role, name, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return;

  const history = getChannelHistory(channelId);
  history.push({
    role,
    name,
    text: cleanText,
  });

  channelMemory[channelId] = history.slice(-MAX_HISTORY);
  saveAIMemory();
}

function buildPrompt(channelId, currentUserName, currentText) {
  const history = getChannelHistory(channelId);

  const lines = [
    SYSTEM_PROMPT.trim(),
    '',
    'История диалога:',
    ...history.map((m) => `${m.name}: ${m.text}`),
    `${currentUserName}: ${currentText}`,
  ];

  return lines.join('\n');
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('Не хватает GEMINI_API_KEY в переменных окружения.');
  }

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim() || 'Пустой ответ.';
}

client.once('ready', async () => {
  console.log(`✅ Бот онлайн: ${client.user.tag}`);

  loadVoiceData();
  loadLifeData();
  loadAIMemory();

  try {
    await registerCommands();
    console.log('✅ Slash-команды зарегистрированы');
  } catch (error) {
    console.error('❌ Ошибка регистрации команд:', error);
  }

  await restoreCurrentVoiceSessions();
  await refreshPresence();

  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = setInterval(() => checkpointSessions(false), CHECKPOINT_MS);
  checkpointTimer.unref?.();

  if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
  presenceRefreshTimer = setInterval(() => {
    refreshPresence().catch((error) => {
      console.error('Ошибка обновления presence:', error);
    });
  }, PRESENCE_REFRESH_MS);
  presenceRefreshTimer.unref?.();

  if (presenceRotateTimer) clearInterval(presenceRotateTimer);
  presenceRotateTimer = setInterval(() => {
    rotatePresencePhrase().catch((error) => {
      console.error('Ошибка смены мемной фразы:', error);
    });
  }, PRESENCE_ROTATE_MS);
  presenceRotateTimer.unref?.();

  console.log(`🌿 Статус запущен: "Слушает ${lifeState.phrase}"`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!newState.guild || newState.guild.id !== GUILD_ID) return;
  if (newState.id === client.user.id) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (!oldChannelId && newChannelId) {
    startSession(newState.guild.id, newState.id);
    return;
  }

  if (oldChannelId && !newChannelId) {
    endSession(newState.guild.id, newState.id);
    return;
  }

  if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    endSession(newState.guild.id, newState.id);
    startSession(newState.guild.id, newState.id);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content) return;

  const botMentioned = message.mentions.has(client.user);
  const repliedToBot =
    message.reference?.messageId &&
    (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id;

  if (!botMentioned && !repliedToBot) return;

  const cleanText = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  const userText = cleanText || 'Привет';
  const authorName = message.member?.displayName || message.author.username;

  pushMemory(message.channel.id, 'user', authorName, userText);

  const prompt = buildPrompt(message.channel.id, authorName, userText);

  try {
    const answer = await askGemini(prompt);
    pushMemory(message.channel.id, 'model', 'Bot', answer);
    await message.reply(answer.slice(0, 2000));
  } catch (error) {
    console.error('Ошибка Gemini:', error);
    await message.reply('❌ Не смог получить ответ от Gemini.');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply({
      content: `🏓 Pong! \`${client.ws.ping}ms\``,
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'msg') {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('channel', true);
    const message = interaction.options.getString('message', true);

    if (!channel.isTextBased()) {
      await interaction.editReply({ content: '❌ Это не текстовый канал.' });
      return;
    }

    try {
      await channel.send({ content: message });
      await interaction.editReply({ content: `✅ Сообщение отправлено в ${channel}.` });
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
      await interaction.editReply({ content: '❌ Не удалось отправить сообщение.' });
    }

    return;
  }

  if (interaction.commandName === 'time') {
    await interaction.deferReply();

    const target = interaction.options.getUser('user') || interaction.user;
    const total = getTotalSeconds(interaction.guild.id, target.id);
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const name = member?.displayName || target.username;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name, iconURL: target.displayAvatarURL({ size: 256 }) })
      .setTitle('⏱ Время в войсе')
      .setDescription(`**Всего:** ${formatTime(total)}`)
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setFooter({ text: `ID: ${target.id}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'top') {
    await interaction.deferReply();

    const target = interaction.options.getUser('user') || interaction.user;
    const embed = await buildTopEmbed(interaction.guild, target);

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'life') {
    await interaction.deferReply();

    const embed = buildLifeEmbed();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'purge') {
    await interaction.deferReply({ ephemeral: true });

    const amount = interaction.options.getInteger('amount', true);

    if (!interaction.channel || !interaction.channel.isTextBased()) {
      await interaction.editReply({ content: '❌ Это не текстовый канал.' });
      return;
    }

    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply({ content: `✅ Удалено сообщений: **${deleted.size}**` });
    } catch (error) {
      console.error('Ошибка purge:', error);
      await interaction.editReply({ content: '❌ Не удалось удалить сообщения.' });
    }

    return;
  }

  if (interaction.commandName === 'jtm') {
    await interaction.deferReply({ ephemeral: true });

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.editReply({ content: '❌ Ты не в войсе.' });
      return;
    }

    const me = interaction.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);

    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
      await interaction.editReply({ content: '❌ У меня нет прав зайти в этот войс.' });
      return;
    }

    try {
      const existing = getVoiceConnection(interaction.guild.id);
      if (existing) existing.destroy();

      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      await interaction.editReply({ content: `✅ Зашёл в ${voiceChannel}.` });
    } catch (error) {
      console.error('Ошибка jtm:', error);
      await interaction.editReply({ content: '❌ Не удалось подключиться к войсу.' });
    }

    return;
  }

  if (interaction.commandName === 'ai') {
    await interaction.deferReply();

    const prompt = interaction.options.getString('prompt', true);
    const authorName = interaction.user.username;

    pushMemory(interaction.channel.id, 'user', authorName, prompt);

    const fullPrompt = buildPrompt(interaction.channel.id, authorName, prompt);

    try {
      const answer = await askGemini(fullPrompt);
      pushMemory(interaction.channel.id, 'model', 'Bot', answer);
      await interaction.editReply(answer.slice(0, 2000));
    } catch (error) {
      console.error('Ошибка Gemini:', error);
      await interaction.editReply('❌ Не смог получить ответ от Gemini.');
    }

    return;
  }
});

async function shutdown(signal) {
  try {
    console.log(`Получен ${signal}, сохраняю данные...`);
    checkpointSessions(true);
    saveVoiceData();
    saveLifeData();
    saveAIMemory();
  } catch (error) {
    console.error('Ошибка при сохранении перед выключением:', error);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot is alive');
  })
  .listen(process.env.PORT || 3000, () => {
    console.log(`🌐 HTTP server on ${process.env.PORT || 3000}`);
  });

client.login(TOKEN);
