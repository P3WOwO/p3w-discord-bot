const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;     // ← не обязательно для этого кода, но оставь если хочешь регистрировать команды автоматически

const DATA_DIR = '/data';
const DATA_FILE = `${DATA_DIR}/voice_times.json`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,   // чтобы нормально получать user.tag / displayName
  ],
});

let voiceTimes = {};          // "guildId:userId" → total seconds
let activeSessions = new Map(); // "guildId:userId" → join timestamp (ms)

function loadData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      voiceTimes = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log('Данные времени загружены');
    } catch (err) {
      console.error('Ошибка загрузки данных:', err);
      voiceTimes = {};
    }
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(voiceTimes, null, 2));
  } catch (err) {
    console.error('Ошибка сохранения данных:', err);
  }
}

function getKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function addTime(guildId, userId, seconds) {
  if (seconds < 10) return; // игнорируем микросекунды / быстрые входы-выходы
  const key = getKey(guildId, userId);
  voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  saveData();
}

function getTotalSeconds(guildId, userId) {
  const key = getKey(guildId, userId);
  let total = voiceTimes[key] || 0;

  // Если человек сейчас в войсе — добавляем текущее время
  const sessionKey = getKey(guildId, userId);
  if (activeSessions.has(sessionKey)) {
    const start = activeSessions.get(sessionKey);
    total += Math.floor((Date.now() - start) / 1000);
  }

  return total;
}

function formatTime(seconds) {
  const days    = Math.floor(seconds / 86400);
  const hours   = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs    = seconds % 60;

  const parts = [];
  if (days)    parts.push(`${days}д`);
  if (hours)   parts.push(`${hours}ч`);
  if (minutes) parts.push(`${minutes}м`);
  if (secs || parts.length === 0) parts.push(`${secs}с`);

  return parts.join(' ') || '0с';
}

client.once('ready', () => {
  console.log(`Бот запущен → ${client.user.tag}`);
  loadData();

  // Регистрация команды (можно делать один раз вручную в Discord Developer Portal)
  // или оставить так — при каждом запуске будет пытаться зарегистрировать (глобально)
  const commands = [
    new SlashCommandBuilder()
      .setName('time')
      .setDescription('Показать время, проведённое в голосовых каналах')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('Пользователь (если не указать — покажет твоё время)')
          .setRequired(false)
      )
      .toJSON(),
  ];

  const rest = require('@discordjs/rest').REST;
  const { Routes } = require('discord.js');

  new rest({ version: '10' }).setToken(TOKEN)
    .put(Routes.applicationCommands(CLIENT_ID), { body: commands })
    .then(() => console.log('Команда /time зарегистрирована'))
    .catch(console.error);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId  = newState.id;
  const key     = getKey(guildId, userId);

  // Зашёл / перешёл в войс
  if (!oldState.channelId && newState.channelId) {
    activeSessions.set(key, Date.now());
    console.log(`${newState.member.user.tag} зашёл в войс`);
  }
  // Вышел из войса
  else if (oldState.channelId && !newState.channelId) {
    const start = activeSessions.get(key);
    if (start) {
      const seconds = Math.floor((Date.now() - start) / 1000);
      addTime(guildId, userId, seconds);
      activeSessions.delete(key);
      console.log(`${newState.member.user.tag} вышел — +${seconds} сек`);
    }
  }
  // Перешёл между каналами → считаем как выход + вход
  else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const start = activeSessions.get(key);
    if (start) {
      const seconds = Math.floor((Date.now() - start) / 1000);
      addTime(guildId, userId, seconds);
    }
    activeSessions.set(key, Date.now()); // новая сессия
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'time') {
    await interaction.deferReply();

    const target = interaction.options.getUser('user') || interaction.user;
    const totalSec = getTotalSeconds(interaction.guild.id, target.id);

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const displayName = member?.displayName || target.username;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)                     // синий как у Discord
      .setAuthor({ name: displayName, iconURL: target.displayAvatarURL({ dynamic: true }) })
      .setTitle('Время в голосовых каналах')
      .setDescription(`**Общее время:** ${formatTime(totalSec)}`)
      .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 512 }))
      .setFooter({ text: `ID: ${target.id} • Запрошено ${interaction.user.tag}` })
      .setTimestamp();

    // Дополнительная информация, если хочешь
    // embed.addFields({ name: 'Текущая сессия', value: '...', inline: true });

    await interaction.editReply({ embeds: [embed] });
  }
});

client.login(TOKEN);
