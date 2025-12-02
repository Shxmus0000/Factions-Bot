// ========================================
// File: src/database/guild.js
// ========================================
/* Guild-scoped global configuration:
   - raid/outpost alert channels
   - weewoo flags + intervals
   - pause flags
   - checker alt assignments
*/

function init(db) {
  db.run(`CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    raid_alerts_channel_id TEXT,

    -- Base / walls weewoo
    weewoo_active INTEGER DEFAULT 0,
    weewoo_ping_interval_minutes INTEGER DEFAULT 2,
    weewoo_last_ping_at INTEGER DEFAULT 0,

    -- Outpost-specific
    outpost_alerts_channel_id TEXT,
    outpost_weewoo_active INTEGER DEFAULT 0,
    outpost_weewoo_ping_interval_minutes INTEGER DEFAULT 2,
    outpost_weewoo_last_ping_at INTEGER DEFAULT 0,

    -- pause flags
    base_alerts_paused INTEGER DEFAULT 0,
    outpost_alerts_paused INTEGER DEFAULT 0,

    -- checker role assignments
    shard_checker_alt_id INTEGER DEFAULT 0,
    rpost_checker_alt_id INTEGER DEFAULT 0,

    -- optional: config panel persistence
    config_panel_channel_id TEXT,
    config_panel_message_id TEXT
  )`);

  // Lightweight idempotent column adds (keeps older DBs compatible)
  db.all(`PRAGMA table_info(guild_config)`, (err, rows) => {
    if (err) return console.error('PRAGMA guild_config failed:', err);
    const cols = new Set((rows || []).map(r => r.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) {
        db.run(`ALTER TABLE guild_config ADD COLUMN ${ddl}`, e => {
          if (e && !String(e.message).includes('duplicate column name')) {
            console.error(`Add guild_config.${name} failed:`, e);
          }
        });
      }
    };

    add('weewoo_active', 'weewoo_active INTEGER DEFAULT 0');
    add('weewoo_ping_interval_minutes', 'weewoo_ping_interval_minutes INTEGER DEFAULT 2');
    add('weewoo_last_ping_at', 'weewoo_last_ping_at INTEGER DEFAULT 0');

    add('outpost_alerts_channel_id', 'outpost_alerts_channel_id TEXT');
    add('outpost_weewoo_active', 'outpost_weewoo_active INTEGER DEFAULT 0');
    add('outpost_weewoo_ping_interval_minutes', 'outpost_weewoo_ping_interval_minutes INTEGER DEFAULT 2');
    add('outpost_weewoo_last_ping_at', 'outpost_weewoo_last_ping_at INTEGER DEFAULT 0');

    add('base_alerts_paused', 'base_alerts_paused INTEGER DEFAULT 0');
    add('outpost_alerts_paused', 'outpost_alerts_paused INTEGER DEFAULT 0');

    add('shard_checker_alt_id', 'shard_checker_alt_id INTEGER DEFAULT 0');
    add('rpost_checker_alt_id', 'rpost_checker_alt_id INTEGER DEFAULT 0');

    add('config_panel_channel_id', 'config_panel_channel_id TEXT');
    add('config_panel_message_id', 'config_panel_message_id TEXT');
  });
}

const getGuildConfig = (guildId) => (new Promise((resolve, reject) => {
  this.db.get(`SELECT * FROM guild_config WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) reject(err); else resolve(row || null);
  });
})).bind({ db: null });

const upsertGuildConfig = ({
  guild_id,
  raid_alerts_channel_id = null,
  weewoo_active = null,
  weewoo_ping_interval_minutes = null,
  weewoo_last_ping_at = null,
  outpost_alerts_channel_id = null,
  outpost_weewoo_active = null,
  outpost_weewoo_ping_interval_minutes = null,
  outpost_weewoo_last_ping_at = null,
  base_alerts_paused = null,
  outpost_alerts_paused = null,
  shard_checker_alt_id = null,
  rpost_checker_alt_id = null,
  config_panel_channel_id = null,
  config_panel_message_id = null,
}) => (new Promise((resolve, reject) => {
  const db = this.db;
  db.run(`INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
    if (insErr) return reject(insErr);

    const sets = [], vals = [];
    const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };

    push(raid_alerts_channel_id !== null,        `raid_alerts_channel_id = ?`, raid_alerts_channel_id);
    push(weewoo_active !== null,                 `weewoo_active = ?`, weewoo_active);
    push(weewoo_ping_interval_minutes !== null,  `weewoo_ping_interval_minutes = ?`, weewoo_ping_interval_minutes);
    push(weewoo_last_ping_at !== null,           `weewoo_last_ping_at = ?`, weewoo_last_ping_at);

    push(outpost_alerts_channel_id !== null,              `outpost_alerts_channel_id = ?`, outpost_alerts_channel_id);
    push(outpost_weewoo_active !== null,                  `outpost_weewoo_active = ?`, outpost_weewoo_active);
    push(outpost_weewoo_ping_interval_minutes !== null,   `outpost_weewoo_ping_interval_minutes = ?`, outpost_weewoo_ping_interval_minutes);
    push(outpost_weewoo_last_ping_at !== null,            `outpost_weewoo_last_ping_at = ?`, outpost_weewoo_last_ping_at);

    push(base_alerts_paused !== null,           `base_alerts_paused = ?`, base_alerts_paused);
    push(outpost_alerts_paused !== null,        `outpost_alerts_paused = ?`, outpost_alerts_paused);

    push(shard_checker_alt_id !== null,         `shard_checker_alt_id = ?`, shard_checker_alt_id);
    push(rpost_checker_alt_id !== null,         `rpost_checker_alt_id = ?`, rpost_checker_alt_id);

    push(config_panel_channel_id !== null,      `config_panel_channel_id = ?`, config_panel_channel_id);
    push(config_panel_message_id !== null,      `config_panel_message_id = ?`, config_panel_message_id);

    if (!sets.length) return resolve();
    vals.push(guild_id);

    db.run(`UPDATE guild_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
      (updErr) => updErr ? reject(updErr) : resolve());
  });
})).bind({ db: null });

// Bind db instance from core on load
function bind(db) {
  getGuildConfig.bind({ db });
  upsertGuildConfig.bind({ db });
  module.exports.getGuildConfig = (guildId) => new Promise((res, rej) =>
    db.get(`SELECT * FROM guild_config WHERE guild_id = ?`, [guildId], (e, r) => e ? rej(e) : res(r || null))
  );
  module.exports.upsertGuildConfig = (args) => new Promise((res, rej) => {
    db.run(`INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)`, [args.guild_id], (insErr) => {
      if (insErr) return rej(insErr);

      const sets = [], vals = [];
      const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };

      const {
        raid_alerts_channel_id = null,
        weewoo_active = null,
        weewoo_ping_interval_minutes = null,
        weewoo_last_ping_at = null,
        outpost_alerts_channel_id = null,
        outpost_weewoo_active = null,
        outpost_weewoo_ping_interval_minutes = null,
        outpost_weewoo_last_ping_at = null,
        base_alerts_paused = null,
        outpost_alerts_paused = null,
        shard_checker_alt_id = null,
        rpost_checker_alt_id = null,
        config_panel_channel_id = null,
        config_panel_message_id = null,
      } = args;

      push(raid_alerts_channel_id !== null,        `raid_alerts_channel_id = ?`, raid_alerts_channel_id);
      push(weewoo_active !== null,                 `weewoo_active = ?`, weewoo_active);
      push(weewoo_ping_interval_minutes !== null,  `weewoo_ping_interval_minutes = ?`, weewoo_ping_interval_minutes);
      push(weewoo_last_ping_at !== null,           `weewoo_last_ping_at = ?`, weewoo_last_ping_at);

      push(outpost_alerts_channel_id !== null,              `outpost_alerts_channel_id = ?`, outpost_alerts_channel_id);
      push(outpost_weewoo_active !== null,                  `outpost_weewoo_active = ?`, outpost_weewoo_active);
      push(outpost_weewoo_ping_interval_minutes !== null,   `outpost_weewoo_ping_interval_minutes = ?`, outpost_weewoo_ping_interval_minutes);
      push(outpost_weewoo_last_ping_at !== null,            `outpost_weewoo_last_ping_at = ?`, outpost_weewoo_last_ping_at);

      push(base_alerts_paused !== null,           `base_alerts_paused = ?`, base_alerts_paused);
      push(outpost_alerts_paused !== null,        `outpost_alerts_paused = ?`, outpost_alerts_paused);

      push(shard_checker_alt_id !== null,         `shard_checker_alt_id = ?`, shard_checker_alt_id);
      push(rpost_checker_alt_id !== null,         `rpost_checker_alt_id = ?`, rpost_checker_alt_id);

      push(config_panel_channel_id !== null,      `config_panel_channel_id = ?`, config_panel_channel_id);
      push(config_panel_message_id !== null,      `config_panel_message_id = ?`, config_panel_message_id);

      if (!sets.length) return res();
      vals.push(args.guild_id);

      db.run(`UPDATE guild_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
        (updErr) => updErr ? rej(updErr) : res());
    });
  });
}

module.exports = {
  __name: 'guild',
  init,
  bind, // called from index after core opens the DB
  // runtime methods are bound in bind()
};
