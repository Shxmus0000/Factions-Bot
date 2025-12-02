// src/discord/panels/config/builders.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');

const {
  getGuildConfig,
  getConfig,              // walls
  getOutpostConfig,
  getShardConfig,
  getRpostShardConfig,
  getAltManagerConfig,
  getAltById,
} = require('../../../database');

const IDS = require('./ids');

// Utility: format a channel mention or fallback
function chMention(guild, id) {
  if (!id) return '*not set*';
  const ch = guild.channels.cache.get(id);
  return ch ? `<#${id}>` : `<#${id}>`;
}

function altLabel(alt) {
  return alt ? `**${alt.label}** (#${alt.id})` : '*not assigned*';
}

function findAlertChanMention(guild, name) {
  const ch = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText)
    .find((c) => c.name === name);
  if (ch) return `<#${ch.id}>`;
  // not created yet; show the intended name
  return `*auto: \`${name}\`*`;
}

async function buildMainEmbed(guild) {
  const gcfg = await getGuildConfig(guild.id).catch(() => null);
  const wcfg = await getConfig(guild.id).catch(() => null);
  const ocfg = await getOutpostConfig(guild.id).catch(() => null);
  const scfg = await getShardConfig(guild.id).catch(() => null);
  const rcfg = await getRpostShardConfig(guild.id).catch(() => null);
  const acfg = await getAltManagerConfig(guild.id).catch(() => null);

  // Resolve assigned alts
  const shardAltId = Number(gcfg?.shard_checker_alt_id || 0);
  const rpostAltId = Number(gcfg?.rpost_checker_alt_id || 0);
  const shardAlt = shardAltId ? await getAltById(shardAltId).catch(() => null) : null;
  const rpostAlt = rpostAltId ? await getAltById(rpostAltId).catch(() => null) : null;

  // Walls/Buffer
  const walls = {
    alertsChan: chMention(guild, gcfg?.raid_alerts_channel_id),
    dashChan: chMention(guild, wcfg?.channel_id),
    weewooActive: gcfg?.weewoo_active ? 'ACTIVE' : 'idle',
    paused: gcfg?.base_alerts_paused ? 'paused' : 'live',
    weewooInterval: gcfg?.weewoo_ping_interval_minutes ?? 2,
    interval: wcfg?.interval_minutes ?? 30,
  };

  // Outpost
  const outpost = {
    alertsChan: chMention(guild, gcfg?.outpost_alerts_channel_id),
    dashChan: chMention(guild, ocfg?.channel_id),
    weewooActive: gcfg?.outpost_weewoo_active ? 'ACTIVE' : 'idle',
    paused: gcfg?.outpost_alerts_paused ? 'paused' : 'live',
    weewooInterval: gcfg?.outpost_weewoo_ping_interval_minutes ?? 2,
    interval: ocfg?.interval_minutes ?? 30,
  };

  // Shard trackers
  const shard = {
    chan: chMention(guild, scfg?.channel_id),
    interval: scfg?.interval_minutes ?? 5,
    status: scfg?.enabled ? 'ON' : 'OFF',
    alt: altLabel(shardAlt),
  };
  const rpost = {
    chan: chMention(guild, rcfg?.channel_id),
    interval: rcfg?.interval_minutes ?? 5,
    status: rcfg?.enabled ? 'ON' : 'OFF',
    alt: altLabel(rpostAlt),
  };

  // Alt manager
  const altMgr = {
    chan: chMention(guild, acfg?.channel_id),
  };

  // Player alert channels — prefer DB ID, fallback to auto name
  const shardAlertsChan = scfg?.shard_player_alert_channel_id
    ? chMention(guild, scfg.shard_player_alert_channel_id)
    : findAlertChanMention(guild, 'shard-player-alerts');

  const rpostAlertsChan = rcfg?.rpost_player_alert_channel_id
    ? chMention(guild, rcfg.rpost_player_alert_channel_id)
    : findAlertChanMention(guild, 'rpost-player-alerts');

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Bot Configuration')
    .setColor(0x5865F2)
    .setDescription(
      [
        '**Walls / Buffer**',
        `• Status: ${walls.weewooActive} (${walls.paused})`,
        `• Ping Interval: ${walls.weewooInterval} min`,
        `• Check Interval: ${walls.interval} min`,
        `• Alerts Channel: ${walls.alertsChan}`,
        `• Dashboard Channel: ${walls.dashChan}`,
        '',
        '**Raiding Outpost**',
        `• Status: ${outpost.weewooActive} (${outpost.paused})`,
        `• Ping Interval: ${outpost.weewooInterval} min`,
        `• Check Interval: ${outpost.interval} min`,
        `• Alerts Channel: ${outpost.alertsChan}`,
        `• Dashboard Channel: ${outpost.dashChan}`,
        '',
        '**Shard Tracker**',
        `• Status: ${shard.status}`,
        `• Interval: ${shard.interval} min`,
        `• Channel: ${shard.chan}`,
        `• Checker Alt: ${shard.alt}`,
        `• Player Alerts Channel: ${shardAlertsChan}`,
        '',
        '**Rpost Shard Tracker**',
        `• Status: ${rpost.status}`,
        `• Interval: ${rpost.interval} min`,
        `• Channel: ${rpost.chan}`,
        `• Checker Alt: ${rpost.alt}`,
        `• Player Alerts Channel: ${rpostAlertsChan}`,
        '',
        '**Alt Manager**',
        `• Dashboard Channel: ${altMgr.chan}`,
      ].join('\n')
    )
    .setFooter({ text: `Guild: ${guild.name}` })
    .setTimestamp(new Date());

  // Main nav row
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_BUFFER_MENU).setLabel('Buffer Checks Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_MENU).setLabel('Raiding Outpost Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_SHARD_MENU).setLabel('Shard Tracker Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_RPOST_MENU).setLabel('Rpost Shard Config').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.BTN_ALTMGR_MENU).setLabel('Alt Manager Config').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.BTN_REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row1, row2] };
}

module.exports = {
  buildMainEmbed,
};
