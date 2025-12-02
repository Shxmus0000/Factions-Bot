// ========================================
// File: src/services/trackerCore.js
// Shared implementation used by shardTracker & rpostShardTracker
// ========================================
const { EmbedBuilder, ChannelType } = require('discord.js');
const { setTimeout: sleep } = require('timers/promises');
const AltRunner = require('./altRunner'); // uses src/services/altRunner/index.js
const playerWhitelist = require('./playerWhitelist');

// ---------- knobs ----------
const TAB_COMPLETE_CMD = '/a ';
const MAX_LOOKUPS = 80;
const BETWEEN_LOOKUPS_MS = 250;
// NOTE: we no longer use /f who spam for factions,
// but we keep some constants around in case you ever want it back.
const LOOKUP_TIMEOUT_MS = 4500;
const FACTION_CACHE_TTL_MS = 10 * 60 * 1000;
const NO_FACTION_TAG = '__NO_FACTION__';
const EMBED_COLOR = 0x5865F2;
const STARTUP_DEBOUNCE_MS = 2000;

// Toggle if you ever re-enable faction lookups (currently disabled for rule safety).
const ENABLE_FACTION_LOOKUPS = false;

// ---------- in-memory guards ----------
const memoryLastRunMs = new Map();
const memoryPrevMsgId = new Map();
const memoryPrevNames = new Map(); // key: `${kind}:${guildId}` -> [names]

// in-memory faction cache (per-process)
const factionCache = new Map();

const nowMs = () => Date.now();
const normalizePlayerName = (n) => String(n || '').trim();
const cacheKey = (n) => normalizePlayerName(n).toLowerCase();

function getCachedFaction(player) {
  const key = cacheKey(player);
  const hit = factionCache.get(key);
  if (!hit) return null;
  if (nowMs() - hit.at > FACTION_CACHE_TTL_MS) {
    factionCache.delete(key);
    return null;
  }
  return hit.faction;
}
function setCachedFaction(player, faction) {
  factionCache.set(cacheKey(player), { faction, at: nowMs() });
}

function waitForFactionHeaderOrNoFaction(mc, player, timeoutMs = LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const headerRe = /^\s*-{2,}\s*\[\s*(.+?)\s*\]\s*-{2,}\s*$/;
    const noFactionRe = /^✘\s+The\s+faction\s+"[^"]+"\s+does\s+not\s+exist\./i;

    const onString = (text) => {
      if (finished) return;
      const line = String(text || '').trim();
      if (!line) return;
      const m = headerRe.exec(line);
      if (m) { finished = true; cleanup(); return resolve(m[1]); }
      if (noFactionRe.test(line)) { finished = true; cleanup(); return resolve(NO_FACTION_TAG); }
    };

    const onMsg = (cm) => {
      if (finished) return;
      try {
        const line = (cm && typeof cm.toString === 'function') ? cm.toString().trim() : '';
        if (!line) return;
        const m = headerRe.exec(line);
        if (m) { finished = true; cleanup(); return resolve(m[1]); }
        if (noFactionRe.test(line)) { finished = true; cleanup(); return resolve(NO_FACTION_TAG); }
      } catch {}
    };

    const cleanup = () => {
      clearTimeout(timer);
      try { mc?.off?.('messagestr', onString); } catch {}
      try { mc?.off?.('message', onMsg); } catch {}
    };

    try { mc?.on?.('messagestr', onString); } catch {}
    try { mc?.on?.('message', onMsg); } catch {}

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true; cleanup(); resolve(null);
    }, timeoutMs);
  });
}

async function getFactionOfPlayer(mc, player) {
  // Disabled to comply with new server rules; we do NOT spam /f who anymore.
  if (!ENABLE_FACTION_LOOKUPS) return null;

  const cached = getCachedFaction(player);
  if (cached) return cached;

  try { mc.chat(`/f who ${player}`); } catch { return null; }

  const result = await waitForFactionHeaderOrNoFaction(mc, player, LOOKUP_TIMEOUT_MS);
  if (result) setCachedFaction(player, result);
  return result;
}

function bulletsFor(names, maxLen = 1024) {
  if (!names?.length) return ['_None_'];
  const bullet = (n) => `• ${n}`;
  const chunks = [];
  let buf = '';
  for (const n of names) {
    const line = bullet(n);
    if ((buf ? buf.length + 1 : 0) + line.length > maxLen) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function addFactionFields(embed, grouped) {
  const entries = Array.from(grouped.entries())
    .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));

  const MAX_FIELDS = 25;
  let used = 0;

  for (let i = 0; i < entries.length; i++) {
    const [faction, members] = entries[i];
    const parts = bulletsFor(members, 1024);
    for (let j = 0; j < parts.length; j++) {
      const fname = j === 0 ? `${faction} (${members.length})` : `${faction} (cont.)`;
      embed.addFields({ name: fname, value: parts[j] });
      used++;
      if (used >= MAX_FIELDS) return used;
    }
  }
  return used;
}

async function ensureAlertsChannelForKind(guild, kind) {
  const name = kind === 'rpost' ? 'rpost-player-alerts' : 'shard-player-alerts';

  try { await guild.channels.fetch(); } catch {}

  let ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name
  );
  if (ch) return ch;

  try {
    ch = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      reason: `Auto-create ${kind} player alerts channel`,
    });
    return ch;
  } catch (e) {
    console.warn(
      `[${kind.toUpperCase()} Tracker] Failed to create alerts channel "${name}" in ${guild.name}:`,
      e?.message || e
    );
    return null;
  }
}

/**
 * Shared runner
 * @param {Discord.Client} client
 * @param {string} guildId
 * @param {'shard'|'rpost'} kind
 * @param {object} db  { getConfig, upsertConfig, getGuildConfig }
 * @param {object} ui  { titlePrefix, footerText, altField: 'shard_checker_alt_id' | 'rpost_checker_alt_id' }
 */
async function runOnceForGuild(client, guildId, kind, db, ui) {
  const startedAtMs = nowMs();
  const startedAtSec = Math.floor(startedAtMs / 1000);

  // In-process startup guard (avoid double-runs)
  const localKey = `${kind}:${guildId}`;
  const prevLocal = memoryLastRunMs.get(localKey) || 0;
  if (startedAtMs - prevLocal < STARTUP_DEBOUNCE_MS) return;
  memoryLastRunMs.set(localKey, startedAtMs);

  const scfg = await db.getConfig(guildId).catch(() => null);
  if (!scfg?.enabled || !scfg?.channel_id) return;

  // Interval guard (on top of scheduler)
  const intervalMin = Number(scfg.interval_minutes) > 0 ? Number(scfg.interval_minutes) : 5;
  const nextAllowedSec = Number(scfg.last_run_at || 0) + intervalMin * 60;
  if (startedAtSec < nextAllowedSec) return;

  // Claim the interval early
  await db.upsertConfig({ guild_id: guildId, last_run_at: startedAtSec }).catch(() => {});

  // Resolve assigned checker alt
  const gcfg = await db.getGuildConfig(guildId).catch(() => null);
  const checkerAltId = Number(gcfg?.[ui.altField] || 0);
  if (!checkerAltId) return;

  // Directly grab the bot from AltRunner — this is the *real* source of truth.
  const mc = AltRunner.getBot?.(checkerAltId);
  if (!mc || typeof mc.chat !== 'function' || typeof mc.tabComplete !== 'function') {
    console.warn(
      `[${kind.toUpperCase()} Tracker] No usable bot instance for alt ${checkerAltId}; skipping this run.`
    );
    return;
  }

  // Optional: make sure it's at home / in a safe state
  try {
    if (AltRunner.ensureHomeForAlt) {
      await AltRunner.ensureHomeForAlt(checkerAltId, {
        attempts: 1,
        attemptGapMs: 3000,
      }).catch(() => {});
    }
  } catch {}

  // Discord guild + channel
  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const channel =
    guild.channels.cache.get(scfg.channel_id) ||
    (await guild.channels.fetch(scfg.channel_id).catch(() => null));
  if (!channel) return;

  // 1) Player names via tab-complete
  let names = [];
  try {
    const completions = await mc.tabComplete(TAB_COMPLETE_CMD, true, false, 5000);
    names = (completions || [])
      .map((c) => (c?.match || '').trim())
      .filter((name) => /^[a-zA-Z0-9_]{3,16}$/.test(name));
  } catch (e) {
    console.warn(
      `[${kind.toUpperCase()} Tracker] tabComplete failed for alt ${checkerAltId}:`,
      e?.message || e
    );
  }

  const uniqueNames = Array.from(new Set(names)).slice(0, MAX_LOOKUPS);
  const players = uniqueNames.map(normalizePlayerName);

  // 2) Whitelist diffing (joins / leaves) using SHARED whitelist
  const memKey = `${kind}:${guildId}`;
  const prevNames = memoryPrevNames.get(memKey) || [];
  const prevSet = new Set(prevNames.map((n) => n.toLowerCase()));
  const currSet = new Set(players.map((n) => n.toLowerCase()));

  const joined = players.filter((n) => !prevSet.has(n.toLowerCase()));
  const left = prevNames.filter((n) => !currSet.has(n.toLowerCase()));

  memoryPrevNames.set(memKey, players);

  // Shared list for both trackers
  const watchList = playerWhitelist.list(guildId);
  const watchSet = new Set(watchList.map((n) => n.toLowerCase()));

  const joinedWatched = joined.filter((n) => watchSet.has(n.toLowerCase()));
  const leftWatched = left.filter((n) => watchSet.has(n.toLowerCase()));

  if ((joinedWatched.length || leftWatched.length) && guild) {
    const alertsChannel = await ensureAlertsChannelForKind(guild, kind);
    if (alertsChannel) {
      const areaLabel =
        kind === 'rpost' ? 'Raiding Outpost shard' : 'shard';

      for (const n of joinedWatched) {
        await alertsChannel
          .send(`🔴 **${n}** has **entered** the ${areaLabel}, keep an eye out.`)
          .catch(() => {});
      }
      for (const n of leftWatched) {
        await alertsChannel
          .send(`🟢 **${n}** has **left** the ${areaLabel}, what a good boy.`)
          .catch(() => {});
      }
    }
  }

  // 3) Build embed (players list only; no /f who spam)
  const world = AltRunner.getAltWorld?.(checkerAltId) || 'Unknown';
  const totalPlayers = players.length;

  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      `${ui.titlePrefix} - ${totalPlayers} Player${totalPlayers === 1 ? '' : 's'} in ${world}`
    )
    .setTimestamp(now)
    .setFooter({
      text: `${ui.footerText} • Last update: <t:${nowUnix}:t>`,
    });

  const chunks = bulletsFor(players, 1024);
  chunks.slice(0, 25).forEach((chunk, idx) => {
    embed.addFields({
      name:
        idx === 0
          ? `Players (${totalPlayers})`
          : `Players (cont.)`,
      value: chunk,
    });
  });

  // 4) Post/edit (reuse previous message to avoid spam)
  let prevId = scfg.previous_message_id || memoryPrevMsgId.get(memKey) || null;
  let msg = null;

  if (prevId) {
    const prev = await channel.messages.fetch(prevId).catch(() => null);
    if (prev) {
      msg = await prev.edit({ embeds: [embed] }).catch(() => null);
      if (!msg) {
        await prev.delete().catch(() => {});
      }
    }
  }

  if (!msg) {
    msg = await channel.send({ embeds: [embed] });
  }

  if (msg?.id) {
    memoryPrevMsgId.set(memKey, msg.id);
    await db
      .upsertConfig({
        guild_id: guildId,
        previous_message_id: msg.id,
        // last_run_at already written above
      })
      .catch(() => {});
  }
}

module.exports = { runOnceForGuild };
