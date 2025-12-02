// src/services/raidAlerts/index.js
// Detects raid alert messages in the configured channel and pings region roles.

const { Events } = require('discord.js');

// -------------------------------
//  ENV CONFIG
// -------------------------------
const ENABLED = (process.env.RAID_ALERT_ENABLED || 'true').toLowerCase() === 'true';
const ALERT_CHANNEL_ID = process.env.RAID_ALERT_CHANNEL_ID || null;
const RAW_ROLE_CONFIG = process.env.RAID_ALERT_ROLE_IDS || '';
const MIN_ALERT_COOLDOWN_MS = parseInt(process.env.RAID_ALERT_COOLDOWN_MS || '60000', 10);

// -------------------------------
//  Parse RAID_ALERT_ROLE_IDS
//  Supports either:
//    JSON: {"AU":"123","EU":"456","NA":"789"}
//    or    AU:123,EU:456,NA:789
// -------------------------------
function parseRoleMap(raw) {
  if (!raw) return {};

  // Try JSON first
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (/^\d+$/.test(String(v))) out[k.toUpperCase()] = String(v);
      }
      return out;
    } catch (e) {
      console.warn('[raidAlerts] Failed to parse JSON RAID_ALERT_ROLE_IDS:', e?.message || e);
    }
  }

  // Fallback: AU:123,EU:456,NA:789
  const map = {};
  raw.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const [key, id] = pair.split(':').map(x => x.trim());
      if (!key || !id) return;
      if (/^\d+$/.test(id)) map[key.toUpperCase()] = id;
    });

  return map;
}

const REGION_ROLE_MAP = parseRoleMap(RAW_ROLE_CONFIG);

// -------------------------------
//  Region Selection Logic (UTC)
// -------------------------------
function pickRegionsForUtcDate(date) {
  const h = date.getUTCHours();
  const regions = new Set();

  // Very simple heuristic:
  // AU: UTC 20 → 08
  if (h >= 20 || h < 8) regions.add('AU');

  // EU: UTC 06 → 22
  if (h >= 6 && h < 22) regions.add('EU');

  // NA: UTC 13 → 05
  if (h >= 13 || h < 5) regions.add('NA');

  return Array.from(regions);
}

// -------------------------------
//  Extract readable text from a message
//  (content + embed titles/descriptions/fields)
// -------------------------------
function getMessageText(message) {
  let out = message.content || '';

  if (Array.isArray(message.embeds) && message.embeds.length) {
    for (const e of message.embeds) {
      if (e.title) out += '\n' + e.title;
      if (e.description) out += '\n' + e.description;
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f.name) out += '\n' + f.name;
          if (f.value) out += '\n' + f.value;
        }
      }
      if (e.footer?.text) out += '\n' + e.footer.text;
    }
  }

  return out.trim();
}

// -------------------------------
//  Alert Matcher
//  We no longer REQUIRE webhookId —
//  we just match the known patterns.
// -------------------------------
function isRaidAlertMessage(message) {
  const text = getMessageText(message).toLowerCase();
  if (!text) return false;

  const hasTnt = text.includes('tnt fired by');
  const hasOutpost = text.includes('raiding outpost') || text.includes('outpost');

  return hasTnt && hasOutpost;
}


// Cooldown per channel to avoid spam
const lastPingByChannelId = new Map();

// -------------------------------
//  Handle Alert
// -------------------------------
async function handleRaidAlert(message) {
  if (!Object.keys(REGION_ROLE_MAP).length) {
    console.warn('[raidAlerts] No region roles configured (RAID_ALERT_ROLE_IDS). Skipping alert.');
    return;
  }

  const now = message.createdAt ?? new Date();
  const nowMs = now.getTime();

  const last = lastPingByChannelId.get(message.channelId) || 0;
  if (nowMs - last < MIN_ALERT_COOLDOWN_MS) {
    console.log('[raidAlerts] Cooldown active for channel', message.channelId);
    return;
  }

  const regions = pickRegionsForUtcDate(now);
  const roleIds = regions
    .map(r => REGION_ROLE_MAP[r])
    .filter(Boolean);

  if (!roleIds.length) {
    console.warn('[raidAlerts] No roles found for inferred regions:', regions);
    return;
  }

  const pingText = roleIds.map(id => `<@&${id}>`).join(' ');

  console.log(
    '[raidAlerts] Sending raid alert ping in channel',
    message.channelId,
    'regions =',
    regions,
    'roles =',
    roleIds
  );

  try {
    await message.reply({
      content: `${pingText}\nRaid alert detected at **${now.toUTCString()}**.`,
      allowedMentions: {
        parse: [],   // no @everyone/@here
        roles: roleIds,
      },
    });
    lastPingByChannelId.set(message.channelId, nowMs);
  } catch (e) {
    console.warn('[raidAlerts] Failed to post alert reply:', e?.message || e);
  }
}

// -------------------------------
//  Shared handler for create/update
// -------------------------------
async function onAnyMessage(raw, isUpdate = false) {
  if (!raw) return;

  let message = raw;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch (e) {
      console.warn('[raidAlerts] Failed to fetch partial message:', e?.message || e);
      return;
    }
  }

  // Ignore DMs / non-guild
  if (!message.guildId) return;

  // Restrict to specific channel if configured
  if (ALERT_CHANNEL_ID && message.channelId !== ALERT_CHANNEL_ID) return;

  // Ignore our own bot messages (but allow webhooks)
  if (message.author && message.author.bot && !message.webhookId) return;

  const text = getMessageText(message);
  console.log(
    `[raidAlerts] ${isUpdate ? 'UPDATE' : 'CREATE'} in #${message.channelId} (guild ${message.guildId}) webhook=${!!message.webhookId} contentPreview="${text.slice(0, 120)}"`
  );

  if (!isRaidAlertMessage(message)) return;

  console.log('[raidAlerts] Matched raid alert message, handling…');
  await handleRaidAlert(message);
}

// -------------------------------
//  Init
// -------------------------------
let wired = false;

function init(client) {
  if (wired) return;
  wired = true;

  if (!ENABLED) {
    console.log('[raidAlerts] Disabled via RAID_ALERT_ENABLED env.');
    return;
  }

  console.log('[raidAlerts] Initialising…');
  console.log('[raidAlerts] ALERT_CHANNEL_ID:', ALERT_CHANNEL_ID || '(none)');
  console.log('[raidAlerts] REGION_ROLE_MAP:', REGION_ROLE_MAP);
  console.log('[raidAlerts] MIN_ALERT_COOLDOWN_MS:', MIN_ALERT_COOLDOWN_MS);

  client.on(Events.MessageCreate, (msg) => {
    onAnyMessage(msg, false).catch((e) =>
      console.warn('[raidAlerts] Error in MessageCreate handler:', e?.message || e)
    );
  });

  client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    onAnyMessage(newMsg, true).catch((e) =>
      console.warn('[raidAlerts] Error in MessageUpdate handler:', e?.message || e)
    );
  });

  console.log('[raidAlerts] Listeners registered (messageCreate + messageUpdate).');
}

module.exports = { init };
