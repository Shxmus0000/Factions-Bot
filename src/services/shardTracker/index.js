// ========================================
// Shard Tracker (MAIN)
// - Uses the alt assigned in guild_config.shard_checker_alt_id
// - Uses shared trackerCore to read tablist, resolve factions,
//   and post/update an embed in the shard tracker channel.
// ========================================
const {
  getShardConfig,
  upsertShardConfig,
  getGuildConfig,
} = require('../../database');

const { runOnceForGuild: runCore } = require('../trackerCore');

/**
 * Wrapper over trackerCore.
 * The scheduler calls this every N seconds; trackerCore itself
 * enforces interval + previous_message_id handling.
 */
async function runOnceForGuild(client, guildId) {
  return runCore(
    client,
    guildId,
    'shard',
    {
      getConfig: getShardConfig,
      upsertConfig: upsertShardConfig,
      getGuildConfig,
    },
    {
      titlePrefix: 'Shard Player Tracker',
      footerText: 'Factions Bot Shard Player Tracker',
      altField: 'shard_checker_alt_id',
    }
  );
}

module.exports = { runOnceForGuild };
