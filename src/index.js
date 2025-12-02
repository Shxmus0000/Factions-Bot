// src/index.js
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');

// DB bootstrap
const { dbInit } = require('./database');

// Global interaction router
const interactionCreateHandler = require('./discord/handlers/interactionCreate');

// Alt runner (auto-login + world tracking)
const altRunner = require('./services/altRunner');

// Raid-alerts handler (webhook messages -> timezone pings)
const raidAlerts = require('./services/raidAlerts');

// Slash command registration
const { registerCommands } = require('./discord/registerCommands');

// Ensure channels/panels/dashboards
const {
  ensurePanelChannel,
  ensurePanel,
  ensureWallChannelAndDashboard,
  ensureOutpostChannelAndDashboard,
  ensureAltManagerChannelAndDashboard,
  ensureShardTrackerDefaults,
  ensureRpostTrackerDefaults,
  ensurePlayerAlertChannels,
  setDefaultAlertChannels,
} = require('./discord/panels/config/actions');

// Optional scheduler
let startScheduler = null;
try {
  ({ startScheduler } = require('./utils/scheduler'));
} catch {
  /* optional */
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // <-- IMPORTANT for raid alerts + embeds
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Initialize DB schema/migrations
  try {
    await dbInit();
  } catch (e) {
    console.error('[boot] DB init failed:', e);
  }

  // Auto-register slash commands
  try {
    await registerCommands();
  } catch (e) {
    console.error('⚠️ Failed to register slash commands:', e);
  }

  // Wire the central interaction router
  client.on(Events.InteractionCreate, (i) => interactionCreateHandler(client, i));

  // Let altRunner post to channels when needed
  try {
    altRunner.init(client);
  } catch {}

  // Raid alert listeners (messageCreate + messageUpdate)
  try {
    raidAlerts.init(client);
  } catch (e) {
    console.warn('[raidAlerts] init failed:', e);
  }

  // 🔔 When an alt’s world changes, refresh the Alt Manager dashboard
  altRunner.on('world-changed', async ({ guildId }) => {
    try {
      const guild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) return;
      await ensureAltManagerChannelAndDashboard(guild);
    } catch (e) {
      console.warn('[world-changed] refresh failed:', e?.message || e);
    }
  });

  // Seed every guild, then auto-start alts (sequentially)
  for (const [, guild] of client.guilds.cache) {
    try {
      await seedGuild(guild);
      await altRunner.startAllForGuild(guild.id);
    } catch (e) {
      console.error('[boot] guild seed/start failed:', e);
    }
  }

  // Start scheduler (if present)
  if (startScheduler) {
    try {
      startScheduler(client);
      console.log('⏱️ Scheduler started (10s tick).');
    } catch (e) {
      console.warn('⚠️ Scheduler failed to start:', e.message);
    }
  } else {
    console.warn('⚠️ Scheduler not started (utils/scheduler.js missing startScheduler).');
  }
});

/**
 * Ensure all required channels exist and corresponding embeds/dashboards are posted.
 */
async function seedGuild(guild) {
  console.log(`[boot] seeding guild: ${guild.name} (${guild.id})`);

  // Make sure channel cache is warm
  try {
    await guild.channels.fetch();
  } catch {}

  // A) Alerts channels default (raid-alerts for BOTH base & outpost)
  await setDefaultAlertChannels(guild);

  // B) Buffer/Wall dashboard channel + message
  await ensureWallChannelAndDashboard(guild);

  // C) Outpost dashboard channel + message
  await ensureOutpostChannelAndDashboard(guild);

  // D) Alt Manager channel + message
  await ensureAltManagerChannelAndDashboard(guild);

  // E) Default tracker output channels (no embed here, just defaults)
  await ensureShardTrackerDefaults(guild);
  await ensureRpostTrackerDefaults(guild);

  // F) Player alert channels for shard + rpost (auto-create + store IDs)
  await ensurePlayerAlertChannels(guild);

  // G) Bot config: ensure channel and panel (after everything else so it can display real #channels)
  await ensurePanelChannel(guild);
  await ensurePanel(guild);
}

client.login(process.env.DISCORD_TOKEN);
