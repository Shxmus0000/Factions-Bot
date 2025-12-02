// ========================================
// File: src/database/shard.js
// ========================================

function init(db) {
  // Shard tracker (main)
  db.run(`CREATE TABLE IF NOT EXISTS shard_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    enabled INTEGER DEFAULT 0,
    interval_minutes INTEGER DEFAULT 5,
    previous_message_id TEXT,
    last_run_at INTEGER DEFAULT 0
  )`);

  db.all(`PRAGMA table_info(shard_config)`, (err, rows) => {
    if (err) return console.error('PRAGMA shard_config failed:', err);
    const cols = new Set((rows || []).map(r => r.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) {
        db.run(`ALTER TABLE shard_config ADD COLUMN ${ddl}`, e => {
          if (e && !String(e.message).includes('duplicate column name')) {
            console.error(`Add shard_config.${name} failed:`, e);
          }
        });
      }
    };
    add('previous_message_id', 'previous_message_id TEXT');
    add('last_run_at', 'last_run_at INTEGER DEFAULT 0');
  });

  // Rpost shard tracker
  db.run(`CREATE TABLE IF NOT EXISTS rpost_shard_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    enabled INTEGER DEFAULT 0,
    interval_minutes INTEGER DEFAULT 5,
    previous_message_id TEXT,
    last_run_at INTEGER DEFAULT 0
  )`);

  db.all(`PRAGMA table_info(rpost_shard_config)`, (err, rows) => {
    if (err) return console.error('PRAGMA rpost_shard_config failed:', err);
    const cols = new Set((rows || []).map(r => r.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) {
        db.run(`ALTER TABLE rpost_shard_config ADD COLUMN ${ddl}`, e => {
          if (e && !String(e.message).includes('duplicate column name')) {
            console.error(`Add rpost_shard_config.${name} failed:`, e);
          }
        });
      }
    };
    add('previous_message_id', 'previous_message_id TEXT');
    add('last_run_at', 'last_run_at INTEGER DEFAULT 0');
  });
}

function bind(db) {
  // main
  module.exports.getShardConfig = (guildId) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM shard_config WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  module.exports.upsertShardConfig = ({
    guild_id,
    channel_id = null,
    enabled = null,
    interval_minutes = null,
    previous_message_id = null,
    last_run_at = null
  }) => new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO shard_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };
      push(channel_id !== null,          `channel_id = ?`, channel_id);
      push(enabled !== null,             `enabled = ?`, enabled);
      push(interval_minutes !== null,    `interval_minutes = ?`, interval_minutes);
      push(previous_message_id !== null, `previous_message_id = ?`, previous_message_id);
      push(last_run_at !== null,         `last_run_at = ?`, last_run_at);
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(`UPDATE shard_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
        (updErr) => updErr ? reject(updErr) : resolve());
    });
  });

  // rpost
  module.exports.getRpostShardConfig = (guildId) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM rpost_shard_config WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  module.exports.upsertRpostShardConfig = ({
    guild_id,
    channel_id = null,
    enabled = null,
    interval_minutes = null,
    previous_message_id = null,
    last_run_at = null
  }) => new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO rpost_shard_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };
      push(channel_id !== null,          `channel_id = ?`, channel_id);
      push(enabled !== null,             `enabled = ?`, enabled);
      push(interval_minutes !== null,    `interval_minutes = ?`, interval_minutes);
      push(previous_message_id !== null, `previous_message_id = ?`, previous_message_id);
      push(last_run_at !== null,         `last_run_at = ?`, last_run_at);
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(`UPDATE rpost_shard_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
        (updErr) => updErr ? reject(updErr) : resolve());
    });
  });
}

module.exports = {
  __name: 'shard',
  init,
  bind,
};
