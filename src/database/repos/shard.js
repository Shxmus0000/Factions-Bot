// src/database/repos/shard.js
// Main shard tracker config stored in shard_config table.

const { db } = require('../connection');

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));

async function ensureSchema() {
  // Base table
  await run(`CREATE TABLE IF NOT EXISTS shard_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    interval_minutes INTEGER DEFAULT 5,
    enabled INTEGER DEFAULT 0,
    last_run_at INTEGER DEFAULT 0,
    previous_message_id TEXT
  )`);

  // In case table already existed without new columns, try to add them.
  await run(`ALTER TABLE shard_config ADD COLUMN last_run_at INTEGER DEFAULT 0`).catch(() => {});
  await run(`ALTER TABLE shard_config ADD COLUMN previous_message_id TEXT`).catch(() => {});
}

function getShardConfig(guildId) {
  return get(`SELECT * FROM shard_config WHERE guild_id = ?`, [guildId]);
}

function upsertShardConfig({
  guild_id,
  channel_id = null,
  interval_minutes = null,
  enabled = null,
  last_run_at = null,
  previous_message_id = null,
}) {
  return new Promise((resolve, reject) => {
    if (!guild_id) return reject(new Error('guild_id required'));

    db.run(`INSERT OR IGNORE INTO shard_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);

      const sets = [];
      const vals = [];

      if (channel_id !== null)          { sets.push(`channel_id = ?`);          vals.push(channel_id); }
      if (interval_minutes !== null)    { sets.push(`interval_minutes = ?`);    vals.push(interval_minutes); }
      if (enabled !== null)             { sets.push(`enabled = ?`);             vals.push(enabled); }
      if (last_run_at !== null)         { sets.push(`last_run_at = ?`);         vals.push(last_run_at); }
      if (previous_message_id !== null) { sets.push(`previous_message_id = ?`); vals.push(previous_message_id); }

      if (!sets.length) return resolve();

      vals.push(guild_id);
      db.run(
        `UPDATE shard_config SET ${sets.join(', ')} WHERE guild_id = ?`,
        vals,
        (e) => (e ? reject(e) : resolve())
      );
    });
  });
}

module.exports = {
  ensureSchema,
  getShardConfig,
  upsertShardConfig,
};
