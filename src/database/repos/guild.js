// src/database/repos/guild.js
// Guild-level configuration (legacy repo; used only for schema in some setups)

const { db } = require('../connection'); // <-- FIX: get actual Database handle

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    -- Base (walls)
    raid_alerts_channel_id TEXT,
    weewoo_active INTEGER DEFAULT 0,
    weewoo_ping_interval_minutes INTEGER DEFAULT 2,
    weewoo_last_ping_at INTEGER DEFAULT 0,

    -- Outpost
    outpost_alerts_channel_id TEXT,
    outpost_weewoo_active INTEGER DEFAULT 0,
    outpost_weewoo_ping_interval_minutes INTEGER DEFAULT 2,
    outpost_weewoo_last_ping_at INTEGER DEFAULT 0,

    -- pause flags
    base_alerts_paused INTEGER DEFAULT 0,
    outpost_alerts_paused INTEGER DEFAULT 0,

    -- optional: bind checker alts
    shard_checker_alt_id INTEGER DEFAULT 0,
    rpost_checker_alt_id INTEGER DEFAULT 0,

    -- config panel tracking
    config_panel_channel_id TEXT,
    config_panel_message_id TEXT
  )`);
}

const getGuildConfig = (guildId) =>
  get(`SELECT * FROM guild_config WHERE guild_id = ?`, [guildId]);

const upsertGuildConfig = (fields) =>
  new Promise((resolve, reject) => {
    const { guild_id, ...data } = fields || {};
    if (!guild_id) return reject(new Error('guild_id required'));
    db.run(`INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [];
      const vals = [];
      Object.entries(data).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
          sets.push(`${k} = ?`);
          vals.push(v);
        }
      });
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(
        `UPDATE guild_config SET ${sets.join(', ')} WHERE guild_id = ?`,
        vals,
        (e) => (e ? reject(e) : resolve())
      );
    });
  });

module.exports = { ensureSchema, getGuildConfig, upsertGuildConfig };
