// AES-256-GCM helpers for storing alt credentials securely.
// Requires ALT_CRYPT_KEY (32 bytes base64) in the environment.

const crypto = require('crypto');

const ENC_VERSION = 'v1';
const ALT_CRYPT_KEY_B64 = process.env.ALT_CRYPT_KEY || '';
let ALT_CRYPT_KEY = null;

(function initKey() {
  if (!ALT_CRYPT_KEY_B64) return;
  try {
    const key = Buffer.from(ALT_CRYPT_KEY_B64, 'base64');
    if (key.length !== 32) {
      console.error('[AltCrypt] ALT_CRYPT_KEY must decode to 32 bytes.');
      return;
    }
    ALT_CRYPT_KEY = key;
  } catch {
    console.error('[AltCrypt] ALT_CRYPT_KEY is not valid base64.');
  }
})();

function assertKeyOrThrow() {
  if (!ALT_CRYPT_KEY) throw new Error('ALT_CRYPT_KEY not set/invalid (must be 32-byte base64).');
}

function encryptSecret(plain) {
  assertKeyOrThrow();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ALT_CRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
}

function decryptSecret(blob) {
  assertKeyOrThrow();
  if (!blob) return '';
  const [ver, ivb64, ctb64, tagb64] = String(blob).split(':');
  if (ver !== ENC_VERSION) throw new Error('Unsupported enc version');
  const iv = Buffer.from(ivb64, 'base64');
  const ct = Buffer.from(ctb64, 'base64');
  const tag = Buffer.from(tagb64, 'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', ALT_CRYPT_KEY, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]);
  return out.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, assertKeyOrThrow };
