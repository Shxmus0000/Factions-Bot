// src/database/index.js
// Central DB bootstrap + stable exports that are SAFE to destructure.
// Proxies delegate to real module functions once dbInit() binds them.

const { getDb } = require('./connection');

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

// Prefer API-style modules (init/bind) when present.
const guildAPI   = safeRequire('./guild');
const wallsAPI   = safeRequire('./walls');
const outpostAPI = safeRequire('./outpost');
const shardAPI   = safeRequire('./shard');
const rpostAPI   = safeRequire('./rpostShard');  // optional
const altsAPI    = safeRequire('./alts');

// Repo fallbacks for modules that are repo-only in your tree
const altMgrRepo = safeRequire('./repos/altManagerConfig'); // repo-style (new)
const rpostRepo  = safeRequire('./repos/rpostShard');       // repo-style fallback

// ---------- dbInit: create schema & bind live funcs ----------
async function dbInit() {
  const sqlite = getDb(); // ensure connection created

  // init: create/upgrade tables — idempotent
  if (guildAPI?.init)   guildAPI.init(sqlite);
  if (wallsAPI?.init)   wallsAPI.init(sqlite);
  if (outpostAPI?.init) outpostAPI.init(sqlite);
  if (shardAPI?.init)   shardAPI.init(sqlite);
  if (altsAPI?.init)    altsAPI.init(sqlite);

  // rpost: prefer API; else ensure via repo
  if (rpostAPI?.init) {
    rpostAPI.init(sqlite);
  } else if (rpostRepo?.ensureSchema) {
    await rpostRepo.ensureSchema();
  }

  // Alt Manager config exists as a repo in your tree
  if (altMgrRepo?.ensureSchema) {
    await altMgrRepo.ensureSchema();
  }

  // bind: attach runtime methods
  if (guildAPI?.bind)   guildAPI.bind(sqlite);
  if (wallsAPI?.bind)   wallsAPI.bind(sqlite);
  if (outpostAPI?.bind) outpostAPI.bind(sqlite);
  if (shardAPI?.bind)   shardAPI.bind(sqlite);
  if (altsAPI?.bind)    altsAPI.bind(sqlite);

  if (rpostAPI?.bind) {
    rpostAPI.bind(sqlite);
  }
}

// ---------- Stable proxy helpers (never undefined) ----------
const notImpl = (name) => () => { throw new Error(`[database] ${name} not implemented`); };

// GUILD
async function getGuildConfig(...a) {
  const fn = guildAPI?.getGuildConfig;
  return fn ? fn(...a) : notImpl('getGuildConfig')();
}
async function upsertGuildConfig(...a) {
  const fn = guildAPI?.upsertGuildConfig;
  return fn ? fn(...a) : notImpl('upsertGuildConfig')();
}

// WALLS
async function getConfig(...a) {
  const fn = wallsAPI?.getConfig;
  return fn ? fn(...a) : notImpl('getConfig')();
}
async function upsertConfig(...a) {
  const fn = wallsAPI?.upsertConfig;
  return fn ? fn(...a) : notImpl('upsertConfig')();
}
async function resetWallChecks(...a) {
  const fn = wallsAPI?.resetWallChecks;
  return fn ? fn(...a) : notImpl('resetWallChecks')();
}
async function insertWallCheck(...a) {
  const fn = wallsAPI?.insertWallCheck;
  return fn ? fn(...a) : notImpl('insertWallCheck')();
}
async function getRecentChecks(...a) {
  const fn = wallsAPI?.getRecentChecks;
  return fn ? fn(...a) : notImpl('getRecentChecks')();
}
async function getLeaderboard(...a) {
  const fn = wallsAPI?.getLeaderboard;
  return fn ? fn(...a) : notImpl('getLeaderboard')();
}
async function getLastCheck(...a) {
  const fn = wallsAPI?.getLastCheck;
  return fn ? fn(...a) : notImpl('getLastCheck')();
}
async function updateLastNotified(...a) {
  const fn = wallsAPI?.updateLastNotified;
  return fn ? fn(...a) : notImpl('updateLastNotified')();
}

// OUTPOST
async function getOutpostConfig(...a) {
  const fn = outpostAPI?.getOutpostConfig;
  return fn ? fn(...a) : notImpl('getOutpostConfig')();
}
async function upsertOutpostConfig(...a) {
  const fn = outpostAPI?.upsertOutpostConfig;
  return fn ? fn(...a) : notImpl('upsertOutpostConfig')();
}
async function resetOutpostChecks(...a) {
  const fn = outpostAPI?.resetOutpostChecks;
  return fn ? fn(...a) : notImpl('resetOutpostChecks')();
}
async function insertOutpostCheck(...a) {
  const fn = outpostAPI?.insertOutpostCheck;
  return fn ? fn(...a) : notImpl('insertOutpostCheck')();
}
async function getOutpostRecentChecks(...a) {
  const fn = outpostAPI?.getOutpostRecentChecks;
  return fn ? fn(...a) : notImpl('getOutpostRecentChecks')();
}
async function getOutpostLeaderboard(...a) {
  const fn = outpostAPI?.getOutpostLeaderboard;
  return fn ? fn(...a) : notImpl('getOutpostLeaderboard')();
}
async function getOutpostLastCheck(...a) {
  const fn = outpostAPI?.getOutpostLastCheck;
  return fn ? fn(...a) : notImpl('getOutpostLastCheck')();
}
async function updateOutpostLastNotified(...a) {
  const fn = outpostAPI?.updateOutpostLastNotified || outpostAPI?.updateLastNotified;
  return fn ? fn(...a) : notImpl('updateOutpostLastNotified')();
}

// SHARD
async function getShardConfig(...a) {
  const fn = shardAPI?.getShardConfig;
  return fn ? fn(...a) : notImpl('getShardConfig')();
}
async function upsertShardConfig(...a) {
  const fn = shardAPI?.upsertShardConfig;
  return fn ? fn(...a) : notImpl('upsertShardConfig')();
}

// RPOST SHARD (prefer API; fallback to repo)
async function getRpostShardConfig(...a) {
  const fn = (rpostAPI && rpostAPI.getRpostShardConfig) || (rpostRepo && rpostRepo.getRpostShardConfig);
  return fn ? fn(...a) : notImpl('getRpostShardConfig')();
}
async function upsertRpostShardConfig(...a) {
  const fn = (rpostAPI && rpostAPI.upsertRpostShardConfig) || (rpostRepo && rpostRepo.upsertRpostShardConfig);
  return fn ? fn(...a) : notImpl('upsertRpostShardConfig')();
}

// ALTS (API)
async function listAlts(...a) {
  const fn = altsAPI?.listAlts;
  return fn ? fn(...a) : notImpl('listAlts')();
}
async function insertAlt(...a) {
  const fn = altsAPI?.insertAlt;
  return fn ? fn(...a) : notImpl('insertAlt')();
}
async function updateAlt(...a) {
  const fn = altsAPI?.updateAlt;
  return fn ? fn(...a) : notImpl('updateAlt')();
}
async function deleteAlt(...a) {
  const fn = altsAPI?.deleteAlt;
  return fn ? fn(...a) : notImpl('deleteAlt')();
}
async function getAltById(...a) {
  const fn = altsAPI?.getAltById;
  return fn ? fn(...a) : notImpl('getAltById')();
}
function decryptAltRowSecrets(...a) {
  const fn = altsAPI?.decryptAltRowSecrets;
  return fn ? fn(...a) : (v => v)(...a);
}

// ALT MANAGER CONFIG (repo-backed)
async function getAltManagerConfig(...a) {
  const fn = altMgrRepo?.getAltManagerConfig;
  return fn ? fn(...a) : notImpl('getAltManagerConfig')();
}
async function upsertAltManagerConfig(...a) {
  const fn = altMgrRepo?.upsertAltManagerConfig;
  return fn ? fn(...a) : notImpl('upsertAltManagerConfig')();
}

module.exports = {
  // lifecycle
  dbInit,

  // guild
  getGuildConfig, upsertGuildConfig,

  // walls
  getConfig, upsertConfig, resetWallChecks,
  insertWallCheck, getRecentChecks, getLeaderboard, getLastCheck, updateLastNotified,

  // outpost
  getOutpostConfig, upsertOutpostConfig, resetOutpostChecks,
  insertOutpostCheck, getOutpostRecentChecks, getOutpostLeaderboard, getOutpostLastCheck, updateOutpostLastNotified,

  // trackers
  getShardConfig, upsertShardConfig,
  getRpostShardConfig, upsertRpostShardConfig,

  // alt manager config
  getAltManagerConfig, upsertAltManagerConfig,

  // alts
  listAlts, insertAlt, updateAlt, deleteAlt, getAltById, decryptAltRowSecrets,
};
