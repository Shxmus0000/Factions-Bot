// src/discord/panels/config/actions.js
const {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const IDS = require('./ids');
const { buildMainEmbed } = require('./builders');

const {
  // guild
  getGuildConfig, upsertGuildConfig,
  // walls
  getConfig, upsertConfig, resetWallChecks,
  // outpost
  getOutpostConfig, upsertOutpostConfig, resetOutpostChecks,
  // shard trackers
  getShardConfig, upsertShardConfig,
  getRpostShardConfig, upsertRpostShardConfig,
  // alt manager
  getAltManagerConfig, upsertAltManagerConfig,
  // alts
  listAlts,
} = require('../../../database');

// =====================================================================================
// INTERNAL HELPERS
// =====================================================================================

async function createTextChannel(guild, name, reason) {
  try { await guild.channels.fetch(); } catch {}
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === name);
  if (existing) return existing;

  try {
    const ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      reason: reason || `Auto-create required channel: ${name}`,
    });
    console.log(`[ensure] created #${name} with type=GuildText in ${guild.name}`);
    return ch;
  } catch (e1) {
    console.warn(`[ensure] create #${name} with type failed in ${guild.name}: ${e1.message}`);
    try {
      const ch = await guild.channels.create({
        name,
        reason: reason || `Auto-create required channel: ${name}`,
      });
      console.log(`[ensure] created #${name} (fallback no type) in ${guild.name}`);
      return ch;
    } catch (e2) {
      console.error(`[ensure] FAILED to create #${name} in ${guild.name}: ${e2.message}`);
      throw e2;
    }
  }
}

/**
 * If DB has a channel id and it exists+is text, use it.
 * If DB has id but channel missing/invalid, create defaultName and save(id).
 * If DB lacks id, ensure defaultName and save(id).
 */
async function ensureDbBackedChannel(guild, dbChannelId, defaultName, save) {
  try { await guild.channels.fetch(); } catch {}

  if (dbChannelId) {
    const byId = guild.channels.cache.get(dbChannelId) ||
                 await guild.channels.fetch(dbChannelId).catch(() => null);
    if (byId && byId.type === ChannelType.GuildText) {
      return byId;
    }
    // Channel missing ⇒ create default + update DB
    const ch = await createTextChannel(guild, defaultName);
    await save(ch.id);
    return ch;
  } else {
    let ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === defaultName);
    if (!ch) ch = await createTextChannel(guild, defaultName);
    await save(ch.id);
    return ch;
  }
}

// =====================================================================================
// REPAIR STEP: clean DB references that point to deleted channels/messages
// =====================================================================================

async function repairGuildChannelBindings(guild) {
  try { await guild.channels.fetch(); } catch {}

  // --- Guild-level config ---
  const gcfg = await getGuildConfig(guild.id).catch(() => null);

  // Helper to null an id in DB if its channel doesn't exist
  const fixChannel = async (label, id, save) => {
    if (!id) return;
    const ch = guild.channels.cache.get(id) ||
               await guild.channels.fetch(id).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) {
      console.log(`[repair] ${label}: channel ${id} missing/invalid in ${guild.name} -> nulling in DB`);
      await save(null);
    }
  };

  // guild-level channels
  await fixChannel('config_panel_channel_id',
    gcfg?.config_panel_channel_id,
    async (val) => upsertGuildConfig({ guild_id: guild.id, config_panel_channel_id: val })
  );
  await fixChannel('raid_alerts_channel_id',
    gcfg?.raid_alerts_channel_id,
    async (val) => upsertGuildConfig({ guild_id: guild.id, raid_alerts_channel_id: val })
  );
  await fixChannel('outpost_alerts_channel_id',
    gcfg?.outpost_alerts_channel_id,
    async (val) => upsertGuildConfig({ guild_id: guild.id, outpost_alerts_channel_id: val })
  );

  // If raid is valid but outpost alert channel is missing/invalid,
  // mirror outpost → raid (single alerts channel policy).
  if (gcfg?.raid_alerts_channel_id) {
    const raidChan = guild.channels.cache.get(gcfg.raid_alerts_channel_id) ||
                     await guild.channels.fetch(gcfg.raid_alerts_channel_id).catch(() => null);
    const outpChan = gcfg?.outpost_alerts_channel_id
      ? (guild.channels.cache.get(gcfg.outpost_alerts_channel_id) ||
         await guild.channels.fetch(gcfg.outpost_alerts_channel_id).catch(() => null))
      : null;

    if (raidChan && raidChan.type === ChannelType.GuildText &&
        (!outpChan || outpChan.type !== ChannelType.GuildText || outpChan.id !== raidChan.id)) {
      console.log('[repair] syncing outpost_alerts_channel_id to raid_alerts_channel_id');
      await upsertGuildConfig({
        guild_id: guild.id,
        outpost_alerts_channel_id: raidChan.id,
      });
    }
  }

  // panel message may point to deleted channel/message; we’ll re-send anyway,
  // but clear message id so we don’t try to edit a ghost
  if (gcfg?.config_panel_message_id) {
    console.log('[repair] clearing config_panel_message_id');
    await upsertGuildConfig({ guild_id: guild.id, config_panel_message_id: null });
  }

  // --- Walls ---
  const wcfg = await getConfig(guild.id).catch(() => null);
  await fixChannel('walls.channel_id',
    wcfg?.channel_id,
    async (val) => upsertConfig({ guild_id: guild.id, channel_id: val })
  );
  if (wcfg?.dashboard_message_id) {
    console.log('[repair] clearing walls.dashboard_message_id');
    await upsertConfig({ guild_id: guild.id, dashboard_message_id: null });
  }

  // --- Outpost ---
  const ocfg = await getOutpostConfig(guild.id).catch(() => null);
  await fixChannel('outpost.channel_id',
    ocfg?.channel_id,
    async (val) => upsertOutpostConfig({ guild_id: guild.id, channel_id: val })
  );
  if (ocfg?.dashboard_message_id) {
    console.log('[repair] clearing outpost.dashboard_message_id');
    await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: null });
  }

  // --- Alt Manager ---
  const acfg = await getAltManagerConfig(guild.id).catch(() => null);
  await fixChannel('altManager.channel_id',
    acfg?.channel_id,
    async (val) => upsertAltManagerConfig({ guild_id: guild.id, channel_id: val })
  );
  if (acfg?.dashboard_message_id) {
    console.log('[repair] clearing altManager.dashboard_message_id');
    await upsertAltManagerConfig({ guild_id: guild.id, dashboard_message_id: null });
  }

  // --- Shard Tracker ---
  const scfg = await getShardConfig(guild.id).catch(() => null);
  await fixChannel('shard.channel_id',
    scfg?.channel_id,
    async (val) => upsertShardConfig({ guild_id: guild.id, channel_id: val })
  );

  // --- Rpost Tracker ---
  const rcfg = await getRpostShardConfig(guild.id).catch(() => null);
  await fixChannel('rpost.channel_id',
    rcfg?.channel_id,
    async (val) => upsertRpostShardConfig({ guild_id: guild.id, channel_id: val })
  );

  // Done. Subsequent ensure* calls will recreate anything that was nulled.
}

// =====================================================================================
// ENSURE HELPERS (channels & dashboards)
// =====================================================================================

async function ensurePanelChannel(guild) {
  const gcfg = await getGuildConfig(guild.id).catch(() => null);
  const ch = await ensureDbBackedChannel(
    guild,
    gcfg?.config_panel_channel_id || null,
    'bot-config',
    async (id) => upsertGuildConfig({ guild_id: guild.id, config_panel_channel_id: id })
  );
  return ch;
}

async function ensureWallChannelAndDashboard(guild) {
  const { ensureDashboard } = require('../../dashboards/wallCheckBoard');
  const wcfg = await getConfig(guild.id).catch(() => null);

  const ch = await ensureDbBackedChannel(
    guild,
    wcfg?.channel_id || null,
    'buffer-checks',
    async (id) => upsertConfig({ guild_id: guild.id, channel_id: id, interval_minutes: wcfg?.interval_minutes ?? 30 })
  );

  const msg = await ensureDashboard(guild, ch.id);
  await upsertConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
  return ch;
}

async function ensureOutpostChannelAndDashboard(guild) {
  const { ensureOutpostDashboard } = require('../../dashboards/outpostBoard');
  const ocfg = await getOutpostConfig(guild.id).catch(() => null);

  const ch = await ensureDbBackedChannel(
    guild,
    ocfg?.channel_id || null,
    'rpost-checks',
    async (id) => upsertOutpostConfig({ guild_id: guild.id, channel_id: id, interval_minutes: ocfg?.interval_minutes ?? 30 })
  );

  const msg = await ensureOutpostDashboard(guild, ch.id);
  await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
  return ch;
}

async function ensureAltManagerChannelAndDashboard(guild) {
  let impl = null;
  try { impl = require('../../dashboards/altManager'); } catch { return null; }
  const { ensureAltManagerDashboard } = impl;

  const acfg = await getAltManagerConfig(guild.id).catch(() => null);

  const ch = await ensureDbBackedChannel(
    guild,
    acfg?.channel_id || null,
    'alt-manager',
    async (id) => upsertAltManagerConfig({ guild_id: guild.id, channel_id: id })
  );

  const msg = await ensureAltManagerDashboard(guild, ch.id);
  await upsertAltManagerConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
  return ch;
}

async function ensureShardTrackerDefaults(guild) {
  const scfg = await getShardConfig(guild.id).catch(() => null);

  const ch = await ensureDbBackedChannel(
    guild,
    scfg?.channel_id || null,
    'shard-tracker',
    async (id) => upsertShardConfig({
      guild_id: guild.id,
      channel_id: id,
      interval_minutes: scfg?.interval_minutes ?? 5,
      enabled: scfg?.enabled ?? 0,
    })
  );

  return ch;
}

async function ensureRpostTrackerDefaults(guild) {
  const rcfg = await getRpostShardConfig(guild.id).catch(() => null);

  const ch = await ensureDbBackedChannel(
    guild,
    rcfg?.channel_id || null,
    'rpost-tracker',
    async (id) => upsertRpostShardConfig({
      guild_id: guild.id,
      channel_id: id,
      interval_minutes: rcfg?.interval_minutes ?? 5,
      enabled: rcfg?.enabled ?? 0,
    })
  );

  return ch;
}

/**
 * Ensure player alerts channels for shard + rpost exist and are stored in DB.
 * These are used by the shard/rpost trackers for whitelist alerts.
 */
async function ensurePlayerAlertChannels(guild) {
  const scfg = await getShardConfig(guild.id).catch(() => null);
  const rcfg = await getRpostShardConfig(guild.id).catch(() => null);

  const shardAlerts = await ensureDbBackedChannel(
    guild,
    scfg?.shard_player_alert_channel_id || null,
    'shard-player-alerts',
    async (id) => upsertShardConfig({
      guild_id: guild.id,
      shard_player_alert_channel_id: id,
    })
  );

  const rpostAlerts = await ensureDbBackedChannel(
    guild,
    rcfg?.rpost_player_alert_channel_id || null,
    'rpost-player-alerts',
    async (id) => upsertRpostShardConfig({
      guild_id: guild.id,
      rpost_player_alert_channel_id: id,
    })
  );

  return { shardAlerts, rpostAlerts };
}

/**
 * IMPORTANT: Single alerts channel for BOTH base + outpost (your requirement).
 * We create/keep only #raid-alerts and write its ID to BOTH fields.
 */
async function setDefaultAlertChannels(guild) {
  const gcfg = await getGuildConfig(guild.id).catch(() => null);

  // Ensure raid-alerts exists or is created
  const raid = await ensureDbBackedChannel(
    guild,
    gcfg?.raid_alerts_channel_id || null,
    'raid-alerts',
    async (id) => upsertGuildConfig({ guild_id: guild.id, raid_alerts_channel_id: id })
  );

  // Always mirror outpost alert channel to the SAME ID as raid
  await upsertGuildConfig({
    guild_id: guild.id,
    outpost_alerts_channel_id: raid.id,
  });

  // DO NOT create a separate #outpost-alerts anymore.
  return { raid };
}

// =====================================================================================
// PANEL RENDERING
// =====================================================================================

async function ensurePanel(guild) {
  const channel = await ensurePanelChannel(guild);
  const gcfg = await getGuildConfig(guild.id).catch(() => null);

  const { embed, components } = await buildMainEmbed(guild);

  if (gcfg?.config_panel_message_id) {
    try {
      const msg = await channel.messages.fetch(gcfg.config_panel_message_id);
      if (msg?.author?.id === guild.client.user.id) {
        await msg.edit({ embeds: [embed], components });
        return msg;
      }
    } catch {}
  }

  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find(m => m.author?.id === guild.client.user.id && m.embeds?.[0]?.title === '⚙️ Bot Configuration');
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      await upsertGuildConfig({ guild_id: guild.id, config_panel_message_id: existing.id });
      return existing;
    }
  } catch {}

  const sent = await channel.send({ embeds: [embed], components });
  try { await sent.pin().catch(() => {}); } catch {}
  await upsertGuildConfig({ guild_id: guild.id, config_panel_message_id: sent.id });
  return sent;
}

// =====================================================================================
// INTERACTION HANDLING
// =====================================================================================

async function handleInteraction(interaction) {
  const guild = interaction.guild;
  if (!guild) return false;

  // BUTTONS → open submenus / perform actions
  if (interaction.isButton()) {
    switch (interaction.customId) {
      // ------ MAIN NAV ------
      case IDS.BTN_REFRESH: {
        const { embed, components } = await buildMainEmbed(guild);
        await interaction.update({ content: '', embeds: [embed], components });
        return true;
      }
      case IDS.BTN_BACK_MAIN: {
        const { embed, components } = await buildMainEmbed(guild);
        await interaction.update({ content: '', embeds: [embed], components });
        return true;
      }

      // ------ WALLS MENU ------
      case IDS.BTN_BUFFER_MENU: {
        const rows = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_RAID_CHAN).setStyle(ButtonStyle.Secondary).setLabel('Set Raid Alerts Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_WALL_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Wall Dashboard Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_INTERVAL_WEEWOO).setStyle(ButtonStyle.Secondary).setLabel('Weewoo Ping Interval'),
          new ButtonBuilder().setCustomId(IDS.BTN_INTERVAL_WALLS).setStyle(ButtonStyle.Secondary).setLabel('Wall Check Interval'),
        );
        const ctrl = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_START_WEEWOO).setStyle(ButtonStyle.Success).setLabel('Start Alerts'),
          new ButtonBuilder().setCustomId(IDS.BTN_STOP_WEEWOO).setStyle(ButtonStyle.Danger).setLabel('Stop Alerts'),
          new ButtonBuilder().setCustomId(IDS.BTN_RESET_WALLS).setStyle(ButtonStyle.Danger).setLabel('Reset Wall Checks'),
          new ButtonBuilder().setCustomId(IDS.BTN_BACK_MAIN).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        );
        await interaction.update({ content: '**Walls / Buffer — Configure**', embeds: [], components: [rows, ctrl] });
        return true;
      }

      // ------ OUTPOST MENU ------
      case IDS.BTN_OUTPOST_MENU: {
        const rows = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_ALERT_CHAN).setStyle(ButtonStyle.Secondary).setLabel('Set Outpost Alerts Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Outpost Dashboard Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_INTERVAL_WEEWOO).setStyle(ButtonStyle.Secondary).setLabel('Weewoo Ping Interval'),
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_INTERVAL).setStyle(ButtonStyle.Secondary).setLabel('Outpost Check Interval'),
        );
        const ctrl = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_START).setStyle(ButtonStyle.Success).setLabel('Start Alerts'),
          new ButtonBuilder().setCustomId(IDS.BTN_OUTPOST_STOP).setStyle(ButtonStyle.Danger).setLabel('Stop Alerts'),
          new ButtonBuilder().setCustomId(IDS.BTN_RESET_OUTPOST).setStyle(ButtonStyle.Danger).setLabel('Reset Outpost Checks'),
          new ButtonBuilder().setCustomId(IDS.BTN_BACK_MAIN).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        );
        await interaction.update({ content: '**Outpost — Configure**', embeds: [], components: [rows, ctrl] });
        return true;
      }

      // ------ SHARD MENU ------
      case IDS.BTN_SHARD_MENU: {
        const rows = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Shard Tracker Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_ALERT_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Player Alerts Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_INTERVAL).setStyle(ButtonStyle.Secondary).setLabel('Set Shard Interval'),
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_ASSIGN_ALT).setStyle(ButtonStyle.Secondary).setLabel('Assign Checker Alt'),
        );
        const ctrl = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_START).setStyle(ButtonStyle.Success).setLabel('Enable Shard Tracker'),
          new ButtonBuilder().setCustomId(IDS.BTN_SHARD_STOP).setStyle(ButtonStyle.Danger).setLabel('Disable Shard Tracker'),
          new ButtonBuilder().setCustomId(IDS.BTN_BACK_MAIN).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        );
        await interaction.update({ content: '**Shard Tracker — Configure**', embeds: [], components: [rows, ctrl] });
        return true;
      }

      // ------ RPOST MENU ------
      case IDS.BTN_RPOST_MENU: {
        const rows = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Rpost Tracker Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_ALERT_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Player Alerts Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_INTERVAL).setStyle(ButtonStyle.Secondary).setLabel('Set Rpost Interval'),
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_ASSIGN_ALT).setStyle(ButtonStyle.Secondary).setLabel('Assign Checker Alt'),
        );
        const ctrl = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_START).setStyle(ButtonStyle.Success).setLabel('Enable Rpost Tracker'),
          new ButtonBuilder().setCustomId(IDS.BTN_RPOST_STOP).setStyle(ButtonStyle.Danger).setLabel('Disable Rpost Tracker'),
          new ButtonBuilder().setCustomId(IDS.BTN_BACK_MAIN).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        );
        await interaction.update({ content: '**Rpost Tracker — Configure**', embeds: [], components: [rows, ctrl] });
        return true;
      }

      // ------ ALT MANAGER MENU ------
      case IDS.BTN_ALTMGR_MENU: {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(IDS.BTN_ALTMGR_CHANNEL).setStyle(ButtonStyle.Secondary).setLabel('Set Alt Manager Channel'),
          new ButtonBuilder().setCustomId(IDS.BTN_BACK_MAIN).setStyle(ButtonStyle.Secondary).setLabel('Back'),
        );
        await interaction.update({ content: '**Alt Manager — Configure**', embeds: [], components: [row] });
        return true;
      }

      // ------ Toggle + Reset actions ------
      case IDS.BTN_START_WEEWOO:
        await upsertGuildConfig({ guild_id: guild.id, base_alerts_paused: 0, weewoo_active: 1, weewoo_last_ping_at: 0 });
        return updateMain(interaction, guild, '✅ Buffer alerts started.');

      case IDS.BTN_STOP_WEEWOO:
        await upsertGuildConfig({ guild_id: guild.id, weewoo_active: 0 });
        return updateMain(interaction, guild, '⏸️ Buffer alerts stopped.');

      case IDS.BTN_RESET_WALLS:
        await resetWallChecks(guild.id);
        await upsertConfig({ guild_id: guild.id, last_notified_at: 0 });
        return updateMain(interaction, guild, '✅ Wall checks reset.');

      case IDS.BTN_OUTPOST_START:
        await upsertGuildConfig({ guild_id: guild.id, outpost_alerts_paused: 0, outpost_weewoo_active: 1, outpost_weewoo_last_ping_at: 0 });
        return updateMain(interaction, guild, '✅ Outpost alerts started.');

      case IDS.BTN_OUTPOST_STOP:
        await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_active: 0 });
        return updateMain(interaction, guild, '⏸️ Outpost alerts stopped.');

      case IDS.BTN_RESET_OUTPOST:
        await resetOutpostChecks(guild.id);
        await upsertOutpostConfig({ guild_id: guild.id, last_notified_at: 0 });
        return updateMain(interaction, guild, '✅ Outpost checks reset.');

      case IDS.BTN_SHARD_START:
        await upsertShardConfig({ guild_id: guild.id, enabled: 1, last_run_at: 0 });
        return updateMain(interaction, guild, '✅ Shard tracker enabled.');

      case IDS.BTN_SHARD_STOP:
        await upsertShardConfig({ guild_id: guild.id, enabled: 0 });
        return updateMain(interaction, guild, '⏸️ Shard tracker disabled.');

      case IDS.BTN_RPOST_START:
        await upsertRpostShardConfig({ guild_id: guild.id, enabled: 1, last_run_at: 0 });
        return updateMain(interaction, guild, '✅ Rpost tracker enabled.');

      case IDS.BTN_RPOST_STOP:
        await upsertRpostShardConfig({ guild_id: guild.id, enabled: 0 });
        return updateMain(interaction, guild, '⏸️ Rpost tracker disabled.');
    }

    // Interval pickers
    if (interaction.customId === IDS.BTN_INTERVAL_WEEWOO) {
      const row = pickerIntervals(IDS.PICK_INTERVAL_WEEWOO, [1,2,3,5,10,15,30,45,60]);
      await interaction.update({ content: 'Choose **Weewoo** interval:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_INTERVAL_WALLS) {
      const row = pickerIntervals(IDS.PICK_INTERVAL_WALLS, [5,10,15,20,30,45,60]);
      await interaction.update({ content: 'Choose **Wall/Buffer** check interval:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_OUTPOST_INTERVAL_WEEWOO) {
      const row = pickerIntervals(IDS.PICK_OUTPOST_INTERVAL_WEEWOO, [1,2,3,5,10,15,30]);
      await interaction.update({ content: 'Choose **Outpost Weewoo** interval:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_OUTPOST_INTERVAL) {
      const row = pickerIntervals(IDS.PICK_OUTPOST_INTERVAL, [5,10,15,20,30,45,60]);
      await interaction.update({ content: 'Choose **Outpost** check interval:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_SHARD_INTERVAL) {
      const row = pickerIntervals(IDS.PICK_SHARD_INTERVAL, [1,2,3,5,10,15]);
      await interaction.update({ content: 'Choose **Shard tracker** interval:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_RPOST_INTERVAL) {
      const row = pickerIntervals(IDS.PICK_RPOST_INTERVAL, [1,2,3,5,10,15]);
      await interaction.update({ content: 'Choose **Rpost tracker** interval:', embeds: [], components: [row] });
      return true;
    }

    // Channel pickers
    if (interaction.customId === IDS.BTN_RAID_CHAN) {
      const row = await pickerChannels(guild, IDS.PICK_RAID);
      await interaction.update({ content: 'Pick the **Raid Alerts** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_WALL_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_WALL_CHANNEL);
      await interaction.update({ content: 'Pick the **Wall Dashboard** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_OUTPOST_ALERT_CHAN) {
      const row = await pickerChannels(guild, IDS.PICK_OUTPOST_ALERT);
      await interaction.update({ content: 'Pick the **Outpost Alerts** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_OUTPOST_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_OUTPOST_CHANNEL);
      await interaction.update({ content: 'Pick the **Outpost Dashboard** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_SHARD_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_SHARD_CHANNEL);
      await interaction.update({ content: 'Pick the **Shard Tracker** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_SHARD_ALERT_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_SHARD_ALERT_CHANNEL);
      await interaction.update({ content: 'Pick the **Shard Player Alerts** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_RPOST_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_RPOST_CHANNEL);
      await interaction.update({ content: 'Pick the **Rpost Tracker** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_RPOST_ALERT_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_RPOST_ALERT_CHANNEL);
      await interaction.update({ content: 'Pick the **Rpost Player Alerts** channel:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_ALTMGR_CHANNEL) {
      const row = await pickerChannels(guild, IDS.PICK_ALTMGR_CHANNEL);
      await interaction.update({ content: 'Pick the **Alt Manager** channel:', embeds: [], components: [row] });
      return true;
    }

    // Alt pickers
    if (interaction.customId === IDS.BTN_SHARD_ASSIGN_ALT) {
      const row = await pickerAlts(guild, IDS.PICK_SHARD_ALT);
      await interaction.update({ content: 'Pick the **Shard Checker** alt:', embeds: [], components: [row] });
      return true;
    }
    if (interaction.customId === IDS.BTN_RPOST_ASSIGN_ALT) {
      const row = await pickerAlts(guild, IDS.PICK_RPOST_ALT);
      await interaction.update({ content: 'Pick the **Rpost Checker** alt:', embeds: [], components: [row] });
      return true;
    }

    return false;
  }

  // SELECT MENUS → save choice & go back to main panel
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    // Intervals
    if (id === IDS.PICK_INTERVAL_WEEWOO) {
      const v = parseInt(interaction.values?.[0] || '2', 10);
      await upsertGuildConfig({ guild_id: guild.id, weewoo_ping_interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Weewoo interval saved.');
    }
    if (id === IDS.PICK_INTERVAL_WALLS) {
      const v = parseInt(interaction.values?.[0] || '30', 10);
      await upsertConfig({ guild_id: guild.id, interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Wall check interval saved.');
    }
    if (id === IDS.PICK_OUTPOST_INTERVAL_WEEWOO) {
      const v = parseInt(interaction.values?.[0] || '2', 10);
      await upsertGuildConfig({ guild_id: guild.id, outpost_weewoo_ping_interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Outpost Weewoo interval saved.');
    }
    if (id === IDS.PICK_OUTPOST_INTERVAL) {
      const v = parseInt(interaction.values?.[0] || '30', 10);
      await upsertOutpostConfig({ guild_id: guild.id, interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Outpost check interval saved.');
    }
    if (id === IDS.PICK_SHARD_INTERVAL) {
      const v = parseInt(interaction.values?.[0] || '5', 10);
      await upsertShardConfig({ guild_id: guild.id, interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Shard tracker interval saved.');
    }
    if (id === IDS.PICK_RPOST_INTERVAL) {
      const v = parseInt(interaction.values?.[0] || '5', 10);
      await upsertRpostShardConfig({ guild_id: guild.id, interval_minutes: v });
      return updateMain(interaction, guild, '⏱️ Rpost tracker interval saved.');
    }

    // Channel saves (+dashboard re-seed where relevant)

    // Single alerts channel for both base + outpost
    if (id === IDS.PICK_RAID) {
      const cid = interaction.values?.[0];
      await upsertGuildConfig({ guild_id: guild.id, raid_alerts_channel_id: cid, outpost_alerts_channel_id: cid });
      return updateMain(interaction, guild, '✅ Raid/outpost alerts channel saved.');
    }
    if (id === IDS.PICK_WALL_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertConfig({ guild_id: guild.id, channel_id: cid, dashboard_message_id: null });
      const { ensureDashboard } = require('../../dashboards/wallCheckBoard');
      const msg = await ensureDashboard(guild, cid);
      await upsertConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
      return updateMain(interaction, guild, '✅ Wall dashboard channel saved.');
    }
    if (id === IDS.PICK_OUTPOST_ALERT) {
      const cid = interaction.values?.[0];
      await upsertGuildConfig({ guild_id: guild.id, raid_alerts_channel_id: cid, outpost_alerts_channel_id: cid });
      return updateMain(interaction, guild, '✅ Outpost alerts channel saved (same as raid alerts).');
    }
    if (id === IDS.PICK_OUTPOST_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertOutpostConfig({ guild_id: guild.id, channel_id: cid, dashboard_message_id: null });
      const { ensureOutpostDashboard } = require('../../dashboards/outpostBoard');
      const msg = await ensureOutpostDashboard(guild, cid);
      await upsertOutpostConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
      return updateMain(interaction, guild, '✅ Outpost dashboard channel saved.');
    }
    if (id === IDS.PICK_SHARD_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertShardConfig({ guild_id: guild.id, channel_id: cid });
      return updateMain(interaction, guild, '✅ Shard tracker channel saved.');
    }
    if (id === IDS.PICK_SHARD_ALERT_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertShardConfig({ guild_id: guild.id, shard_player_alert_channel_id: cid });
      return updateMain(interaction, guild, '✅ Shard player alerts channel saved.');
    }
    if (id === IDS.PICK_RPOST_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertRpostShardConfig({ guild_id: guild.id, channel_id: cid });
      return updateMain(interaction, guild, '✅ Rpost tracker channel saved.');
    }
    if (id === IDS.PICK_RPOST_ALERT_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertRpostShardConfig({ guild_id: guild.id, rpost_player_alert_channel_id: cid });
      return updateMain(interaction, guild, '✅ Rpost player alerts channel saved.');
    }
    if (id === IDS.PICK_ALTMGR_CHANNEL) {
      const cid = interaction.values?.[0];
      await upsertAltManagerConfig({ guild_id: guild.id, channel_id: cid, dashboard_message_id: null });
      try {
        const { ensureAltManagerDashboard } = require('../../dashboards/altManager');
        const msg = await ensureAltManagerDashboard(guild, cid);
        await upsertAltManagerConfig({ guild_id: guild.id, dashboard_message_id: msg.id });
      } catch {}
      return updateMain(interaction, guild, '✅ Alt Manager channel saved.');
    }

    // Alt assignment
    if (id === IDS.PICK_SHARD_ALT) {
      const altId = Number(interaction.values?.[0] || 0);
      if (altId) {
        await upsertGuildConfig({ guild_id: guild.id, shard_checker_alt_id: altId });
        return updateMain(interaction, guild, '✅ Assigned Shard checker alt.');
      }
      await interaction.reply({ content: 'Pick an alt first.', ephemeral: true });
      return true;
    }
    if (id === IDS.PICK_RPOST_ALT) {
      const altId = Number(interaction.values?.[0] || 0);
      if (altId) {
        await upsertGuildConfig({ guild_id: guild.id, rpost_checker_alt_id: altId });
        return updateMain(interaction, guild, '✅ Assigned Rpost checker alt.');
      }
      await interaction.reply({ content: 'Pick an alt first.', ephemeral: true });
      return true;
    }

    return false;
  }

  return false;
}

// =====================================================================================
// MISC HELPERS
// =====================================================================================

async function updateMain(interaction, guild, msg) {
  const { embed, components } = await buildMainEmbed(guild);
  await interaction.update({ content: msg || '', embeds: [embed], components });
  return true;
}

function pickerIntervals(customId, values) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select an interval…')
      .addOptions(values.map(v =>
        new StringSelectMenuOptionBuilder().setLabel(`${v} minute${v === 1 ? '' : 's'}`).setValue(String(v))
      ))
  );
}

async function pickerChannels(guild, customId) {
  const chans = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText && c.viewable && !c.isThread())
    .sort((a, b) => a.name.localeCompare(b.name));

  const options = chans.map(c => new StringSelectMenuOptionBuilder().setLabel(`#${c.name}`).setValue(c.id));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select a channel…')
      .addOptions(options.slice(0, 25))
  );
}

async function pickerAlts(guild, customId) {
  const alts = await listAlts(guild.id);
  const options = alts.length
    ? alts.slice(0, 25).map(a => new StringSelectMenuOptionBuilder().setLabel(a.label).setValue(String(a.id)))
    : [new StringSelectMenuOptionBuilder().setLabel('No alts found').setValue('0')];

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select an alt…')
      .addOptions(options)
  );
}

module.exports = {
  // repair
  repairGuildChannelBindings,

  // ensure helpers
  ensurePanelChannel,
  ensureWallChannelAndDashboard,
  ensureOutpostChannelAndDashboard,
  ensureAltManagerChannelAndDashboard,
  ensureShardTrackerDefaults,
  ensureRpostTrackerDefaults,
  ensurePlayerAlertChannels,     // 👈 NEW
  setDefaultAlertChannels,

  // panel + interaction
  ensurePanel,
  handleInteraction,

  // back-compat export so older imports still work
  handleConfigInteraction: handleInteraction,
};
