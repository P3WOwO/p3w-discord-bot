const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;   // Application ID из Discord Developer Portal
const GUILD_ID = process.env.GUILD_ID;     // ID твоего сервера

const DATA_DIR = '/data';
const DATA_FILE = `${DATA_DIR}/voice_times.json`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let voiceTimes = {};
let activeSessions = new Map();

function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try { voiceTimes = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { voiceTimes = {}; }
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(voiceTimes, null, 2));
}

function getKey(guildId, userId) { 
  return `${guildId}:${userId}`; 
}

function addTime(guildId, userId, seconds) {
  if (seconds < 10) return;
  const key = getKey(guildId, userId);
  voiceTimes[key] = (voiceTimes[key] || 0) + seconds;
  saveData();
}

function getTotalSeconds(guildId, userId) {
  const key = getKey(guildId, userId);
  let total = voiceTimes[key] || 0;
  if (activeSessions.has(key)) {
    total += Math.floor((Date.now() - activeSessions.get(key)) / 1000);
  }
  return total;
}

function formatTime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d ? d + 'д ' : ''}${h}ч ${m}м ${s}с`.trim();
}

// ====================== ЗАПУСК ======================
client.once('ready', async () => {
  console.log(`✅ Бот онлайн: ${client.user.tag}`);
  loadData();

  // Регистрация команды /time (только на твоём сервере — появляется за 3-5 секунд)
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

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Команда /time успешно зарегистрирована на сервере');
  } catch (error) {
    console.error('❌ Ошибка регистрации команды:', error);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;
  const key = getKey(guildId, userId);

  if (!oldState.channelId && newState.channelId) {
    activeSessions.set(key, Date.now());
  } else if (oldState.channelId && !newState.channelId) {
    const start = activeSessions.get(key);
    if (start) {
      const secs = Math.floor((Date.now() - start) / 1000);
      addTime(guildId, userId, secs);
      activeSessions.delete(key);
    }
  } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    const start = activeSessions.get(key);
    if (start) addTime(guildId, userId, Math.floor((Date.now() - start) / 1000));
    activeSessions.set(key, Date.now());
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'time') return;

  await interaction.deferReply();

  const target = interaction.options.getUser('user') || interaction.user;
  const total = getTotalSeconds(interaction.guild.id, target.id);
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  const name = member?.displayName || target.username;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: name, iconURL: target.displayAvatarURL({ dynamic: true }) })
    .setTitle('⏱ Время в войсе')
    .setDescription(`**${formatTime(total)}**`)
    .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 256 }))
    .setFooter({ text: `ID: ${target.id}` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

client.login(TOKEN);
