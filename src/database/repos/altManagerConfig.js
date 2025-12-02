// src/database/repos/altManagerConfig.js
// Stores Alt Manager dashboard bindings per guild.

const { db } = require('../connection');

const run = (sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
const get = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row || null))));

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS alt_manager_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT
  )`);
}

function getAltManagerConfig(guildId) {
  return get(`SELECT * FROM alt_manager_config WHERE guild_id = ?`, [guildId]);
}

function upsertAltManagerConfig({ guild_id, channel_id = null, dashboard_message_id = null }) {
  return new Promise((resolve, reject) => {
    if (!guild_id) return reject(new Error('guild_id required'));
    db.run(`INSERT OR IGNORE INTO alt_manager_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      if (channel_id !== null)          { sets.push(`channel_id = ?`);          vals.push(channel_id); }
      if (dashboard_message_id !== null){ sets.push(`dashboard_message_id = ?`); vals.push(dashboard_message_id); }
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(
        `UPDATE alt_manager_config SET ${sets.join(', ')} WHERE guild_id = ?`,
        vals,
        (e) => (e ? reject(e) : resolve())
      );
    });
  });
}

module.exports = {
  ensureSchema,
  getAltManagerConfig,
  upsertAltManagerConfig,
};
