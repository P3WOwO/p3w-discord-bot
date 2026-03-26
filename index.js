const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes,
  MessageFlags,
  ActivityType,
} = require('discord.js');
const fs = require('fs');
const http = require('http');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error('Не хватает TOKEN, CLIENT_ID или GUILD_ID в переменных окружения.');
}

const DATA_DIR = '/data';
const DATA_FILE = `${DATA_DIR}/voice_times.json`;
const CHECKPOINT_MS = 60 * 1000;
const TOP_LIMIT = 7;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let voiceTimes = {};
let activeSessions = new Map();
let checkpointTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadData() {
  ensureDataDir();

  if (!fs.existsSync(DATA_FILE)) {
    voiceTimes = {};
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.voiceTimes && typeof raw.voiceTimes === 'object') {
      voiceTimes = raw.voiceTimes;
    } else if (raw && typeof raw === 'object') {
      voiceTimes = raw;
    } else {
      voiceTimes = {};
    }
  } catch (error) {
    console.error('Не удалось прочитать файл данных, начинаю с пустой статистики:', error);
    voiceTimes = {};
  }
}

function saveData() {
  ensureDataDir();
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        voiceTimes,
      },
      null,
      2
    )
  );
}

function getKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function addTime(guildId, userId, seconds) {
  if (seconds <= 0) return;

  const key = getKey(guildId, userId);
  voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  saveData();
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

  if (changed) saveData();
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
      .setName('ping')
      .setDescription('Проверить отклик бота')
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
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
    const nameWidth = 24;

    const rows = [];
    rows.push('```');
    rows.push(`#  ${'Пользователь'.padEnd(nameWidth)}  Время`);
    rows.push('-----------------------------------------------');

    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      const name = await getMemberName(guild, item.userId);
      const shortName = name.length > nameWidth ? name.slice(0, nameWidth - 1) + '…' : name;
      const rank = String(i + 1).padEnd(2, ' ');
      const time = formatTime(item.seconds);
      rows.push(`${rank} ${shortName.padEnd(nameWidth)}  ${time}`);
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

  if (targetRank !== null && targetRank > TOP_LIMIT) {
    const targetName = await getMemberName(guild, targetUser.id);
    embed.addFields({
      name: 'Твоё место',
      value: `**#${targetRank}** — **${targetName}**\n**Время:** ${formatTime(targetTotal)}`,
      inline: false,
    });
  } else if (targetRank !== null) {
    const targetName = await getMemberName(guild, targetUser.id);
    embed.addFields({
      name: 'Твоё место',
      value: `**#${targetRank}** — **${targetName}**\n**Время:** ${formatTime(targetTotal)}`,
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

client.once('ready', async () => {
  console.log(`✅ Бот онлайн: ${client.user.tag}`);

  loadData();

  try {
    await registerCommands();
    console.log('✅ Slash-команды зарегистрированы');
  } catch (error) {
    console.error('❌ Ошибка регистрации команд:', error);
  }

  await restoreCurrentVoiceSessions();

  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: 'Пение птиц',
        type: ActivityType.Listening,
        timestamps: {
          start: Date.now(),
        },
      },
    ],
  });

  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = setInterval(() => checkpointSessions(false), CHECKPOINT_MS);
  checkpointTimer.unref?.();
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply({
      content: `🏓 Pong! \`${client.ws.ping}ms\``,
      ephemeral: true,
    });
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
});

async function shutdown(signal) {
  try {
    console.log(`Получен ${signal}, сохраняю данные...`);
    checkpointSessions(true);
    saveData();
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
    console.log('🌐 HTTP сервер запущен');
  });

client.login(TOKEN);
