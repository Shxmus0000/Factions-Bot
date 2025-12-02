// src/discord/panels/config/panel.js
// Thin facade that exposes ensurePanel and handleInteraction.
// Internally uses actions.js and builders.js

const actions = require('./actions');
const { buildMainEmbed } = require('./builders');

async function ensurePanel(guild) {
  // Ensure channel + post/refresh the panel
  return actions.ensurePanel(guild);
}

// Route all panel interactions from the router
async function handleInteraction(interaction) {
  return actions.handleInteraction(interaction);
}

module.exports = {
  // main panel entrypoints
  ensurePanel,
  handleInteraction,

  // 🔧 back-compat alias so older router code that calls
  // configPanel.handleConfigInteraction(...) still works
  handleConfigInteraction: handleInteraction,

  // Useful exports for bootstrapping flow (optional)
  ensurePanelChannel: actions.ensurePanelChannel,
  ensureWallChannelAndDashboard: actions.ensureWallChannelAndDashboard,
  ensureOutpostChannelAndDashboard: actions.ensureOutpostChannelAndDashboard,
  ensureAltManagerChannelAndDashboard: actions.ensureAltManagerChannelAndDashboard,
  ensureShardTrackerDefaults: actions.ensureShardTrackerDefaults,
  ensureRpostTrackerDefaults: actions.ensureRpostTrackerDefaults,
  ensurePlayerAlertChannels: actions.ensurePlayerAlertChannels,
  setDefaultAlertChannels: actions.setDefaultAlertChannels,

  // for external rendering if needed
  buildMainEmbed,
};
