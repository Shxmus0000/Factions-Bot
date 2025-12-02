// ========================================
// File: src/database/alts.js
// ========================================
const crypto = require('crypto');

const ENC_VERSION = 'v1';
function getKey() {
  const b64 = process.env.ALT_CRYPT_KEY || '';
  if (!b64) throw new Error('ALT_CRYPT_KEY not set (base64-encoded 32-byte key).');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('ALT_CRYPT_KEY must decode to 32 bytes.');
  return key;
}
function encryptSecret(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
}
function decryptSecret(blob) {
  if (!blob) return '';
  const key = getKey();
  const [ver, ivb64, ctb64, tagb64] = String(blob).split(':');
  if (ver !== ENC_VERSION) throw new Error('Unsupported enc version');
  const iv = Buffer.from(ivb64, 'base64');
  const ct = Buffer.from(ctb64, 'base64');
  const tag = Buffer.from(tagb64, 'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]);
  return out.toString('utf8');
}
const maybeEncrypt = (plain) => plain == null ? null : encryptSecret(String(plain));
const maybeDecrypt = (blob) => !blob ? '' : decryptSecret(String(blob));

const ALT_TABLE_SHAPE = {
  hasLoginEncrypted: false,
  loginEncryptedType: null,
  loginEncryptedNotNull: false,
  emailCol: 'email_enc',
  passwordCol: 'password_enc',
};

function init(db) {
  db.run(`CREATE TABLE IF NOT EXISTS alt_manager_config (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    dashboard_message_id TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS alts (
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
  )`);

  db.all(`PRAGMA table_info(alts)`, (err, rows) => {
    if (err) return console.error('PRAGMA table_info(alts) failed:', err);

    const cols = new Set((rows || []).map(r => r.name));
    const add = (name, ddl) => {
      if (!cols.has(name)) {
        db.run(`ALTER TABLE alts ADD COLUMN ${ddl}`, e => {
          if (e && !String(e.message).includes('duplicate column name')) {
            console.error(`Add alts.${name} failed:`, e);
          }
        });
      }
    };

    add('auth_mode', `auth_mode TEXT CHECK(auth_mode IN ('offline','microsoft')) NOT NULL DEFAULT 'offline'`);
    add('mc_username', 'mc_username TEXT');
    add('msa_label', 'msa_label TEXT');
    add('email_enc', 'email_enc TEXT');
    add('password_enc', 'password_enc TEXT');
    add('created_at', 'created_at INTEGER DEFAULT 0');
    add('updated_at', 'updated_at INTEGER DEFAULT 0');
    add('last_status', 'last_status TEXT');
    add('last_seen', 'last_seen INTEGER DEFAULT 0');
    add('mc_uuid', 'mc_uuid TEXT');
    add('mc_last_username', 'mc_last_username TEXT');
    add('last_world', 'last_world TEXT');
    add('world_updated_at', 'world_updated_at INTEGER DEFAULT 0');

    const loginRow = (rows || []).find(r => r.name === 'login_encrypted');
    if (loginRow) {
      ALT_TABLE_SHAPE.hasLoginEncrypted = true;
      ALT_TABLE_SHAPE.loginEncryptedType = (loginRow.type || '').toUpperCase();
      ALT_TABLE_SHAPE.loginEncryptedNotNull = !!loginRow.notnull;
      const defVal = ALT_TABLE_SHAPE.loginEncryptedType.includes('INT') ? 0 : '';
      if (ALT_TABLE_SHAPE.loginEncryptedNotNull) {
        db.run(`UPDATE alts SET login_encrypted = COALESCE(login_encrypted, ?)`, [defVal],
          (e) => { if (e) console.error('Backfill login_encrypted failed:', e.message); });
      }
    }

    ALT_TABLE_SHAPE.emailCol = cols.has('email_encrypted') && !cols.has('email_enc') ? 'email_encrypted' : 'email_enc';
    ALT_TABLE_SHAPE.passwordCol = cols.has('password_encrypted') && !cols.has('password_enc') ? 'password_encrypted' : 'password_enc';
  });
}

function bind(db) {
  module.exports.getAltManagerConfig = (guildId) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM alt_manager_config WHERE guild_id = ?`, [guildId],
      (err, row) => err ? reject(err) : resolve(row || null));
  });

  module.exports.upsertAltManagerConfig = ({ guild_id, channel_id = null, dashboard_message_id = null }) => new Promise((resolve, reject) => {
    db.run(`INSERT OR IGNORE INTO alt_manager_config (guild_id) VALUES (?)`, [guild_id], (insErr) => {
      if (insErr) return reject(insErr);
      const sets = [], vals = [];
      const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };
      push(channel_id !== null, `channel_id = ?`, channel_id);
      push(dashboard_message_id !== null, `dashboard_message_id = ?`, dashboard_message_id);
      if (!sets.length) return resolve();
      vals.push(guild_id);
      db.run(`UPDATE alt_manager_config SET ${sets.join(', ')} WHERE guild_id = ?`, vals,
        (updErr) => updErr ? reject(updErr) : resolve());
    });
  });

  module.exports.listAlts = (guildId) => new Promise((resolve, reject) => {
    db.all(`SELECT * FROM alts WHERE guild_id = ? ORDER BY label COLLATE NOCASE`, [guildId],
      (err, rows) => err ? reject(err) : resolve(rows || []));
  });

  module.exports.getAltById = (id) => new Promise((resolve, reject) => {
    db.get(`SELECT * FROM alts WHERE id = ?`, [id], (err, row) => err ? reject(err) : resolve(row || null));
  });

  module.exports.insertAlt = ({
    guild_id, label, auth_mode = 'offline', mc_username = null,
    msa_label = null, email_plain = null, password_plain = null
  }) => new Promise((resolve, reject) => {
    try { if (email_plain || password_plain) getKey(); } catch (e) { return reject(e); }
    const now = Math.floor(Date.now() / 1000);

    const cols = ['guild_id', 'label', 'auth_mode', 'mc_username', 'msa_label', ALT_TABLE_SHAPE.emailCol, ALT_TABLE_SHAPE.passwordCol, 'created_at', 'updated_at']
      .filter(Boolean);
    const vals = [
      guild_id, label, auth_mode, mc_username, msa_label,
      ALT_TABLE_SHAPE.emailCol ? (email_plain ? maybeEncrypt(email_plain) : null) : undefined,
      ALT_TABLE_SHAPE.passwordCol ? (password_plain ? maybeEncrypt(password_plain) : null) : undefined,
      now, now
    ].filter(v => v !== undefined);

    if (ALT_TABLE_SHAPE.hasLoginEncrypted && ALT_TABLE_SHAPE.loginEncryptedNotNull) {
      cols.push('login_encrypted');
      const defVal = (ALT_TABLE_SHAPE.loginEncryptedType || '').toUpperCase().includes('INT') ? 0 : '';
      vals.push(defVal);
    }

    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO alts (${cols.join(', ')}) VALUES (${placeholders})`;

    db.run(sql, vals, function (err) { if (err) reject(err); else resolve(this.lastID); });
  });

  module.exports.updateAlt = ({
    id, label = null, auth_mode = null, mc_username = null,
    msa_label = null, email_plain = undefined, password_plain = undefined
  }) => new Promise((resolve, reject) => {
    const sets = [], vals = [];
    const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };

    push(label !== null, `label = ?`, label);
    push(auth_mode !== null, `auth_mode = ?`, auth_mode);
    push(mc_username !== null, `mc_username = ?`, mc_username);
    push(msa_label !== null, `msa_label = ?`, msa_label);

    if (email_plain !== undefined && ALT_TABLE_SHAPE.emailCol) {
      try { if (email_plain) getKey(); } catch (e) { return reject(e); }
      push(true, `${ALT_TABLE_SHAPE.emailCol} = ?`, email_plain ? maybeEncrypt(email_plain) : null);
    }
    if (password_plain !== undefined && ALT_TABLE_SHAPE.passwordCol) {
      try { if (password_plain) getKey(); } catch (e) { return reject(e); }
      push(true, `${ALT_TABLE_SHAPE.passwordCol} = ?`, password_plain ? maybeEncrypt(password_plain) : null);
    }

    push(true, `updated_at = ?`, Math.floor(Date.now() / 1000));

    if (!sets.length) return resolve();
    vals.push(id);
    db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
  });

  module.exports.deleteAlt = (id) => new Promise((resolve, reject) => {
    db.run(`DELETE FROM alts WHERE id = ?`, [id], (err) => err ? reject(err) : resolve());
  });

  module.exports.setAltStatus = ({ id, status = null, last_seen = null }) => new Promise((resolve, reject) => {
    const sets = [], vals = [];
    const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };

    push(status !== null, `last_status = ?`, status);
    push(last_seen !== null, `last_seen = ?`, last_seen);

    if (!sets.length) return resolve();
    push(true, `updated_at = ?`, Math.floor(Date.now() / 1000));
    vals.push(id);
    db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
  });

  module.exports.setAltMcUuid = ({ id, mc_uuid = null }) => new Promise((resolve, reject) => {
    db.run(
      `UPDATE alts SET mc_uuid = ?, updated_at = ? WHERE id = ?`,
      [mc_uuid, Math.floor(Date.now() / 1000), id],
      (err) => err ? reject(err) : resolve()
    );
  });

  module.exports.setAltIdentity = ({ id, mc_uuid = undefined, mc_last_username = undefined }) => new Promise((resolve, reject) => {
    const sets = [], vals = [];
    const push = (cond, frag, v) => { if (cond) { sets.push(frag); vals.push(v); } };

    push(mc_uuid !== undefined, `mc_uuid = ?`, mc_uuid);
    push(mc_last_username !== undefined, `mc_last_username = ?`, mc_last_username);
    push(true, `updated_at = ?`, Math.floor(Date.now() / 1000));

    if (!sets.length) return resolve();
    vals.push(id);
    db.run(`UPDATE alts SET ${sets.join(', ')} WHERE id = ?`, vals, (err) => err ? reject(err) : resolve());
  });

  // NEW: persist last world + world_updated_at for the dashboard
  module.exports.setAltWorld = ({ id, world, world_updated_at = null }) => new Promise((resolve, reject) => {
    const ts = world_updated_at != null
      ? Number(world_updated_at)
      : Math.floor(Date.now() / 1000);

    db.run(
      `UPDATE alts
         SET last_world = ?,
             world_updated_at = ?,
             updated_at = ?
       WHERE id = ?`,
      [world || null, ts, ts, id],
      (err) => err ? reject(err) : resolve()
    );
  });

  module.exports.decryptAltRowSecrets = (row) => {
    if (!row) return row;
    const out = { ...row };
    const emailBlob = row.email_enc ?? row.email_encrypted ?? null;
    const passBlob  = row.password_enc ?? row.password_encrypted ?? null;
    try { out.email_plain = emailBlob ? maybeDecrypt(emailBlob) : null; } catch { out.email_plain = null; }
    try { out.password_plain = passBlob ? maybeDecrypt(passBlob) : null; } catch { out.password_plain = null; }
    return out;
  };
}

module.exports = {
  __name: 'alts',
  init,
  bind,
};
