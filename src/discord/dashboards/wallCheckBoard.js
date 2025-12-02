// src/discord/dashboards/wallCheckBoard.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');

const {
  getConfig,
  upsertConfig,
  insertWallCheck,
  getRecentChecks,
  getLeaderboard,
  getLastCheck,
  getGuildConfig,
  upsertGuildConfig,
} = require('../../database');

const DASH_IDS = {
  WALL_CLEAR: 'dash_wall_clear',
  WALL_WEEWOO: 'dash_wall_weewoo',
  WALL_REFRESH: 'dash_wall_refresh',
  WALL_LEADERBOARD: 'dash_wall_leaderboard',
};

function usernameFromCache(guild, userId) {
  if (!userId) return null;
  const m =
    guild.members.cache.get(userId) ||
    null;
  if (m?.nickname) return m.nickname;
  if (m?.user?.globalName) return m.user.globalName;
  if (m?.user?.username) return m.user.username;
  return null;
}

function lastCheckLine(guild, recent) {
  if (!recent?.length) return 'never';
  const last = recent[0];
  const at = last.timestamp ? `<t:${last.timestamp}:R>` : 'unknown time';
  const whoTag = last.discord_id ? `<@${last.discord_id}>` : 'someone';
  const whoName = usernameFromCache(guild, last.discord_id);
  const who = whoName ? `${whoTag}` : whoTag;
  const status = last.status || '—';
  return `${at} — ${status} by ${who}`;
}

function buildWallEmbed(guild, wcfg, gcfg, recent) {
  const chMention = wcfg?.channel_id ? `<#${wcfg.channel_id}>` : '`not set`';
  const raidMention = gcfg?.raid_alerts_channel_id ? `<#${gcfg.raid_alerts_channel_id}>` : '`not set`';
  const interval = wcfg?.interval_minutes ?? 30;

  const embed = new EmbedBuilder()
    .setTitle('Buffer Checks')
    .setColor(0xeb1102)
    .setDescription([
      `**Buffer Checks Dashboard:** ${chMention}`,
      `**Check Interval:** \`${interval}m\``,
      `**Raid Alerts Channel:** ${raidMention}`,
      '',
      `**Last Check:** ${lastCheckLine(guild, recent)}`,
    ].join('\n'))
    .setFooter({ text: 'Use the buttons below to CLEAR, trigger WEEWOO, refresh the board, or view the leaderboard.' });

  return embed;
}

function buildWallComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(DASH_IDS.WALL_CLEAR)
      .setStyle(ButtonStyle.Success)
      .setLabel('🟢 Clear'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.WALL_WEEWOO)
      .setStyle(ButtonStyle.Danger)
      .setLabel('🚨 WeeWoo'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.WALL_REFRESH)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('🔄 Refresh'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.WALL_LEADERBOARD)
      .setStyle(ButtonStyle.Primary)
      .setLabel('🏆 Leaderboard'),
  );
  return [row1];
}

async function ensureDashboard(guild, channelId) {
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Wall dashboard channel missing or not a text channel.');
  }

  const [wcfg, gcfg, recent] = await Promise.all([
    getConfig(guild.id),
    getGuildConfig(guild.id),
    getRecentChecks(guild.id, 1),
  ]);

  const embed = buildWallEmbed(guild, wcfg, gcfg, recent);
  const components = buildWallComponents();

  // try to reuse the stored message
  if (wcfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(wcfg.dashboard_message_id);
      if (msg?.author?.id === guild.client.user.id) {
        await msg.edit({ embeds: [embed], components });
        return msg;
      }
    } catch {}
  }

  // otherwise find by title
  try {
    const recentMsgs = await channel.messages.fetch({ limit: 50 });
    const existing = recentMsgs.find(
      (m) =>
        m.author?.id === guild.client.user.id &&
        m.embeds?.[0]?.title === '🧱 Buffer / Wall Checks'
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      await upsertConfig({ guild_id: guild.id, dashboard_message_id: existing.id });
      return existing;
    }
  } catch {}

  const sent = await channel.send({ embeds: [embed], components });
  try { await sent.pin().catch(() => {}); } catch {}
  await upsertConfig({ guild_id: guild.id, dashboard_message_id: sent.id });
  return sent;
}

function humanTimeLeft(seconds) {
  if (seconds <= 0) return 'now';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m && s) return `${m}m ${s}s`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/**
 * Cleanup helper for wall/buffer channels:
 * - Deletes bot-authored overdue alerts
 * - Deletes bot-authored clear status messages
 * Used both by the scheduler and by the CLEAR button.
 */
async function cleanupWallStatusMessages(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const clientId = channel.client.user?.id;

    const toDelete = messages.filter((m) => {
      if (!m || m.author?.id !== clientId) return false;
      const c = m.content || '';
      if (c.startsWith('⚠️ **Wall check overdue!**')) return true;
      if (c.startsWith('🟢 ') && c.includes('**buffer**') && c.includes('has marked')) return true;
      return false;
    });

    if (!toDelete.size) return;

    try {
      await channel.bulkDelete(toDelete, true);
    } catch {
      for (const msg of toDelete.values()) {
        try { await msg.delete().catch(() => {}); } catch {}
      }
    }
  } catch {
    // ignore cleanup issues
  }
}

// -------- Interaction handling for dashboard buttons --------
async function handleInteraction(interaction) {
  if (!interaction.inGuild()) return false;
  const guild = interaction.guild;

  if (!interaction.isButton()) return false;

  // Refresh
  if (interaction.customId === DASH_IDS.WALL_REFRESH) {
    await interaction.deferUpdate().catch(() => {});
    const wcfg = await getConfig(guild.id);
    await ensureDashboard(guild, wcfg.channel_id);
    return true;
  }

  // Leaderboard
  if (interaction.customId === DASH_IDS.WALL_LEADERBOARD) {
    const since = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60; // last 30 days
    const rows = await getLeaderboard(guild.id, since);

    const lines = rows.length
      ? rows.map((r, i) => `**${i + 1}.** <@${r.discord_id}> — **${r.count}** clear${r.count === 1 ? '' : 's'}`)
      : ['Nobody yet — go be first!'];

    const embed = new EmbedBuilder()
      .setTitle('🏆 Buffer/Wall Checks — Top (30d)')
      .setColor(0x805ad5)
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  // Clear (rate-limited to once per interval after a successful "clear")
  if (interaction.customId === DASH_IDS.WALL_CLEAR) {
    const now = Math.floor(Date.now() / 1000);
    const wcfg = await getConfig(guild.id);
    const intervalSec = Math.max(5, (wcfg?.interval_minutes ?? 30)) * 60;

    const last = await getLastCheck(guild.id).catch(() => null);
    if (last?.status === 'clear') {
      const diff = now - (last.timestamp || 0);
      if (diff < intervalSec) {
        const left = intervalSec - diff;
        await interaction.reply({
          content: `⏳ You already cleared the **buffer** recently. Next clear allowed in **${humanTimeLeft(left)}**.`,
          ephemeral: true,
        });
        return true;
      }
    }

    // Clean up existing overdue & old clear messages BEFORE new clear
    if (wcfg?.channel_id) {
      const channel = guild.channels.cache.get(wcfg.channel_id)
        || await guild.channels.fetch(wcfg.channel_id).catch(() => null);
      if (channel) {
        await cleanupWallStatusMessages(channel);
      }
    }

    // Record clear
    await insertWallCheck({
      guild_id: guild.id,
      discord_id: interaction.user.id,
      timestamp: now,
      source: 'discord',
      status: 'clear',
    });

    // Stop any active weewoo for base when cleared
    await upsertGuildConfig({ guild_id: guild.id, weewoo_active: 0 });

    // refresh board
    await ensureDashboard(guild, wcfg.channel_id);

    const interval = wcfg?.interval_minutes ?? 30;
    const userName = interaction.member?.displayName || interaction.user.username;
    await interaction.reply({
      content: `🟢 **${userName}** has marked the **buffer** as clear. Next check will be in **${interval}m**.`,
    });
    return true;
  }

  // WeeWoo (always allowed)
  if (interaction.customId === DASH_IDS.WALL_WEEWOO) {
    const ts = Math.floor(Date.now() / 1000);
    await insertWallCheck({
      guild_id: guild.id,
      discord_id: interaction.user.id,
      timestamp: ts,
      source: 'discord',
      status: 'weewoo',
    });

    // Activate base WeeWoo + prime last ping to now for cadence
    await upsertGuildConfig({
      guild_id: guild.id,
      weewoo_active: 1,
      weewoo_last_ping_at: 0,
      base_alerts_paused: 0,
    });

    // Send initial alert to raid alerts channel (not the dashboard)
    const gcfg = await getGuildConfig(guild.id);
    const raidChan = gcfg?.raid_alerts_channel_id
      ? guild.channels.cache.get(gcfg.raid_alerts_channel_id) || await guild.channels.fetch(gcfg.raid_alerts_channel_id).catch(() => null)
      : null;

    if (raidChan) {
      await raidChan.send('🚨 **WEEWOO ACTIVE (Base)** — not clear. Use **🟢 Clear** in #buffer-checks when safe.');
    }

    // refresh board
    const wcfg = await getConfig(guild.id);
    await ensureDashboard(guild, wcfg.channel_id);

    const userName = interaction.member?.displayName || interaction.user.username;
    await interaction.reply({
      content: `🚨 **${userName}** has **activated WeeWoo** for **buffer**. Raid alerts channel notified.`,
    });
    return true;
  }

  return false;
}

module.exports = {
  ensureDashboard,
  handleInteraction,
  DASH_IDS, // exported for router if ever needed
  cleanupWallStatusMessages,
};
