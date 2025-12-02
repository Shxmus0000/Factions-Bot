// ========================================
// File: src/database/outpost.js
// ========================================
function init(db) {
  db.run(`CREATE TABLE IF NOT EXISTS outpost_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT,
    interval_minutes INTEGER DEFAULT 30,
    last_notified_at INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS outpost_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord',
    status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'
  )`);
}

function bind(db) {
  module.exports.getOutpostConfig = (guildId) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM outpost_config WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  module.exports.upsertOutpostConfig = ({ guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at }) => new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO outpost_config (guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at)
       VALUES (?, ?, ?, COALESCE(?, 30), COALESCE(?, 0))
       ON CONFLICT(guild_id) DO UPDATE SET
         channel_id = COALESCE(excluded.channel_id, outpost_config.channel_id),
         dashboard_message_id = COALESCE(excluded.dashboard_message_id, outpost_config.dashboard_message_id),
         interval_minutes = COALESCE(excluded.interval_minutes, outpost_config.interval_minutes),
         last_notified_at = COALESCE(excluded.last_notified_at, outpost_config.last_notified_at)`,
      [guild_id, channel_id || null, dashboard_message_id || null, interval_minutes, last_notified_at],
      (err) => err ? reject(err) : resolve()
    );
  });

  module.exports.insertOutpostCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) => new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO outpost_checks (guild_id, discord_id, timestamp, source, status) VALUES (?, ?, ?, ?, ?)`,
      [guild_id, discord_id, timestamp, source, status],
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });

  module.exports.resetOutpostChecks = (guildId) => new Promise((resolve, reject) => {
    db.run(`DELETE FROM outpost_checks WHERE guild_id = ?`, [guildId], (err) => {
      if (err) reject(err); else resolve();
    });
  });

  module.exports.getOutpostLastCheck = (guildId) => new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [guildId],
      (err, row) => err ? reject(err) : resolve(row || null)
    );
  });

  module.exports.getOutpostRecentChecks = (guildId, limit = 5) => new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM outpost_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [guildId, limit],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });

  module.exports.getOutpostLeaderboard = (guildId, sinceEpoch) => new Promise((resolve, reject) => {
    db.all(
      `SELECT discord_id, COUNT(*) as count
       FROM outpost_checks
       WHERE guild_id = ? AND timestamp >= ?
       AND status = 'clear'
       GROUP BY discord_id
       ORDER BY count DESC
       LIMIT 10`,
      [guildId, sinceEpoch],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });

  module.exports.updateOutpostLastNotified = (guildId, ts) => new Promise((resolve, reject) => {
    db.run(`UPDATE outpost_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId],
      (err) => err ? reject(err) : resolve());
  });
}

module.exports = {
  __name: 'outpost',
  init,
  bind,
};
