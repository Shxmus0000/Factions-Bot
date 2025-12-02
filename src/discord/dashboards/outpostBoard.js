// src/discord/dashboards/outpostBoard.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require('discord.js');

const {
  getOutpostConfig,
  upsertOutpostConfig,
  insertOutpostCheck,
  getOutpostRecentChecks,
  getOutpostLeaderboard,
  getOutpostLastCheck,
  getGuildConfig,
  upsertGuildConfig,
} = require('../../database');

const DASH_IDS = {
  OUTP_CLEAR: 'dash_outp_clear',
  OUTP_WEEWOO: 'dash_outp_weewoo',
  OUTP_REFRESH: 'dash_outp_refresh',
  OUTP_LEADERBOARD: 'dash_outp_leaderboard',
};

function usernameFromCache(guild, userId) {
  if (!userId) return null;
  const m = guild.members.cache.get(userId) || null;
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

function buildOutpostEmbed(guild, ocfg, gcfg, recent) {
  const chMention = ocfg?.channel_id ? `<#${ocfg.channel_id}>` : '`not set`';
  const alertMention = gcfg?.outpost_alerts_channel_id ? `<#${gcfg.outpost_alerts_channel_id}>` : '`not set`';
  const interval = ocfg?.interval_minutes ?? 30;

  const embed = new EmbedBuilder()
    .setTitle('Outpost Checks')
    .setColor(0xeb1102)
    .setDescription([
      `**Outpost Checks Dashboard:** ${chMention}`,
      `**Check Interval:** \`${interval}m\``,
      `**Raid Alerts Channel:** ${alertMention}`,
      '',
      `**Last Check:** ${lastCheckLine(guild, recent)}`,
    ].join('\n'))
    .setFooter({ text: 'Use the buttons below to CLEAR, trigger WEEWOO, refresh the board, or view the leaderboard.' });

  return embed;
}

function buildOutpostComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(DASH_IDS.OUTP_CLEAR)
      .setStyle(ButtonStyle.Success)
      .setLabel('🟢 Clear'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.OUTP_WEEWOO)
      .setStyle(ButtonStyle.Danger)
      .setLabel('🚨 WeeWoo'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.OUTP_REFRESH)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('🔄 Refresh'),
    new ButtonBuilder()
      .setCustomId(DASH_IDS.OUTP_LEADERBOARD)
      .setStyle(ButtonStyle.Primary)
      .setLabel('🏆 Leaderboard'),
  );
  return [row];
}

async function ensureOutpostDashboard(guild, channelId) {
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('Outpost dashboard channel missing or not a text channel.');
  }

  const [ocfg, gcfg, recent] = await Promise.all([
    getOutpostConfig(guild.id),
    getGuildConfig(guild.id),
    getOutpostRecentChecks(guild.id, 1),
  ]);

  const embed = buildOutpostEmbed(guild, ocfg, gcfg, recent);
  const components = buildOutpostComponents();

  if (ocfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(ocfg.dashboard_message_id);
      if (msg?.author?.id === guild.client.user.id) {
        await msg.edit({ embeds: [embed], components });
        return msg;
      }
    } catch {}
  }

  try {
    const recentMsgs = await channel.messages.fetch({ limit: 50 });
    const existing = recentMsgs.find(
      (m) =>
        m.author?.id === guild.client.user.id &&
        m.embeds?.[0]?.title === '🪖 Outpost Checks'
    );
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: existing.id });
      return existing;
    }
  } catch {}

  const sent = await channel.send({ embeds: [embed], components });
  try { await sent.pin().catch(() => {}); } catch {}
  await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: sent.id });
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
 * Cleanup helper for outpost channels:
 * - Deletes bot-authored overdue alerts
 * - Deletes bot-authored clear status messages
 * Used both by the scheduler and by the CLEAR button.
 */
async function cleanupOutpostStatusMessages(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const clientId = channel.client.user?.id;

    const toDelete = messages.filter((m) => {
      if (!m || m.author?.id !== clientId) return false;
      const c = m.content || '';
      if (c.startsWith('⚠️ **Outpost check overdue!**')) return true;
      if (c.startsWith('🟢 ') && c.includes('**outpost**') && c.includes('has marked')) return true;
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
    // swallow cleanup errors – non-critical
  }
}

// -------- Interaction handling for dashboard buttons --------
async function handleOutpostInteraction(interaction) {
  if (!interaction.inGuild()) return false;
  const guild = interaction.guild;
  if (!interaction.isButton()) return false;

  // Refresh
  if (interaction.customId === DASH_IDS.OUTP_REFRESH) {
    await interaction.deferUpdate().catch(() => {});
    const ocfg = await getOutpostConfig(guild.id);
    await ensureOutpostDashboard(guild, ocfg.channel_id);
    return true;
  }

  // Leaderboard
  if (interaction.customId === DASH_IDS.OUTP_LEADERBOARD) {
    const since = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const rows = await getOutpostLeaderboard(guild.id, since);

    const lines = rows.length
      ? rows.map((r, i) => `**${i + 1}.** <@${r.discord_id}> — **${r.count}** clear${r.count === 1 ? '' : 's'}`)
      : ['Nobody yet — go be first!'];

    const embed = new EmbedBuilder()
      .setTitle('🏆 Outpost Checks — Top (30d)')
      .setColor(0x319795)
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  // Clear (rate-limited to once per interval after a successful "clear")
  if (interaction.customId === DASH_IDS.OUTP_CLEAR) {
    const now = Math.floor(Date.now() / 1000);
    const ocfg = await getOutpostConfig(guild.id);
    const intervalSec = Math.max(5, (ocfg?.interval_minutes ?? 30)) * 60;

    const last = await getOutpostLastCheck(guild.id).catch(() => null);
    if (last?.status === 'clear') {
      const diff = now - (last.timestamp || 0);
      if (diff < intervalSec) {
        const left = intervalSec - diff;
        await interaction.reply({
          content: `⏳ You already cleared the **outpost** recently. Next clear allowed in **${humanTimeLeft(left)}**.`,
          ephemeral: true,
        });
        return true;
      }
    }

    // Clean up existing overdue & old clear messages BEFORE new clear
    if (ocfg?.channel_id) {
      const channel = guild.channels.cache.get(ocfg.channel_id)
        || await guild.channels.fetch(ocfg.channel_id).catch(() => null);
      if (channel) {
        await cleanupOutpostStatusMessages(channel);
      }
    }

    // Record clear
    await insertOutpostCheck({
      guild_id: guild.id,
      discord_id: interaction.user.id,
      timestamp: now,
      source: 'discord',
      status: 'clear',
    });

    // Stop any active outpost weewoo when cleared
    await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_active: 0 });

    await ensureOutpostDashboard(guild, ocfg.channel_id);

    const interval = ocfg?.interval_minutes ?? 30;
    const userName = interaction.member?.displayName || interaction.user.username;
    await interaction.reply({
      content: `🟢 **${userName}** has marked the **outpost** as clear. Next check will be in **${interval}m**.`,
    });
    return true;
  }

  // WeeWoo (always allowed)
  if (interaction.customId === DASH_IDS.OUTP_WEEWOO) {
    const ts = Math.floor(Date.now() / 1000);
    await insertOutpostCheck({
      guild_id: guild.id,
      discord_id: interaction.user.id,
      timestamp: ts,
      source: 'discord',
      status: 'weewoo',
    });

    await upsertGuildConfig({
      guild_id: guild.id,
      outpost_weewoo_active: 1,
      outpost_weewoo_last_ping_at: 0,
      outpost_alerts_paused: 0,
    });

    // Send initial alert to outpost alerts channel
    const gcfg = await getGuildConfig(guild.id);
    const alertChan = gcfg?.outpost_alerts_channel_id
      ? guild.channels.cache.get(gcfg.outpost_alerts_channel_id) || await guild.channels.fetch(gcfg.outpost_alerts_channel_id).catch(() => null)
      : null;

    if (alertChan) {
      await alertChan.send('🚨 **WEEWOO ACTIVE (Outpost)** — not clear. Use **🟢 Clear** on the Outpost dashboard when safe.');
    }

    // REFRESH: re-fetch ocfg here (fixed: ocfg was undefined previously)
    const ocfg = await getOutpostConfig(guild.id);
    await ensureOutpostDashboard(guild, ocfg.channel_id);

    const userName = interaction.member?.displayName || interaction.user.username;
    await interaction.reply({
      content: `🚨 **${userName}** has **activated WeeWoo** for **outpost**. Outpost alerts channel notified.`,
    });
    return true;
  }

  return false;
}

module.exports = {
  ensureOutpostDashboard,
  handleOutpostInteraction,
  DASH_IDS,
  // exported so scheduler can also clean before sending overdue alerts
  cleanupOutpostStatusMessages,
};
