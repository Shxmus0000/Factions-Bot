// src/services/altRunner/index.js
// Alt runner: connects alts, sends /factions, detects shard from scoreboard,
// runs /home home once after first shard, and polls scoreboard every minute
// to keep the shard up to date.

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const mineflayer = require('mineflayer');
const ANNOUNCE_WORLD = (process.env.ALT_ANNOUNCE_WORLD ?? '0') === '1';

const {
  listAlts,
  getAltById,
  updateAlt,
  decryptAltRowSecrets,
  getAltManagerConfig,
  setAltIdentity,
  setAltStatus,
  setAltWorld,
} = require('../../database');

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { installMineflayerSkinPatch } = require('../../utils/mineflayer/patches');

// ===== Debug flags =====
const ALT_DEBUG = (process.env.ALT_DEBUG ?? '1') !== '0';
const ALT_DEBUG_VERBOSE = (process.env.ALT_DEBUG_VERBOSE ?? '0') === '1';
const ALT_DEBUG_LINES = (process.env.ALT_DEBUG_LINES ?? '1') === '1';

function tms() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}
function log(altId, lvl, ...args) {
  if (!ALT_DEBUG) return;
  console.log(`[AltRunner][${tms()}][${altId}]`, lvl.padEnd(6), ...args);
}
function vlog(altId, lvl, ...args) {
  if (!ALT_DEBUG || !ALT_DEBUG_VERBOSE) return;
  console.log(`[AltRunner][${tms()}][${altId}]`, (lvl + '*').padEnd(6), ...args);
}
function wlog(altId, ...args) {
  console.warn(`[AltRunner][${tms()}][${altId}]`, 'WARN  ', ...args);
}
function elog(altId, ...args) {
  console.error(`[AltRunner][${tms()}][${altId}]`, 'ERROR ', ...args);
}

// ===== Env =====
const HOST = process.env.MC_HOST || 'hub.mc-complex.com';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const VERSION = process.env.MC_VERSION || '1.20';

// Only /factions per your request
const FACTIONS_CMD = (process.env.MC_ALT_FACTIONS_CMD ?? '/factions').trim();

const AUTO_RECONNECT = (process.env.ALT_AUTO_RECONNECT || 'true')
  .toLowerCase() !== 'false';

const RECONNECT_MIN_MS = parseInt(process.env.ALT_RECONNECT_MIN_MS || '15000', 10);
const RECONNECT_MAX_MS = parseInt(process.env.ALT_RECONNECT_MAX_MS || '15000', 10);
const FIXED_BACKOFF = (process.env.ALT_FIXED_BACKOFF || '1') !== '0';

const SERVER_DELAY_MS = parseInt(process.env.MC_ALT_SERVER_DELAY_MS || '8000', 10);
const CHECK_TIMEOUT_MS = parseInt(process.env.MC_CHECK_TIMEOUT_MS || '120000', 10);

const LOGIN_JITTER_MS = parseInt(process.env.ALT_LOGIN_JITTER_MS || '1500', 10);
const MIN_GAP_BETWEEN_LOGINS_MS = parseInt(
  process.env.ALT_MIN_GAP_MS || '15000',
  10
);
const LOGIN_THROTTLE_MIN_MS = parseInt(
  process.env.ALT_LOGIN_THROTTLE_MIN_MS || '15000',
  10
);

const CHAT_COOLDOWN_MS = parseInt(process.env.ALT_CHAT_COOLDOWN_MS || '900', 10);

// First shard wait (we still use it, but it just waits for worldPretty)
// Allow a much longer window so manual GUI selection -> join shard -> scoreboard updates.
const FIRST_SHARD_TIMEOUT_MS = parseInt(
  process.env.ALT_FIRST_SHARD_TIMEOUT_MS || '30000',
  10
);
const FIRST_SHARD_TICK_MS = 500;

// Periodic world poll interval
const ALT_WORLD_POLL_MS = parseInt(
  process.env.ALT_WORLD_POLL_MS || '60000',
  10
);

// Extra delay after /factions before accepting first shard
// Default 8 seconds: hub -> GUI -> click shard -> scoreboard updates.
const FIRST_SHARD_DELAY_AFTER_FACTIONS_MS = parseInt(
  process.env.ALT_FIRST_SHARD_DELAY_MS || '8000',
  10
);

// Known worlds list (hint only)
const KNOWN_WORLDS = (process.env.ALT_KNOWN_WORLDS ||
  'Spawn,Meteor,Nebula,Comet,Nova,Luna,Star,Raiding Outpost')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ===== FS =====
const PROFILES_ROOT = path.join(process.cwd(), 'data', 'nmp-cache');
try {
  fs.mkdirSync(PROFILES_ROOT, { recursive: true });
} catch {}
function ensureAltAuthDir(altId) {
  const dir = path.join(PROFILES_ROOT, `alt-${altId}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

// ===== Runtime =====
const altRunner = new EventEmitter();
let discordClient = null;

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = new Map();
const authMessageByAltId = new Map();

let networkCooldownUntil = 0;
let registrationLockUntil = 0;

function S(altId) {
  if (!state.has(altId)) {
    state.set(altId, {
      guildId: null,
      label: null,

      bot: null,
      reconnectTimer: null,
      backoff: RECONNECT_MIN_MS,

      awaitingDevice: false,
      deviceExpiresAt: 0,

      cmdQueue: [],
      lastChatAt: 0,

      // Sidebar tracking
      _sidebar: null,
      _sidebarCleanup: null,
      _sidebarArmed: false,

      // Live detected shard
      worldPretty: null,
      worldUpdatedAt: 0,

      // Poller
      worldPollTimer: null,

      // First shard gating
      firstShardEligibleAt: null,
      hasRunHomeAfterFirstWorld: false,

      cooldownUntil: 0,
      _sending: false,

      _announcedWorld: false,
    });
  }
  return state.get(altId);
}

// ===== Discord helpers =====
async function postToAltChannel(guildId, payload) {
  if (!discordClient) return null;
  try {
    const cfg = await getAltManagerConfig(guildId).catch(() => null);
    if (!cfg?.channel_id) return null;
    const ch = await discordClient.channels.fetch(cfg.channel_id).catch(() => null);
    if (!ch) return null;
    return await ch.send(payload);
  } catch {
    return null;
  }
}

function getAltWorldUpdatedAt(altId) {
  const st = S(altId);
  return st.worldUpdatedAt || 0;
}

function buildMsAuthEmbed({ label, user_code, verification_uri, expires_in, email_hint }) {
  const minutes = Math.max(1, Math.round((Number(expires_in || 900)) / 60));
  const embed = new EmbedBuilder()
    .setTitle(`🔐 Microsoft Login — ${label}`)
    .setColor(0x5865f2)
    .setDescription(
      [
        'This alt must authenticate with Microsoft.',
        '',
        `**Step 1:** Click **Open Sign-in**`,
        `**Step 2:** Enter code: **\`${user_code}\`**`,
        email_hint ? `**Step 3:** Sign in with: \`${email_hint}\`` : null,
        '',
        `_Code expires in ~${minutes} minute${minutes === 1 ? '' : 's'}._`,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .setFooter({
      text: 'After completing the sign-in, the alt will connect automatically.',
    });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open Sign-in')
      .setStyle(ButtonStyle.Link)
      .setURL(verification_uri || 'https://microsoft.com/link')
  );
  return { embed, components: [row] };
}

// ===== Text helpers & scoreboard parsing =====
const SMALLCAPS_MAP = {
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ғ: 'f',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  x: 'x',
  ʏ: 'y',
  ᴢ: 'z',
};
function normalizeForMatch(s) {
  if (!s) return '';
  const noDiacritics = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let folded = '';
  for (const ch of noDiacritics) folded += SMALLCAPS_MAP[ch] || ch;
  return folded.toLowerCase();
}

const SIDEBAR_POS_NAMES = { 0: 'list', 1: 'sidebar', 2: 'belowName' };
function posNameOf(position) {
  return typeof position === 'string'
    ? position
    : SIDEBAR_POS_NAMES[position] || String(position);
}

function textOf(x) {
  try {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (typeof x.toString === 'function') return String(x.toString());
    if (x.text) return String(x.text);
    return JSON.stringify(x);
  } catch {
    return String(x || '');
  }
}

function linesFromScoreboard(sb) {
  if (!sb) return [];
  let items = [];
  if (Array.isArray(sb.items)) items = sb.items;
  else if (sb.items && typeof sb.items.values === 'function')
    items = Array.from(sb.items.values());
  else if (sb.scores && typeof sb.scores.values === 'function')
    items = Array.from(sb.scores.values());
  else if (Array.isArray(sb.scores)) items = sb.scores;
  else if (sb.items && typeof sb.items === 'object') items = Object.values(sb.items);

  items.sort((a, b) => {
    const as = a.score ?? a.value ?? 0;
    const bs = b.score ?? b.value ?? 0;
    if (bs !== as) return bs - as;
    const an = textOf(a.displayName ?? a.name ?? '');
    const bn = textOf(b.displayName ?? b.name ?? '');
    return an.localeCompare(bn);
  });

  const rawLines = items
    .map((it) => textOf(it.displayName ?? it.name ?? '').trim())
    .filter(Boolean);

  return rawLines
    .map((l) => l.replace(/\u00a7[0-9A-FK-OR]/gi, '').trim())
    .filter((l) => l && l !== '-');
}

function guessWorldFromLines(lines) {
  if (!lines?.length) return null;
  const pairs = lines.map((l) => ({ raw: l, norm: normalizeForMatch(l) }));

  const seasonIdx = pairs.findIndex((p) => /\bseason\b/.test(p.norm));
  const start = seasonIdx >= 0 ? Math.min(seasonIdx + 1, pairs.length - 1) : 0;

  const bannedNorm =
    /(season|server|balance|experience|xp\b|k\/d|fly\s*time|power|online\b|shield|faction|member|claim|claimed|money|coins|vote|store|discord|website|hub\b|mc-?complex|\.com)/i;

  const isCandidate = (raw, norm) => {
    if (!raw || !raw.trim()) return false;
    if (bannedNorm.test(norm)) return false;
    if (/^\s*[\[\(]/.test(raw)) return false;
    if (/^\s*[•▪\-]/.test(raw)) return false;
    if (/\[[^\]]+\]/.test(raw)) return false;
    if (/:/.test(raw)) return false;
    return true;
  };

  const windowEnd = Math.min(pairs.length, start + 6);
  const windowCandidate = pairs.slice(start, windowEnd).find((p) =>
    isCandidate(p.raw, p.norm)
  );
  if (windowCandidate) return windowCandidate.raw;

  const anyCandidate = pairs.find((p) => isCandidate(p.raw, p.norm));
  return anyCandidate ? anyCandidate.raw : null;
}

// ===== World commit + polling =====
function startWorldPoller(altId, bot) {
  const s = S(altId);

  if (s.worldPollTimer) {
    clearInterval(s.worldPollTimer);
    s.worldPollTimer = null;
  }
  if (!bot) return;

  s.worldPollTimer = setInterval(() => {
    try {
      if (!s.bot || !s.bot.player || !s._sidebar?.compute) return;

      // Prefer the tracked sidebar objective
      let sb = s._sidebar.currentObjective || null;

      // Fallback: scan scoreboards in case ref got lost
      if (!sb) {
        const all = s.bot.scoreboards || s.bot.scoreboard || null;
        const sbs = all && typeof all === 'object' ? Object.values(all) : [];
        sb = sbs.find((x) => x && posNameOf(x.position) === 'sidebar') || null;
        if (sb) s._sidebar.currentObjective = sb;
      }

      log(altId, 'WPOLL', 'tick');
      if (sb) {
        s._sidebar.compute('poll', sb);
      }
    } catch (e) {
      wlog(altId, 'world poll error', e?.message || e);
    }
  }, ALT_WORLD_POLL_MS);

  log(altId, 'WPOLL', `started (${ALT_WORLD_POLL_MS}ms)`);
}

function commitWorldIfChanged(altId, world, why) {
  if (!world) return;
  const st = S(altId);

  if (st.worldPretty === world) return;

  // First shard gating: ignore early worlds before shard delay
  if (
    !st.worldPretty &&
    st.firstShardEligibleAt &&
    Date.now() < st.firstShardEligibleAt
  ) {
    vlog(altId, 'WORLD', `ignored "${world}" (too early; why=${why})`);
    return;
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  st.worldPretty = world;
  st.worldUpdatedAt = nowSec;
  log(altId, 'WORLD', `→ "${world}" (${why})`);

  // Persist & notify
  try {
    if (setAltWorld) {
      setAltWorld({ id: altId, world, world_updated_at: nowSec }).catch(() => {});
    }
  } catch {}

  if (!st._announcedWorld) {
    st._announcedWorld = true;

    if (ANNOUNCE_WORLD) {
      try {
        postToAltChannel(st.guildId, {
          embeds: [
            new EmbedBuilder()
              .setTitle('🧭 Alt shard detected')
              .setDescription(
                `**${st.label || `Alt ${altId}`}** is on **${world}**`
              )
              .setColor(0x57f287),
          ],
        }).catch(() => {});
      } catch {}
    }
  }

  try {
    altRunner.emit('world-changed', {
      guildId: st.guildId,
      altId,
      label: st.label,
      world,
    });
  } catch {}

  // Start poller if not already running
  if (!st.worldPollTimer && st.bot) {
    startWorldPoller(altId, st.bot);
  }

  // One-time /home home after first valid shard
  if (!st.hasRunHomeAfterFirstWorld) {
    st.hasRunHomeAfterFirstWorld = true;
    st.cmdQueue.push('/home home');
    if (st.bot?.player) {
      // drain immediately if online
      drainQueue(altId);
    }
  }
}


// Probing helper: force a scoreboard read after a delay
function scheduleScoreboardProbe(altId, delayMs, reason = 'probe') {
  const st = S(altId);
  setTimeout(() => {
    try {
      if (!st.bot || !st.bot.player || !st._sidebar?.compute) return;

      let sb = st._sidebar.currentObjective || null;
      if (!sb) {
        const all = st.bot.scoreboards || st.bot.scoreboard || null;
        const sbs = all && typeof all === 'object' ? Object.values(all) : [];
        sb = sbs.find((x) => x && posNameOf(x.position) === 'sidebar') || null;
        if (sb) st._sidebar.currentObjective = sb;
      }
      if (sb) {
        st._sidebar.compute(`probe:${reason}`, sb);
      }
    } catch (e) {
      wlog(altId, 'probe error', e?.message || e);
    }
  }, delayMs);
}

// ===== Sidebar capture =====
function attachSidebarCapture(altId, bot) {
  const s = S(altId);
  s._sidebar = {
    currentObjective: null,
    lastLines: null,
    lastWorld: null,
    compute: null,
  };

  const commitIfChanged = (world, why) => {
    commitWorldIfChanged(altId, world, why);
  };

  const computeAndLog = (why, sb) => {
    try {
      const st = S(altId);

      // gate until armed (after /factions is sent), except when explicitly armed
      if (!st._sidebarArmed && !String(why).startsWith('armed')) return;
      if (!sb) return;

      const lines = linesFromScoreboard(sb);
      const world = guessWorldFromLines(lines);

      const prevLinesJson = JSON.stringify(s._sidebar.lastLines || []);
      const newLinesJson = JSON.stringify(lines);
      const changedLines = prevLinesJson !== newLinesJson;
      const changedWorld = world && world !== s._sidebar.lastWorld;

      const alwaysLog =
        String(why).startsWith('poll') ||
        String(why).startsWith('probe') ||
        String(why).startsWith('armed');

      if (changedLines || changedWorld || alwaysLog) {
        const titleText = textOf(sb.displayName || sb.name);
        console.log(
          `[AltRunner][Scoreboard] ${st.label || altId} (${why}) — title="${titleText}"\n` +
            `  Lines:\n  - ${lines.join('\n  - ')}`
        );
      }

      if (world) {
        commitIfChanged(world, why);
        s._sidebar.lastWorld = world;
      }

      s._sidebar.lastLines = lines;
    } catch (e) {
      console.warn('[AltRunner] sidebar parse failed:', e?.message || e);
    }
  };

  s._sidebar.compute = computeAndLog;

  const onPos = (position, sb) => {
    if (posNameOf(position) === 'sidebar') {
      s._sidebar.currentObjective = sb;
      computeAndLog('position=sidebar', sb);
    }
  };
  const onTitle = (sb) => {
    if (sb && sb === s._sidebar.currentObjective) computeAndLog('titleChanged', sb);
  };
  const onScoreUpdate = (sb) => {
    if (sb && sb === s._sidebar.currentObjective) computeAndLog('scoreUpdated', sb);
  };
  const onScoreRemove = (sb) => {
    if (sb && sb === s._sidebar.currentObjective) computeAndLog('scoreRemoved', sb);
  };
  const onCreated = (sb) => {
    if (sb?.position && posNameOf(sb.position) === 'sidebar') {
      s._sidebar.currentObjective = sb;
      computeAndLog('created', sb);
    }
  };

  bot.on('scoreboardPosition', onPos);
  bot.on('scoreboardTitleChanged', onTitle);
  bot.on('scoreUpdated', onScoreUpdate);
  bot.on('scoreRemoved', onScoreRemove);
  bot.on('scoreboardCreated', onCreated);

  // Probe in case sidebar existed before listeners were attached
  setTimeout(() => {
    try {
      const all = bot?.scoreboards || bot?.scoreboard || null;
      const sbs = all && typeof all === 'object' ? Object.values(all) : [];
      const sb = sbs.find((x) => x && posNameOf(x.position) === 'sidebar');
      if (sb) {
        s._sidebar.currentObjective = sb;
        computeAndLog('initial-scan', sb);
      }
    } catch {}
  }, 1500);

  return () => {
    try {
      bot.off('scoreboardPosition', onPos);
    } catch {}
    try {
      bot.off('scoreboardTitleChanged', onTitle);
    } catch {}
    try {
      bot.off('scoreUpdated', onScoreUpdate);
    } catch {}
    try {
      bot.off('scoreRemoved', onScoreRemove);
    } catch {}
    try {
      bot.off('scoreboardCreated', onCreated);
    } catch {}
    s._sidebar = null;
  };
}

function armSidebarCapture(altId, bot, reason = 'factions-sent') {
  const s = S(altId);
  s._sidebarArmed = true;
  // take immediate snapshot
  try {
    const all = bot?.scoreboards || bot?.scoreboard || null;
    const sbs = all && typeof all === 'object' ? Object.values(all) : [];
    const sb =
      (s._sidebar && s._sidebar.currentObjective) ||
      sbs.find((x) => x && posNameOf(x.position) === 'sidebar');
    if (sb && s._sidebar?.compute) s._sidebar.compute(`armed:${reason}`, sb);
  } catch {}
}

// ===== Chat transition detector (harmless, just logs) =====
const HOME_CONFIRM_PATTERNS = [
  /teleport/i,
  /home/i,
  /moved you/i,
  /you (?:were|have been) (?:teleported|moved)/i,
  /now entering/i,
];
function attachChatTransitionSniffer(altId, bot) {
  const onStr = (t) => {
    const s = String(t || '');
    if (HOME_CONFIRM_PATTERNS.some((r) => r.test(s))) {
      log(altId, 'CHAT ', `transition: "${s}"`);
    }
  };
  const onMsg = (m) => {
    const s = m?.toString?.() || '';
    if (HOME_CONFIRM_PATTERNS.some((r) => r.test(s))) {
      log(altId, 'CHAT ', `transition: "${s}"`);
    }
  };
  bot.on('messagestr', onStr);
  bot.on('message', onMsg);
  return () => {
    try {
      bot.off('messagestr', onStr);
    } catch {}
    try {
      bot.off('message', onMsg);
    } catch {}
  };
}

// ===== First-shard waiter (scoreboard-only, no GUI interaction) =====
async function waitForFirstShard(altId, timeoutMs = FIRST_SHARD_TIMEOUT_MS, tickMs = FIRST_SHARD_TICK_MS) {
  const st = S(altId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (st.worldPretty) return true;
    await sleep(tickMs);
  }
  return !!st.worldPretty;
}

// ===== Commands / chat queue =====
async function clearAnyOpenUI(bot, maxAttempts = 3, altId = '?') {
  if (!bot) return;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (bot.currentWindow) {
        vlog(altId, 'GUI  ', 'closing a GUI before chat');
        bot.closeWindow(bot.currentWindow);
        await sleep(150);
      } else break;
    } catch {}
  }
}

function drainQueue(altId) {
  const st = S(altId);
  const bot = st.bot;
  if (!bot || !bot.player) return;
  if (st._sending) return;
  st._sending = true;

  const tick = async () => {
    if (!st.bot || !st.bot.player) {
      st._sending = false;
      return;
    }
    const msg = st.cmdQueue.shift();
    if (!msg) {
      st._sending = false;
      return;
    }

    await clearAnyOpenUI(st.bot, 2, altId);
    const now = Date.now();
    const wait = Math.max(0, (st.lastChatAt || 0) + CHAT_COOLDOWN_MS - now);

    setTimeout(() => {
      try {
        log(altId, 'CHAT ', `-> ${msg}`);
        st.bot.chat(msg);
        st.lastChatAt = Date.now();
      } catch (e) {
        wlog(altId, 'chat failed', e?.message || e);
      }
      setImmediate(tick);
    }, wait);
  };

  tick();
}

// ===== Login queue & reconnects =====
const loginQueue = [];
const queuedSet = new Set();
const queueWaiters = new Map();
let processingQueue = false;

function enqueueLogin(altId) {
  return new Promise((resolve) => {
    if (!queuedSet.has(altId)) {
      queuedSet.add(altId);
      loginQueue.push(altId);
      queueWaiters.set(altId, [resolve]);
    } else {
      const arr = queueWaiters.get(altId) || [];
      arr.push(resolve);
      queueWaiters.set(altId, arr);
    }
    if (!processingQueue) processQueue().catch(() => {});
  });
}

async function processQueue() {
  processingQueue = true;
  while (loginQueue.length) {
    const altId = loginQueue.shift();
    queuedSet.delete(altId);
    const resolvers = queueWaiters.get(altId) || [];
    queueWaiters.delete(altId);

    const st = S(altId);
    const now = Date.now();
    const waitUntil = Math.max(
      networkCooldownUntil || 0,
      registrationLockUntil || 0,
      st.cooldownUntil || 0
    );
    if (waitUntil > now) {
      const d = waitUntil - now + rnd(300, 700);
      log(altId, 'QWAIT', `delaying login ${d}ms due to cooldowns`);
      await sleep(d);
    }

    if (st.bot?.player?.username) {
      log(altId, 'QUEUE', 'already online, skipping connect');
      resolvers.forEach((r) => r({ status: 'already-online' }));
      await sleep(300);
      continue;
    }

    const result = await connectAltNow(altId).catch((err) => ({
      status: 'error',
      error: err,
    }));
    resolvers.forEach((r) => r(result));

    await sleep(MIN_GAP_BETWEEN_LOGINS_MS + rnd(0, LOGIN_JITTER_MS));
  }
  processingQueue = false;
}

async function scheduleReconnect(altId, delayOverrideMs = null) {
  const st = S(altId);
  if (!AUTO_RECONNECT || st.awaitingDevice) return;

  let base = delayOverrideMs != null ? delayOverrideMs : st.backoff;
  const now = Date.now();
  const until = Math.max(
    st.cooldownUntil || 0,
    networkCooldownUntil || 0,
    registrationLockUntil || 0
  );
  if (until > now) base = Math.max(base, until - now);

  const delay = base + rnd(0, LOGIN_JITTER_MS);
  st.backoff = FIXED_BACKOFF
    ? RECONNECT_MIN_MS
    : Math.min(
        Math.max(RECONNECT_MIN_MS, Math.round(st.backoff * 1.5)),
        RECONNECT_MAX_MS
      );

  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
  }
  log(altId, 'RECON', `scheduled in ${delay}ms`);
  st.reconnectTimer = setTimeout(() => {
    st.reconnectTimer = null;
    enqueueLogin(altId).catch(() => {});
  }, delay);
}

// ===== Mineflayer options =====
function buildMicrosoftOptions({ username, profilesFolder, onMsaCode }) {
  return {
    host: HOST,
    port: PORT,
    version: VERSION,
    auth: 'microsoft',
    username,
    profilesFolder,
    checkTimeoutInterval: CHECK_TIMEOUT_MS,
    onMsaCode,
  };
}
function buildOfflineOptions({ username }) {
  return {
    host: HOST,
    port: PORT,
    version: VERSION,
    auth: 'offline',
    username,
    checkTimeoutInterval: CHECK_TIMEOUT_MS,
  };
}

// ===== Connect alt =====
async function connectAltNow(altId) {
  const row = await getAltById(altId);
  if (!row) throw new Error('Alt not found');
  const alt = decryptAltRowSecrets(row);
  const st = S(altId);

  st.guildId = alt.guild_id;
  st.label = alt.label;
  st.backoff = RECONNECT_MIN_MS;
  st.awaitingDevice = false;

  // reset per-connection state
  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
  }
  if (st.worldPollTimer) {
    clearInterval(st.worldPollTimer);
    st.worldPollTimer = null;
  }
  if (st.bot) {
    try {
      st.bot.end('reconnect');
    } catch {}
    st.bot = null;
  }
  try {
    st._sidebarCleanup?.();
  } catch {}
  st._sidebarCleanup = null;
  st._sidebarArmed = false;
  st._announcedWorld = false;
  st.worldPretty = null;
  st.worldUpdatedAt = 0;
  st.firstShardEligibleAt = null;
  st.hasRunHomeAfterFirstWorld = false;

  const authDir = ensureAltAuthDir(altId);
  const isMicrosoft = (alt.auth_mode || 'microsoft') === 'microsoft';
  const usernameHint = (alt.email_plain || alt.label || `alt-${alt.id}`).trim();

  const opts = isMicrosoft
    ? buildMicrosoftOptions({
        username: usernameHint,
        profilesFolder: authDir,
        onMsaCode: async (codeData) => {
          st.awaitingDevice = true;
          const user_code =
            codeData?.user_code || codeData?.userCode || '—';
          const verification_uri =
            codeData?.verification_uri ||
            codeData?.verificationUri ||
            codeData?.verification_uri_complete ||
            codeData?.verificationUriComplete ||
            'https://microsoft.com/link';
          const expires_in = Number(
            codeData?.expires_in || codeData?.expiresIn || 900
          );

          const { embed, components } = buildMsAuthEmbed({
            label: alt.label,
            user_code,
            verification_uri,
            expires_in,
            email_hint: alt.email_plain || '',
          });
          const msg = await postToAltChannel(alt.guild_id, {
            embeds: [embed],
            components,
          });
          if (msg?.id) authMessageByAltId.set(altId, msg.id);

          try {
            setAltStatus &&
              (await setAltStatus({
                id: altId,
                status: 'auth-wait',
                last_seen: Math.floor(Date.now() / 1000),
              }));
          } catch {}

          altRunner.emit('msa-device-code', {
            guildId: alt.guild_id,
            altId,
            user_code,
            verification_uri,
            expires_in,
          });
          log(altId, 'AUTH ', `Device code issued (${user_code})`);
        },
      })
    : buildOfflineOptions({
        username: alt.mc_username || alt.label || `alt-${alt.id}`,
      });

  log(
    altId,
    'CONN ',
    `connecting -> ${HOST}:${PORT} auth=${opts.auth} user="${opts.username}" (profiles: ${authDir})`
  );
  const bot = mineflayer.createBot(opts);
  st.bot = bot;

  try {
    installMineflayerSkinPatch(bot);
  } catch (e) {
    wlog(altId, 'skin patch failed', e?.message || e);
  }

  // Sidebar + chat sniffer
  st._sidebarCleanup = attachSidebarCapture(altId, bot);
  const detachChatSniffer = attachChatTransitionSniffer(altId, bot);

  bot.once('spawn', async () => {
    st.awaitingDevice = false;
    log(altId, 'SPAWN', `as ${bot.player?.username || 'unknown'}`);
    try {
      setAltStatus &&
        (await setAltStatus({
          id: altId,
          status: 'online',
          last_seen: Math.floor(Date.now() / 1000),
        }));
    } catch {}

    // delete device-code embed if present
    const msgId = authMessageByAltId.get(altId);
    if (msgId) {
      try {
        const cfg = await getAltManagerConfig(alt.guild_id).catch(() => null);
        if (cfg?.channel_id && discordClient) {
          const ch = await discordClient.channels
            .fetch(cfg.channel_id)
            .catch(() => null);
          if (ch) {
            const m = await ch.messages.fetch(msgId).catch(() => null);
            if (m) await m.delete().catch(() => {});
          }
        }
      } catch {}
      authMessageByAltId.delete(altId);
    }

    try {
      await updateAlt({
        id: altId,
        mc_username: bot.player?.username || null,
      });
    } catch {}
    try {
      setAltIdentity &&
        (await setAltIdentity({
          id: altId,
          mc_uuid: bot.player?.uuid || null,
          mc_last_username: bot.player?.username || null,
        }));
    } catch {}

    if (ALT_DEBUG_LINES) {
      try {
        const all = bot?.scoreboards || bot?.scoreboard || null;
        const sbs = all && typeof all === 'object' ? Object.values(all) : [];
        const sb = sbs.find((x) => x && posNameOf(x.position) === 'sidebar');
        const title = sb ? textOf(sb.displayName || sb.name) : '';
        const lines = sb ? linesFromScoreboard(sb) : [];
        log(altId, 'SB   ', `(post-spawn) title="${title || '—'}"`);
        lines.forEach((l, i) => vlog(altId, 'SB   ', `#${i + 1}: ${l}`));
      } catch {}
    }

    // Step 1: send /factions & set first-shard window
    setTimeout(() => {
      try {
        if (FACTIONS_CMD && FACTIONS_CMD.toLowerCase() !== 'none') {
          bot.chat(FACTIONS_CMD);
          log(altId, 'STEP ', `sent ${FACTIONS_CMD}`);
        }

        // Only accept first world after this delay
        st.firstShardEligibleAt =
          Date.now() + FIRST_SHARD_DELAY_AFTER_FACTIONS_MS;
        vlog(
          altId,
          'WORLD*',
          `first shard eligible after ${FIRST_SHARD_DELAY_AFTER_FACTIONS_MS}ms`
        );

        // Force a scoreboard probe shortly AFTER that delay
        scheduleScoreboardProbe(
          altId,
          FIRST_SHARD_DELAY_AFTER_FACTIONS_MS + 1500,
          'after-factions-delay'
        );

        // Arm sidebar capture now that we've sent /factions
        try {
          armSidebarCapture(altId, bot, 'after-factions');
        } catch {}
      } catch (e) {
        wlog(altId, 'factions failed', e?.message || e);
      }
    }, Math.max(800, SERVER_DELAY_MS - 2400));

    // Wait a bit for first shard (based on scoreboard events + probe)
    try {
      await waitForFirstShard(
        altId,
        FIRST_SHARD_TIMEOUT_MS,
        FIRST_SHARD_TICK_MS
      );
    } catch {}

    // Start draining queued commands
    setTimeout(() => drainQueue(altId), 1200);
  });

  bot.on('respawn', () => setTimeout(() => drainQueue(altId), 1500));

  bot.on('kicked', async (reasonObj) => {
    try {
      setAltStatus &&
        (await setAltStatus({
          id: altId,
          status: 'error',
          last_seen: Math.floor(Date.now() / 1000),
        }));
    } catch {}

    try {
      st._sidebarCleanup?.();
    } catch {}
    st._sidebarCleanup = null;
    st._sidebarArmed = false;
    st.bot = null;
    if (st.worldPollTimer) {
      clearInterval(st.worldPollTimer);
      st.worldPollTimer = null;
    }
    try {
      detachChatSniffer?.();
    } catch {}

    const msg = (() => {
      try {
        if (!reasonObj) return '';
        if (typeof reasonObj === 'string') return reasonObj;
        if (reasonObj.text) return String(reasonObj.text);
        if (reasonObj.translate) return String(reasonObj.translate);
        return JSON.stringify(reasonObj);
      } catch {
        return '';
      }
    })();

    wlog(altId, 'kicked:', msg);
    if (/logging in too fast/i.test(msg)) {
      registrationLockUntil = Math.max(
        registrationLockUntil,
        Date.now() + LOGIN_THROTTLE_MIN_MS
      );
    }
    if (/unable to register you with the network/i.test(msg)) {
      const until = Date.now() + RECONNECT_MIN_MS;
      networkCooldownUntil = Math.max(networkCooldownUntil, until);
      registrationLockUntil = Math.max(registrationLockUntil, until);
      st.cooldownUntil = Math.max(st.cooldownUntil, until);
      await postToAltChannel(alt.guild_id, {
        embeds: [
          new EmbedBuilder()
            .setTitle('⏳ Network is rate-limiting new connections')
            .setDescription(
              `**${alt.label}** hit a network limit; will retry shortly.`
            )
            .setColor(0xf1c40f),
        ],
      }).catch(() => {});
    }
    if (AUTO_RECONNECT) scheduleReconnect(altId, RECONNECT_MIN_MS);
  });

  bot.on('end', async (reason) => {
    log(altId, 'END  ', `reason="${reason || ''}"`);
    try {
      setAltStatus &&
        (await setAltStatus({
          id: altId,
          status: 'offline',
          last_seen: Math.floor(Date.now() / 1000),
        }));
    } catch {}
    try {
      st._sidebarCleanup?.();
    } catch {}
    st._sidebarCleanup = null;
    st._sidebarArmed = false;
    st.bot = null;
    if (st.worldPollTimer) {
      clearInterval(st.worldPollTimer);
      st.worldPollTimer = null;
    }
    if (AUTO_RECONNECT) scheduleReconnect(altId, RECONNECT_MIN_MS);
  });

  bot.on('error', async (err) => {
    elog(altId, 'mineflayer error:', err?.message || err);
    if (st.awaitingDevice) {
      try {
        setAltStatus &&
          (await setAltStatus({
            id: altId,
            status: 'auth-wait',
            last_seen: Math.floor(Date.now() / 1000),
          }));
      } catch {}
      return;
    }
    try {
      setAltStatus &&
        (await setAltStatus({
          id: altId,
          status: 'error',
          last_seen: Math.floor(Date.now() / 1000),
        }));
    } catch {}
    if (/403/.test(String(err)) || /forbidden/i.test(String(err))) {
      await postToAltChannel(alt.guild_id, {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              '❌ Microsoft signed in, but Minecraft login was rejected (403)'
            )
            .setDescription(
              [
                `Alt: **${alt.label}**`,
                '',
                'This usually means the account cannot obtain a **Minecraft Java** token.',
                'Ensure the Microsoft account owns **Minecraft: Java Edition** and has an Xbox profile.',
              ].join('\n')
            )
            .setColor(0xed4245),
        ],
      }).catch(() => {});
    }
  });
}

// ===== Public API =====
function init(client) {
  discordClient = client;
}

async function startAlt(guildId, altId) {
  const st = S(altId);
  st.guildId = guildId;
  try {
    const row = await getAltById(altId);
    if (row?.last_world) st.worldPretty = row.last_world;
    if (row?.world_updated_at) st.worldUpdatedAt = Number(row.world_updated_at) || 0;
  } catch {}
  await enqueueLogin(altId);
}

async function stopAlt(altId) {
  const st = S(altId);
  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
  }
  if (st.worldPollTimer) {
    clearInterval(st.worldPollTimer);
    st.worldPollTimer = null;
  }
  if (st.bot) {
    try {
      st.bot.end('stop');
    } catch {}
    st.bot = null;
  }
  try {
    st._sidebarCleanup?.();
  } catch {}
  st._sidebarCleanup = null;
  st._sidebarArmed = false;
  st.firstShardEligibleAt = null;
  st.hasRunHomeAfterFirstWorld = false;
  try {
    setAltStatus &&
      (await setAltStatus({
        id: altId,
        status: 'offline',
        last_seen: Math.floor(Date.now() / 1000),
      }));
  } catch {}
}

async function runCommand(altId, raw) {
  const st = S(altId);
  const line = String(raw || '').trim();
  if (!line) throw new Error('Empty command');
  st.cmdQueue.push(line.startsWith('/') ? line : `/${line}`);
  if (st.bot?.player) drainQueue(altId);
  else enqueueLogin(altId).catch(() => {});
}

function getAltStatus(altId) {
  const st = S(altId);
  if (st.bot?.player) return 'online';
  if (st.awaitingDevice) return 'auth-wait';
  return 'offline';
}

function getAltWorld(altId) {
  return S(altId).worldPretty || '—';
}

async function startAllForGuild(guildId) {
  const alts = await listAlts(guildId);
  for (const alt of alts) {
    try {
      await startAlt(guildId, alt.id);
    } catch {}
    await sleep(RECONNECT_MIN_MS + rnd(0, LOGIN_JITTER_MS));
  }
}

function getBot(altId) {
  // Return the underlying mineflayer bot instance (or null if not connected)
  const st = S(altId);
  return st.bot || null;
}

function isOnline(altId) {
  // Simple online check used by some callers if we ever want it
  const st = S(altId);
  return !!(st.bot && st.bot.player);
}

module.exports = {
  init,
  startAlt,
  stopAlt,
  runCommand,
  getAltStatus,
  getAltWorld,
  getAltWorldUpdatedAt,
  startAllForGuild,

  // 👇 NEW exports
  getBot,
  isOnline,

  on: (...args) => altRunner.on(...args),
  once: (...args) => altRunner.once(...args),
  off: (...args) => altRunner.off(...args),
  emit: (...args) => altRunner.emit(...args),
};
