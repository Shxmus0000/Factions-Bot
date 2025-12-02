// ========================================
// Shard Tracker (RPOST variant)
// - Uses the alt assigned in guild_config.rpost_checker_alt_id
// - Uses shared trackerCore to read tablist, resolve factions,
//   and post/update an embed in the rpost tracker channel.
// ========================================
const {
  getRpostShardConfig,
  upsertRpostShardConfig,
  getGuildConfig,
} = require('../../database');

const { runOnceForGuild: runCore } = require('../trackerCore');

/**
 * Wrapper over trackerCore for rpost shard tracker.
 */
async function runOnceForGuild(client, guildId) {
  return runCore(
    client,
    guildId,
    'rpost',
    {
      getConfig: getRpostShardConfig,
      upsertConfig: upsertRpostShardConfig,
      getGuildConfig,
    },
    {
      titlePrefix: 'Outpost Player Tracker',
      footerText: 'Factions Bot Raiding Outpost Player Tracker',
      altField: 'rpost_checker_alt_id',
    }
  );
}

module.exports = { runOnceForGuild };
