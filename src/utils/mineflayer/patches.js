// src/utils/mineflayer/patches.js
// Mineflayer skin JSON hardening for 1.19+ / 1.20.x
// - Sanitizes malformed base64 "textures" values (string OR Buffer) before Mineflayer parses.
// - Intercepts both low-level 'packet' and named events (player_info / player_info_update).
// - Guards process against ONLY the known extractSkinInformation JSON error to avoid crashing.

let installedProcessGuards = false;

function installMineflayerSkinPatch(bot) {
  if (!bot || !bot._client) return;
  const client = bot._client;

  // Recursively sanitize any nested object that may contain a Mojang "properties" array
  const sanitizeTexturesOnNode = (node) => {
    try {
      if (!node || typeof node !== 'object') return;

      // If this node has a "properties" array, scan it
      if (Array.isArray(node.properties)) {
        for (const p of node.properties) {
          if (!p || p.name !== 'textures' || p.value == null) continue;

          // Value can be a Base64 string OR a Buffer in newer stacks
          let asStr = null;
          if (typeof p.value === 'string') asStr = p.value;
          else if (Buffer.isBuffer(p.value)) asStr = p.value.toString('utf8');

          if (typeof asStr === 'string') {
            try {
              const decoded = Buffer.from(asStr, 'base64').toString('utf8');
              JSON.parse(decoded); // throws on garbage
            } catch {
              // Replace with a safe empty textures JSON
              const safe = Buffer.from(JSON.stringify({ textures: {} }), 'utf8').toString('base64');
              p.value = safe;
            }
          } else {
            // Unknown type -> make it safe
            const safe = Buffer.from(JSON.stringify({ textures: {} }), 'utf8').toString('base64');
            p.value = safe;
          }
        }
      }

      // Recurse
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (!v) continue;
        if (Array.isArray(v)) v.forEach(sanitizeTexturesOnNode);
        else if (typeof v === 'object') sanitizeTexturesOnNode(v);
      }
    } catch {
      // best-effort
    }
  };

  // Handle both legacy and modern shapes:
  // - legacy: data: [ { properties: [...] } ]
  // - 1.20+: actions: [ { action: 'add_player', data: [ { properties: [...] } ] } ]
  const sanitizePacket = (data, meta) => {
    try {
      if (!meta || meta.state !== 'play') return;
      if (meta.name !== 'player_info' && meta.name !== 'player_info_update') return;
      sanitizeTexturesOnNode(data);
    } catch {
      // ignore
    }
  };

  // Install BEFORE mineflayer’s plugins if possible
  try {
    if (typeof client.prependListener === 'function') client.prependListener('packet', sanitizePacket);
    else client.on('packet', sanitizePacket);
  } catch { client.on('packet', sanitizePacket); }

  // Named-event safety net
  const hookNamed = (evt) => {
    try {
      if (typeof client.prependListener === 'function') client.prependListener(evt, sanitizeTexturesOnNode);
      else client.on(evt, sanitizeTexturesOnNode);
    } catch {
      client.on(evt, sanitizeTexturesOnNode);
    }
  };
  hookNamed('player_info');
  hookNamed('player_info_update');

  // Process guards: swallow only the known JSON crash from entities.extractSkinInformation
  if (!installedProcessGuards) {
    installedProcessGuards = true;

    const skinErrRe = /(mineflayer[\/\\]lib[\/\\]plugins[\/\\]entities\.js|extractSkinInformation).*(Unexpected token|is not valid JSON)/i;

    const maybeSwallow = (err) => {
      if (!err) return false;
      const msg = String(err.message || err || '');
      const stk = String(err.stack || '');
      if (skinErrRe.test(msg) || skinErrRe.test(stk)) {
        console.warn('[MineflayerPatch] Ignored invalid skin JSON from server.');
        return true;
      }
      return false;
    };

    process.on('uncaughtException', (err) => {
      if (maybeSwallow(err)) return;
      throw err; // unrelated errors must propagate
    });

    process.on('unhandledRejection', (reason) => {
      if (reason instanceof Error && maybeSwallow(reason)) return;
      // let others propagate
    });
  }
}

module.exports = { installMineflayerSkinPatch };
