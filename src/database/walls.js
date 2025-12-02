// ========================================
// File: src/database/walls.js
// ========================================
function init(db) {
  // wall_config
  db.run(`CREATE TABLE IF NOT EXISTS wall_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT,
    interval_minutes INTEGER DEFAULT 30,
    last_notified_at INTEGER DEFAULT 0
  )`);

  // wall_checks
  db.run(`CREATE TABLE IF NOT EXISTS wall_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source TEXT CHECK(source IN ('discord','ingame')) DEFAULT 'discord',
    status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'
  )`);

  // Add status column if missing (legacy)
  db.all(`PRAGMA table_info(wall_checks)`, (err, rows) => {
    if (err) return console.error('PRAGMA wall_checks failed:', err);
    const hasStatus = (rows || []).some(r => r.name === 'status');
    if (!hasStatus) {
      db.run(
        `ALTER TABLE wall_checks ADD COLUMN status TEXT CHECK(status IN ('clear','weewoo')) DEFAULT 'clear'`,
        e => { if (e && !String(e.message).includes('duplicate column name')) console.error('Add status (walls) failed:', e); }
      );
    }
  });
}

function bind(db) {
  module.exports.getConfig = (guildId) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM wall_config WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  module.exports.upsertConfig = ({ guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at }) => new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO wall_config (guild_id, channel_id, dashboard_message_id, interval_minutes, last_notified_at)
       VALUES (?, ?, ?, COALESCE(?, 30), COALESCE(?, 0))
       ON CONFLICT(guild_id) DO UPDATE SET
         channel_id = COALESCE(excluded.channel_id, wall_config.channel_id),
         dashboard_message_id = COALESCE(excluded.dashboard_message_id, wall_config.dashboard_message_id),
         interval_minutes = COALESCE(excluded.interval_minutes, wall_config.interval_minutes),
         last_notified_at = COALESCE(excluded.last_notified_at, wall_config.last_notified_at)`,
      [guild_id, channel_id || null, dashboard_message_id || null, interval_minutes, last_notified_at],
      (err) => err ? reject(err) : resolve()
    );
  });

  module.exports.insertWallCheck = ({ guild_id, discord_id, timestamp, source = 'discord', status = 'clear' }) => new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO wall_checks (guild_id, discord_id, timestamp, source, status) VALUES (?, ?, ?, ?, ?)`,
      [guild_id, discord_id, timestamp, source, status],
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });

  module.exports.resetWallChecks = (guildId) => new Promise((resolve, reject) => {
    db.run(`DELETE FROM wall_checks WHERE guild_id = ?`, [guildId], (err) => {
      if (err) reject(err); else resolve();
    });
  });

  module.exports.getLastCheck = (guildId) => new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [guildId],
      (err, row) => err ? reject(err) : resolve(row || null)
    );
  });

  module.exports.getRecentChecks = (guildId, limit = 5) => new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM wall_checks WHERE guild_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [guildId, limit],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });

  module.exports.getLeaderboard = (guildId, sinceEpoch) => new Promise((resolve, reject) => {
    db.all(
      `SELECT discord_id, COUNT(*) as count
       FROM wall_checks
       WHERE guild_id = ? AND timestamp >= ? AND status = 'clear'
       GROUP BY discord_id
       ORDER BY count DESC
       LIMIT 10`,
      [guildId, sinceEpoch],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });

  module.exports.updateLastNotified = (guildId, ts) => new Promise((resolve, reject) => {
    db.run(`UPDATE wall_config SET last_notified_at = ? WHERE guild_id = ?`, [ts, guildId],
      (err) => err ? reject(err) : resolve());
  });
}

module.exports = {
  __name: 'walls',
  init,
  bind,
};
