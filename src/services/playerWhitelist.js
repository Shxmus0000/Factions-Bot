// src/services/playerWhitelist.js
// Shared player whitelist for shard + rpost trackers.
// Stored in: ./data/player-whitelist.json
//
// Structure on disk:
// {
//   "guilds": {
//     "<guildId>": ["NameOne", "NameTwo", ...]
//   }
// }

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'player-whitelist.json');

let cache = {
  guilds: {}, // guildId -> [names]
};

function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

function load() {
  ensureDirs();
  try {
    if (!fs.existsSync(FILE_PATH)) return;
    const raw = fs.readFileSync(FILE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;

    cache = {
      guilds:
        obj.guilds && typeof obj.guilds === 'object' ? obj.guilds : {},
    };
  } catch {
    // ignore JSON issues, keep empty cache
  }
}

function save() {
  ensureDirs();
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // ignore write errors
  }
}

function normalizeGuildId(guildId) {
  return String(guildId);
}

function normalizeName(name) {
  return String(name || '').trim();
}

/**
 * Get whitelist for a guild.
 * @param {string} guildId
 * @returns {string[]} sorted names
 */
function list(guildId) {
  const g = normalizeGuildId(guildId);
  const arr = cache.guilds[g] || [];
  return arr.slice().sort((a, b) => a.localeCompare(b));
}

/**
 * Add a name to the guild's whitelist.
 * @param {string} guildId
 * @param {string} name
 * @returns {string[]} updated list
 */
function add(guildId, name) {
  const g = normalizeGuildId(guildId);
  const n = normalizeName(name);
  if (!n) return list(guildId);

  if (!cache.guilds[g]) cache.guilds[g] = [];
  const exists = cache.guilds[g].some(
    (x) => x.toLowerCase() === n.toLowerCase()
  );
  if (!exists) {
    cache.guilds[g].push(n);
    save();
  }
  return list(guildId);
}

/**
 * Remove a name from the guild's whitelist.
 * @param {string} guildId
 * @param {string} name
 * @returns {string[]} updated list
 */
function remove(guildId, name) {
  const g = normalizeGuildId(guildId);
  const n = normalizeName(name);
  if (!n || !cache.guilds[g]) return list(guildId);

  cache.guilds[g] = cache.guilds[g].filter(
    (x) => x.toLowerCase() !== n.toLowerCase()
  );
  if (!cache.guilds[g].length) {
    delete cache.guilds[g];
  }
  save();
  return list(guildId);
}

// Load on first require
load();

module.exports = {
  list,
  add,
  remove,
};
