// src/database/repos/walls.js
// Walls / Buffer checks repository (legacy repo)

const { db } = require('../connection'); // <-- FIX: get actual Database handle

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));
const all = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows || []))));

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS wall_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT,
    interval_minutes INTEGER DEFAULT 30,
    last_notified_at INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS wall_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord',
    status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'
  )`);
}

const getWallConfig = (guildId) =>
  get(`SELECT * FROM wall_config WHERE guild_id = ?`, [guildId]);

// alias for legacy callers (getConfig)
const getConfig = getWallConfig;

const upsertWallConfig = ({ guild_id, channel_id = null, dashboard_message_id = null, interval_minutes = null, last_notified_at = null }) =>
  new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO wall_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      if (channel_id !== null)          { sets.push(`channel_id = ?`); vals.push(channel_id); }
      if (dashboard_message_id !== null){ sets.push(`dashboard_message_id = ?`); vals.push(dashboard_message_id); }
      if (interval_minutes !== null)    { sets.push(`interval_minutes = ?`); vals.push(interval_minutes); }
      if (last_notified_at !== null)    { sets.push(`last_notified_at = ?`); vals.push(last_notified_at); }
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(`UPDATE wall_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals, (e) => (e ? reject(e) : resolve()));
    });
  });

// alias for legacy callers (upsertConfig)
const upsertConfig = upsertWallConfig;

const insertWallCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) =>
  new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO wall_checks (guild_id, discord_id, timestamp, source, status)
       VALUES (?, ?, ?, ?, ?)`,
      [guild_id, discord_id, timestamp, source, status],
      function (e) { return e ? reject(e) : resolve(this.lastID); }
    );
  });

const resetWallChecks = (guildId) => run(`DELETE FROM wall_checks WHERE guild_id = ?`, [guildId]);

const getLastCheck = (guildId) =>
  get(`SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`, [guildId]);

const getRecentChecks = (guildId, limit = 5) =>
  all(`SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`, [guildId, limit]);

const getLeaderboard = (guildId, sinceEpoch) =>
  all(
    `SELECT discord_id, COUNT(*) AS count
     FROM wall_checks
     WHERE guild_id = ? AND timestamp >= ? AND status = 'clear'
     GROUP BY discord_id
     ORDER BY count DESC
     LIMIT 10`,
    [guildId, sinceEpoch]
  );

const updateLastNotified = (guildId, ts) =>
  run(`UPDATE wall_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId]);

module.exports = {
  ensureSchema,
  // config
  getWallConfig, getConfig,
  upsertWallConfig, upsertConfig,
  updateLastNotified,
  // checks
  insertWallCheck,
  resetWallChecks,
  getLastCheck,
  getRecentChecks,
  getLeaderboard,
};
