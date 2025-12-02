// Simple helper if you want to plug multiple routers later.
// Currently unused by default; you can require() it in index.js if you prefer.
module.exports = function composeRouters(...routers) {
  return async function route(interaction) {
    for (const r of routers) {
      try {
        const handled = await r(interaction);
        if (handled) return true;
      } catch (e) {
        console.error('[interaction router] sub-router error:', e);
      }
    }
    return false;
  };
};
