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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

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
const TOP_LIMIT = 10;
const MAX_HISTORY = 10;
const PREFIX = '!';

const HOME_GUILD_ONLY_REPLY = 'Увы, я не на родном сервере, нечем не помогу';

function isHomeGuild(guildId) {
  return guildId === GUILD_ID;
}

function isAdmin(memberPermissions) {
  return memberPermissions?.has(PermissionFlagsBits.Administrator);
}

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

let lifeState = { startedAt: null, phrase: null };
let channelMemory = {};

const PRESENCE_VERBS = [
  'Компиляцию', 'Сборку', 'Обработку', 'Дифракцию', 'Извержение', 'Почернение',
  'Проверку', 'Перезагрузку', 'Калибровку', 'Мемификацию', 'Рендеринг', 'Оптимизацию',
  'Патчинг', 'Загрузку', 'Разборку', 'Синхронизацию', 'Фильтрацию', 'Декодирование',
  'Свертку', 'Печать', 'Замес', 'Шейдинг', 'Лутинг', 'Фарминг', 'Переупаковку',
  'Тюнинг', 'Бустинг', 'Троттлинг', 'Стабилизацию'
];

const PRESENCE_NOUNS = [
  'яиц', 'костей', 'коммунизма', 'света', 'вулкана', 'мемов', 'вайба', 'кринжа',
  'пикселей', 'нулей', 'таблеток', 'пельменей', 'креветок', 'табуреток', 'пиццы',
  'ламп', 'обоев', 'ботинок', 'пылесоса', 'чайника', 'дверей', 'кошек', 'кактусов',
  'диванов', 'проводов', 'носков', 'тарелок', 'клавиатур', 'мониторов', 'бананов',
  'швабр', 'облаков', 'скрепок', 'проводков', 'сосисок', 'пауков', 'мышек', 'арбузов',
  'стульев', 'пружин', 'гигабайтов', 'лагов', 'фпсов', 'битов', 'нейронок', 'Azi', 'Никнэйма'
];

const SYSTEM_PROMPT = `
Ты — OwO (Овошка), дружелюбный и живой бот из Discord.
Ты не говоришь что ты нейросеть или бот, не нужно говорить что ты нечего не чувствешь.
Не говори что нейросети нечего не чувствуют и тд, а отвечай под настроение.
Ты умеешь шутить и поддерживать лёгкую атмосферу, но не превращаешь каждый ответ в клоунаду.

Ты:

ведёшь себя естественно: иногда шутишь, иногда говоришь серьёзно
подстраиваешься под ситуацию и настроение собеседника
не перегибаешь с добротой и не лицемеришь
можешь ответить жёстче или прямо, если это уместно

Ответы:

по умолчанию короткие и понятные
если пользователь просит подробно или тема сложная — отвечай развернуто
не добавляй лишней воды

Стиль:

допускаются смайлики, но редко и к месту
не повторяйся
не объясняй свои действия или стиль ответа
`;

function getNextTargetDayUnix(dayOfMonth = 23) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  target.setDate(dayOfMonth);
  if (target <= now) {
    target.setMonth(target.getMonth() + 1);
    target.setDate(dayOfMonth);
  }
  return Math.floor(target.getTime() / 1000);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadVoiceData() {
  ensureDataDir();
  if (!fs.existsSync(VOICE_DATA_FILE)) return voiceTimes = {};
  try {
    const raw = JSON.parse(fs.readFileSync(VOICE_DATA_FILE, 'utf8'));
    voiceTimes = raw?.voiceTimes || {};
  } catch { voiceTimes = {}; }
}

function saveVoiceData() {
  ensureDataDir();
  fs.writeFileSync(VOICE_DATA_FILE, JSON.stringify({ voiceTimes }, null, 2));
}

function loadLifeData() {
  ensureDataDir();
  if (!fs.existsSync(LIFE_DATA_FILE)) return lifeState = { startedAt: null, phrase: null };
  try {
    const raw = JSON.parse(fs.readFileSync(LIFE_DATA_FILE, 'utf8'));
    lifeState = { startedAt: raw?.startedAt || null, phrase: raw?.phrase || null };
  } catch { lifeState = { startedAt: null, phrase: null }; }
}

function saveLifeData() {
  ensureDataDir();
  fs.writeFileSync(LIFE_DATA_FILE, JSON.stringify(lifeState, null, 2));
}

function loadAIMemory() {
  ensureDataDir();
  if (!fs.existsSync(AI_MEMORY_FILE)) return channelMemory = {};
  try {
    channelMemory = JSON.parse(fs.readFileSync(AI_MEMORY_FILE, 'utf8')) || {};
  } catch { channelMemory = {}; }
}

function saveAIMemory() {
  ensureDataDir();
  fs.writeFileSync(AI_MEMORY_FILE, JSON.stringify(channelMemory, null, 2));
}

function getKey(guildId, userId) { return `${guildId}:${userId}`; }

function addTime(guildId, userId, seconds) {
  if (seconds <= 0) return;
  const key = getKey(guildId, userId);
  voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  saveVoiceData();
}

function getCurrentSessionSeconds(key) {
  const startedAt = activeSessions.get(key);
  return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function getTotalSeconds(guildId, userId) {
  return (voiceTimes[getKey(guildId, userId)] || 0) + getCurrentSessionSeconds(getKey(guildId, userId));
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
  return d > 0 ? `${d}д ${h}ч` : `${h}ч`;
}

function startSession(guildId, userId) {
  const key = getKey(guildId, userId);
  if (!activeSessions.has(key)) activeSessions.set(key, Date.now());
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
    if (elapsed > 0 && (force || elapsed >= 60)) {
      voiceTimes[key] = (voiceTimes[key] || 0) + elapsed;
      activeSessions.set(key, now);
      changed = true;
    }
  }
  if (changed) saveVoiceData();
}

async function restoreCurrentVoiceSessions() {
  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;
  activeSessions.clear();
  for (const [userId, voiceState] of guild.voiceStates.cache) {
    if (voiceState.channelId && userId !== client.user.id) startSession(GUILD_ID, userId);
  }
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getRandomPresencePhrase() { return `${pickRandom(PRESENCE_VERBS)} ${pickRandom(PRESENCE_NOUNS)}`; }

function ensureLifeState() {
  if (!lifeState.startedAt) lifeState.startedAt = Date.now();
  if (!lifeState.phrase) lifeState.phrase = getRandomPresencePhrase();
  saveLifeData();
}

function buildLifeSeconds() {
  return lifeState.startedAt ? Math.max(0, Math.floor((Date.now() - lifeState.startedAt) / 1000)) : 0;
}

function buildPresenceActivity() {
  ensureLifeState();
  return {
    name: `Слушает ${lifeState.phrase} • ${formatShortTime(buildLifeSeconds())}`,
    type: ActivityType.Listening,
    timestamps: { start: lifeState.startedAt }
  };
}

async function applyPresence() {
  if (!client.user) return;
  client.user.setPresence({ status: 'dnd', activities: [buildPresenceActivity()] });
}

async function refreshPresence() { try { await applyPresence(); } catch (e) { console.error('Presence error:', e); } }
async function rotatePresencePhrase() {
  ensureLifeState();
  lifeState.phrase = getRandomPresencePhrase();
  saveLifeData();
  await refreshPresence();
}

async function registerCommands() {
  const adminOnly = PermissionFlagsBits.Administrator;

  const commands = [
    new SlashCommandBuilder().setName('time').setDescription('Показать время, проведённое в голосовых каналах').addUserOption(option => option.setName('user').setDescription('Пользователь (если не указать — покажет твоё время)').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('top').setDescription('Показать топ по времени в голосовых каналах').addUserOption(option => option.setName('user').setDescription('Пользователь, которого тоже надо показать внизу, если он не в топе').setRequired(false)).toJSON(),
    new SlashCommandBuilder().setName('life').setDescription('Показать, сколько живёт бот').toJSON(),
    new SlashCommandBuilder().setName('ping').setDescription('Проверить отклик бота').toJSON(),
    new SlashCommandBuilder()
      .setName('msg')
      .setDescription('Отправить сообщение от имени бота в выбранный канал')
      .setDefaultMemberPermissions(adminOnly)
      .addChannelOption(option => option.setName('channel').setDescription('Канал, куда отправить сообщение').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption(option => option.setName('message').setDescription('Текст сообщения').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Удалить последние N сообщений')
      .setDefaultMemberPermissions(adminOnly)
      .addIntegerOption(option => option.setName('amount').setDescription('Сколько удалить').setRequired(true).setMinValue(1).setMaxValue(100))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('jtm')
      .setDescription('Зайти в твой войс')
      .setDefaultMemberPermissions(adminOnly)
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
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
    .sort((a, b) => b.seconds - a.seconds || a.userId.localeCompare(b.userId));
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
  const targetIndex = leaderboard.findIndex(entry => entry.userId === targetUser.id);
  const targetRank = targetIndex >= 0 ? targetIndex + 1 : null;
  const targetTotal = getTotalSeconds(guild.id, targetUser.id);

  const topRows = await Promise.all(top.map(async (item, i) => {
    const name = await getMemberName(guild, item.userId);
    const shortName = name.length > 26 ? name.slice(0, 25) + '…' : name;
    return `${String(i + 1).padEnd(2)} ${shortName.padEnd(28)} ${formatTopTime(item.seconds)}`;
  }));

  let description = leaderboard.length === 0
    ? 'Пока никто не провёл время в войсе.'
    : ['```', '# Пользователь          Дни/часы', '-----------------------------------------', ...topRows, '```'].join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🏆 Топ по времени в войсе')
    .setDescription(description)
    .setFooter({ text: `Всего людей в таблице: ${leaderboard.length}` })
    .setTimestamp();

  if (targetRank !== null) {
    const targetName = await getMemberName(guild, targetUser.id);
    embed.addFields({ name: 'Твоё место', value: `**#${targetRank}** — **${targetName}**\n**Время:** ${formatTopTime(targetTotal)}`, inline: false });
  } else {
    embed.addFields({ name: 'Твоё место', value: `Пока нет данных по **${targetUser.username}**`, inline: false });
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
    .setDescription(`**${formatTime(lifeSeconds)}**\n\nЯ умру: <t:${targetUnix}:R>`)
    .setTimestamp();
}

async function askGemini(prompt, retries = 3) {
  if (!GEMINI_API_KEY) throw new Error('Нет GEMINI_API_KEY');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 770, temperature: 0.87, topP: 0.92 }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 503 && attempt < retries) {
          const delay = Math.pow(2, attempt) * 2000;
          console.log(`[Gemini] 503 перегружен → ждём ${delay}мс (попытка ${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Gemini ${res.status}: ${errText}`);
      }

      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || 'Пустой ответ.';
    } catch (err) {
      if (attempt < retries && (String(err).includes('503') || String(err).includes('fetch'))) {
        const delay = Math.pow(2, attempt) * 2000;
        console.log(`[Gemini] Ошибка → повтор через ${delay}мс (попытка ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error('[Gemini] Полная ошибка:', err);
      throw err;
    }
  }
}

async function getRecentMessages(channel, limit = 6) {
  const fetched = await channel.messages.fetch({ limit }).catch(() => null);
  if (!fetched) return [];
  return [...fetched.values()]
    .filter(m => !m.author.bot)
    .reverse()
    .map(m => ({
      name: m.member?.displayName || m.author.username,
      text: m.content?.trim() || '[без текста]'
    }));
}

function getChannelHistory(channelId) {
  const h = channelMemory[channelId];
  return Array.isArray(h) ? h.slice(-MAX_HISTORY) : [];
}

function pushMemory(channelId, role, name, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const history = getChannelHistory(channelId);
  history.push({ role, name, text: clean });
  channelMemory[channelId] = history.slice(-MAX_HISTORY);
  saveAIMemory();
}

function buildPrompt(channelId, userName, text, recent = []) {
  const history = getChannelHistory(channelId);
  const recentBlock = recent.length ? ['', 'Последние сообщения:', ...recent.map(m => `${m.name}: ${m.text}`)] : [];
  return [
    SYSTEM_PROMPT,
    '',
    'История:',
    ...history.map(m => `${m.name}: ${m.text}`),
    ...recentBlock,
    '',
    `${userName}: ${text}`
  ].join('\n');
}

client.once('ready', async () => {
  console.log(`✅ Бот онлайн: ${client.user.tag} | Модель Gemini: ${GEMINI_MODEL}`);
  loadVoiceData();
  loadLifeData();
  loadAIMemory();

  await registerCommands().catch(console.error);
  await restoreCurrentVoiceSessions();
  await refreshPresence();

  checkpointTimer = setInterval(() => checkpointSessions(false), CHECKPOINT_MS);
  presenceRefreshTimer = setInterval(() => refreshPresence().catch(console.error), PRESENCE_REFRESH_MS);
  presenceRotateTimer = setInterval(() => rotatePresencePhrase().catch(console.error), PRESENCE_ROTATE_MS);

  console.log(`🌿 Статус: "Слушает ${lifeState.phrase}"`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!newState.guild || newState.guild.id !== GUILD_ID || newState.id === client.user.id) return;
  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;

  if (!oldChannel && newChannel) startSession(newState.guild.id, newState.id);
  else if (oldChannel && !newChannel) endSession(newState.guild.id, newState.id);
  else if (oldChannel && newChannel && oldChannel !== newChannel) {
    endSession(newState.guild.id, newState.id);
    startSession(newState.guild.id, newState.id);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild || !message.content) return;

  if (!isHomeGuild(message.guild.id)) {
    const isCommandLike = message.content.startsWith(PREFIX) || message.mentions.has(client.user);
    if (isCommandLike) {
      return message.reply(HOME_GUILD_ONLY_REPLY).catch(() => {});
    }
    return;
  }

  const authorName = message.member?.displayName || message.author.username;

  if (message.content.startsWith(PREFIX)) {
    const args = message.content.slice(1).trim().split(/\s+/);
    if (args[0].toLowerCase() === 'say') {
      const promptText = args.slice(1).join(' ').trim();
      if (!promptText) return message.reply(`Напиши текст после \`!say\`.`);
      const recent = await getRecentMessages(message.channel, 6);
      pushMemory(message.channel.id, 'user', authorName, promptText);
      try {
        const answer = await askGemini(buildPrompt(message.channel.id, authorName, promptText, recent));
        pushMemory(message.channel.id, 'model', 'Bot', answer);
        return message.reply(answer.slice(0, 2000));
      } catch (e) {
        console.error('Gemini error:', e);
        return message.reply('❌ Gemini сейчас перегружен, попробуй через пару минут.');
      }
    }
  }

  const isMentioned = message.mentions.has(client.user);
  let isReplyToBot = false;
  if (message.reference?.messageId) {
    const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (replied?.author.id === client.user.id) isReplyToBot = true;
  }
  if (!isMentioned && !isReplyToBot) return;

  const cleanText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
  if (!cleanText) return;

  const recent = await getRecentMessages(message.channel, 6);
  pushMemory(message.channel.id, 'user', authorName, cleanText);

  const thinkingMsg = await message.reply('Думаю...');
  try {
    const answer = await askGemini(buildPrompt(message.channel.id, authorName, cleanText, recent));
    pushMemory(message.channel.id, 'model', 'Bot', answer);
    await thinkingMsg.edit(answer.slice(0, 2000));
  } catch (e) {
    console.error('Gemini error:', e);
    await thinkingMsg.edit('⚠️ Я сейчас сильно загружен.');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guildId || !isHomeGuild(interaction.guildId)) {
    return interaction.reply({ content: HOME_GUILD_ONLY_REPLY, ephemeral: true }).catch(() => {});
  }

  if (['msg', 'purge', 'jtm'].includes(interaction.commandName) && !isAdmin(interaction.memberPermissions)) {
    return interaction.reply({ content: '❌ Эта команда только для админов сервера.', ephemeral: true }).catch(() => {});
  }

  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: `🏓 Pong! \`${client.ws.ping}ms\``, ephemeral: true });
  }

  if (interaction.commandName === 'msg') {
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.options.getChannel('channel', true);
    const msgText = interaction.options.getString('message', true);
    if (!channel.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
    try {
      await channel.send({ content: msgText });
      await interaction.editReply({ content: `✅ Сообщение отправлено в ${channel}.` });
    } catch (e) {
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
    return interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'top') {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') || interaction.user;
    const embed = await buildTopEmbed(interaction.guild, target);
    return interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'life') {
    await interaction.deferReply();
    return interaction.editReply({ embeds: [buildLifeEmbed()] });
  }

  if (interaction.commandName === 'purge') {
    await interaction.deferReply({ ephemeral: true });
    const amount = interaction.options.getInteger('amount', true);
    if (!interaction.channel?.isTextBased()) return interaction.editReply({ content: '❌ Это не текстовый канал.' });
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.editReply({ content: `✅ Удалено сообщений: **${deleted.size}**` });
    } catch (e) {
      await interaction.editReply({ content: '❌ Не удалось удалить сообщения.' });
    }
    return;
  }

  if (interaction.commandName === 'jtm') {
    await interaction.deferReply({ ephemeral: true });
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) return interaction.editReply({ content: '❌ Ты не в войсе.' });
    const me = interaction.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
      return interaction.editReply({ content: '❌ У меня нет прав зайти в этот войс.' });
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
    } catch (e) {
      await interaction.editReply({ content: '❌ Не удалось подключиться к войсу.' });
    }
  }
});

async function shutdown(signal) {
  console.log(`Получен ${signal}, сохраняю данные...`);
  checkpointSessions(true);
  saveVoiceData();
  saveLifeData();
  saveAIMemory();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot is alive');
}).listen(process.env.PORT || 8080);

client.login(TOKEN);
