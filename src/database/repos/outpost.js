// Outpost checks repository (mirrors walls but separate tables)

const db = require('../connection');

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));
const all = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows || []))));

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS outpost_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT,
    interval_minutes INTEGER DEFAULT 30,
    last_notified_at INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS outpost_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord',
    status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'
  )`);
}

const getOutpostConfig = (guildId) =>
  get(`SELECT * FROM outpost_config WHERE guild_id = ?`, [guildId]);

const upsertOutpostConfig = ({ guild_id, channel_id = null, dashboard_message_id = null, interval_minutes = null, last_notified_at = null }) =>
  new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO outpost_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      if (channel_id !== null)          { sets.push(`channel_id = ?`); vals.push(channel_id); }
      if (dashboard_message_id !== null){ sets.push(`dashboard_message_id = ?`); vals.push(dashboard_message_id); }
      if (interval_minutes !== null)    { sets.push(`interval_minutes = ?`); vals.push(interval_minutes); }
      if (last_notified_at !== null)    { sets.push(`last_notified_at = ?`); vals.push(last_notified_at); }
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(`UPDATE outpost_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals, (e) => (e ? reject(e) : resolve()));
    });
  });

const insertOutpostCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) =>
  new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO outpost_checks (guild_id, discord_id, timestamp, source, status)
       VALUES (?, ?, ?, ?, ?)`,
      [guild_id, discord_id, timestamp, source, status],
      function (e) { return e ? reject(e) : resolve(this.lastID); }
    );
  });

const resetOutpostChecks = (guildId) => run(`DELETE FROM outpost_checks WHERE guild_id = ?`, [guildId]);

const getOutpostLastCheck = (guildId) =>
  get(`SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`, [guildId]);

const getOutpostRecentChecks = (guildId, limit = 5) =>
  all(`SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`, [guildId, limit]);

const getOutpostLeaderboard = (guildId, sinceEpoch) =>
  all(
    `SELECT discord_id, COUNT(*) AS count
     FROM outpost_checks
     WHERE guild_id = ? AND timestamp >= ? AND status = 'clear'
     GROUP BY discord_id
     ORDER BY count DESC
     LIMIT 10`,
    [guildId, sinceEpoch]
  );

const updateOutpostLastNotified = (guildId, ts) =>
  run(`UPDATE outpost_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId]);

module.exports = {
  ensureSchema,
  // config
  getOutpostConfig,
  upsertOutpostConfig,
  updateOutpostLastNotified,
  // checks
  insertOutpostCheck,
  resetOutpostChecks,
  getOutpostLastCheck,
  getOutpostRecentChecks,
  getOutpostLeaderboard,
};
