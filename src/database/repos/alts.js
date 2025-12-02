// src/database/repos/alts.js
const { db } = require('../connection');
const { encryptSecret, decryptSecret, assertAltKey } = require('../helpers/crypto');

const ALT_TABLE_SHAPE = {
  hasLoginEncrypted: false,
  loginEncryptedType: null,
  loginEncryptedNotNull: false,
  emailCol: 'email_enc',
  passwordCol: 'password_enc',
};

function run(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) {
    if (err) reject(err); else resolve(this);
  }));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => {
    if (err) reject(err); else resolve(row || null);
  }));
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => {
    if (err) reject(err); else resolve(rows || []);
  }));
}

async function ensureSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS alts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_mode TEXT CHECK(auth_mode IN ('offline','microsoft')) NOT NULL DEFAULT 'offline',
      mc_username TEXT,
      msa_label TEXT,
      email_enc TEXT,
      password_enc TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0,
      last_status TEXT,
      last_seen INTEGER DEFAULT 0,
      mc_uuid TEXT,
      mc_last_username TEXT,
      last_world TEXT,
      world_updated_at INTEGER DEFAULT 0
    )
  `);

  const rows = await all(`PRAGMA table_info(alts)`);
  const cols = Array.isArray(rows) ? rows.map(r => r.name) : [];

  if (!cols.includes('last_world')) {
    await run(`ALTER TABLE alts ADD COLUMN last_world TEXT`);
  }
  if (!cols.includes('last_world')) {
    await run(`ALTER TABLE alts ADD COLUMN last_world TEXT`);
  }

  if (!cols.includes('world_updated_at')) {
    await run(`ALTER TABLE alts ADD COLUMN world_updated_at INTEGER DEFAULT 0`);
  }

  const loginRow = rows.find(r => r.name === 'login_encrypted');
  if (loginRow) {
    ALT_TABLE_SHAPE.hasLoginEncrypted = true;
    ALT_TABLE_SHAPE.loginEncryptedType = (loginRow.type || '').toUpperCase();
    ALT_TABLE_SHAPE.loginEncryptedNotNull = !!loginRow.notnull;

    const defVal = ALT_TABLE_SHAPE.loginEncryptedType.includes('INT') ? 0 : '';
    if (ALT_TABLE_SHAPE.loginEncryptedNotNull) {
      await run(`UPDATE alts SET login_encrypted = COALESCE(login_encrypted, ?)`, [defVal]);
    }
  }

  ALT_TABLE_SHAPE.emailCol    = cols.includes('email_encrypted')    && !cols.includes('email_enc')    ? 'email_encrypted'    : 'email_enc';
  ALT_TABLE_SHAPE.passwordCol = cols.includes('password_encrypted') && !cols.includes('password_enc') ? 'password_encrypted' : 'password_enc';
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function maybeEncrypt(plain) {
  if (plain == null || plain === '') return null;
  assertAltKey();
  return encryptSecret(String(plain));
}
function maybeDecrypt(blob) {
  if (!blob) return null;
  try { return decryptSecret(String(blob)); } catch { return null; }
}

function decryptAltRowSecrets(row) {
  if (!row) return row;
  const out = { ...row };
  const emailBlob = row.email_enc ?? row.email_encrypted ?? null;
  const passBlob  = row.password_enc ?? row.password_encrypted ?? null;
  out.email_plain = maybeDecrypt(emailBlob);
  out.password_plain = maybeDecrypt(passBlob);
  return out;
}

function listAlts(guildId) {
  return all(`SELECT * FROM alts WHERE guild_id = ? ORDER BY label COLLATE NOCASE`, [guildId]);
}
function getAltById(id) {
  return get(`SELECT * FROM alts WHERE id = ?`, [id]);
}

async function insertAlt({
  guild_id, label, auth_mode = 'offline',
  mc_username = null, msa_label = null,
  email_plain = null, password_plain = null,
}) {
  if (email_plain || password_plain) assertAltKey();

  const cols = ['guild_id', 'label', 'auth_mode', 'mc_username', 'msa_label', ALT_TABLE_SHAPE.emailCol, ALT_TABLE_SHAPE.passwordCol, 'created_at', 'updated_at'];
  const vals = [
    guild_id,
    label,
    auth_mode,
    mc_username,
    msa_label,
    maybeEncrypt(email_plain),
    maybeEncrypt(password_plain),
    nowSec(),
    nowSec(),
  ];

  if (ALT_TABLE_SHAPE.hasLoginEncrypted && ALT_TABLE_SHAPE.loginEncryptedNotNull) {
    cols.push('login_encrypted');
    const defVal = (ALT_TABLE_SHAPE.loginEncryptedType || '').includes('INT') ? 0 : '';
    vals.push(defVal);
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO alts (${cols.join(', ')}) VALUES (${placeholders})`;
  const res = await run(sql, vals);
  return res.lastID;
}

async function updateAlt({
  id, label = null, auth_mode = null, mc_username = null,
  msa_label = null, email_plain = undefined, password_plain = undefined,
}) {
  const sets = [], vals = [];

  if (label !== null)       { sets.push(`label = ?`); vals.push(label); }
  if (auth_mode !== null)   { sets.push(`auth_mode = ?`); vals.push(auth_mode); }
  if (mc_username !== null) { sets.push(`mc_username = ?`); vals.push(mc_username); }
  if (msa_label !== null)   { sets.push(`msa_label = ?`); vals.push(msa_label); }

  if (email_plain !== undefined && ALT_TABLE_SHAPE.emailCol) {
    if (email_plain) assertAltKey();
    sets.push(`${ALT_TABLE_SHAPE.emailCol} = ?`);
    vals.push(maybeEncrypt(email_plain));
  }
  if (password_plain !== undefined && ALT_TABLE_SHAPE.passwordCol) {
    if (password_plain) assertAltKey();
    sets.push(`${ALT_TABLE_SHAPE.passwordCol} = ?`);
    vals.push(maybeEncrypt(password_plain));
  }

  sets.push(`updated_at = ?`); vals.push(nowSec());
  if (!sets.length) return;

  vals.push(id);
  await run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals);
}

async function deleteAlt(id) {
  await run(`DELETE FROM alts WHERE id = ?`, [id]);
}

async function setAltStatus({ id, status = null, last_seen = null }) {
  const sets = [], vals = [];
  if (status !== null)    { sets.push(`last_status = ?`); vals.push(status); }
  if (last_seen !== null) { sets.push(`last_seen = ?`); vals.push(last_seen); }
  if (!sets.length) return;
  sets.push(`updated_at = ?`); vals.push(nowSec());
  vals.push(id);
  await run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals);
}

async function setAltIdentity({ id, mc_uuid = undefined, mc_last_username = undefined }) {
  const sets = [], vals = [];
  if (mc_uuid !== undefined)          { sets.push(`mc_uuid = ?`); vals.push(mc_uuid); }
  if (mc_last_username !== undefined) { sets.push(`mc_last_username = ?`); vals.push(mc_last_username); }
  if (!sets.length) return;
  sets.push(`updated_at = ?`); vals.push(nowSec());
  vals.push(id);
  await run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals);
}

// Persist last detected world for dashboard fallback + timestamp
async function setAltWorld({ id, world, world_updated_at = null }) {
  const ts = world_updated_at != null ? Number(world_updated_at) : nowSec();
  await run(
    `UPDATE alts
       SET last_world = ?,
           world_updated_at = ?,
           updated_at = ?
     WHERE id = ?`,
    [world || null, ts, ts, id]
  );
}

module.exports = {
  ensureSchema,
  listAlts,
  getAltById,
  insertAlt,
  updateAlt,
  deleteAlt,
  setAltStatus,
  setAltIdentity,
  setAltWorld,
  decryptAltRowSecrets,
};
