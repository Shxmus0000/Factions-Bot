// src/database/connection.js
// Opens (or creates) the SQLite DB file and exports both a shared handle
// (legacy-compatible `db`) and a getter (`getDb`) for newer code.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const DB_DIR = __dirname; // src/database
const DB_PATH = path.join(DB_DIR, 'sonobot.sqlite');

// Internal singleton
let _db = null;

/**
 * Ensure directory exists, then open (or reuse) the sqlite3 Database handle.
 */
function getDb() {
  if (_db) return _db;

  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
  } catch (e) {
    console.error('[DB] Failed to ensure database directory:', e);
    throw e;
  }

  _db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('[DB] Failed to open SQLite:', err);
    } else {
      console.log('[DB] SQLite ready:', DB_PATH);
      // Keep foreign keys enforced
      _db.run('PRAGMA foreign_keys = ON;');
    }
  });

  return _db;
}

// ---- Legacy compatibility ----
// Many of your existing repo modules do:
//   const { db } = require('./connection');
// and then call db.run(...), db.get(...), etc.
// Export a live getter-backed property so it’s always a valid Database.
const legacy = {};
Object.defineProperty(legacy, 'db', {
  enumerable: true,
  configurable: false,
  get: () => getDb(),
});

module.exports = {
  getDb,
  DB_PATH,
  // legacy field — code that imports { db } keeps working
  ...legacy,
};
