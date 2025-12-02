// src/discord/handlers/interactionCreate.js

/**
 * Central interaction router.
 * Calls each feature's handler in a fixed order.
 * A handler returns true if it processed the interaction.
 */

const { PermissionsBitField } = require('discord.js');

// Import the correct function and expose it under the name the router expects.
const {
  handleInteraction: handleConfigInteraction,
} = require('../panels/config/actions');

const wallBoard = require('../dashboards/wallCheckBoard');
const outpostBoard = require('../dashboards/outpostBoard');

const playerWhitelist = require('../../services/playerWhitelist');

// (Alt Manager will be added in next batch)
let altMgr;
try {
  altMgr = require('../dashboards/altManager');
} catch {
  altMgr = { handleAltManagerInteraction: async () => false };
}

module.exports = async function interactionCreateHandler(client, interaction) {
  try {
    if (!interaction.inGuild()) return;

    // 0) Slash commands (e.g. /whitelist)
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === 'whitelist' || cmd === 'rpostwhitelist') {
        // Both commands operate on the SAME shared whitelist.
        const listLabel = 'shared shard/outpost player alerts whitelist';

        // Permission: manage guild only
        if (
          !interaction.memberPermissions ||
          !interaction.memberPermissions.has(
            PermissionsBitField.Flags.ManageGuild
          )
        ) {
          await safeReply(
            interaction,
            '❌ You need the **Manage Server** permission to modify the whitelist.',
            true
          );
          return;
        }

        const sub = interaction.options.getSubcommand();
        const player =
          sub === 'list'
            ? null
            : (interaction.options.getString('player') || '').trim();

        if (sub !== 'list' && !player) {
          await safeReply(
            interaction,
            '❌ Please provide a valid player name.',
            true
          );
          return;
        }

        let list;
        if (sub === 'add') {
          list = playerWhitelist.add(interaction.guildId, player);
          await safeReply(
            interaction,
            `✅ Added **${player}** to the **${listLabel}**.\nCurrent: ${
              list.length
                ? list.map((n) => `\`${n}\``).join(', ')
                : '_empty_'
            }`,
            true
          );
          return;
        }

        if (sub === 'remove') {
          list = playerWhitelist.remove(interaction.guildId, player);
          await safeReply(
            interaction,
            `✅ Removed **${player}** from the **${listLabel}**.\nCurrent: ${
              list.length
                ? list.map((n) => `\`${n}\``).join(', ')
                : '_empty_'
            }`,
            true
          );
          return;
        }

        if (sub === 'list') {
          list = playerWhitelist.list(interaction.guildId);
          await safeReply(
            interaction,
            list.length
              ? `📜 **${listLabel}:**\n${list
                  .map((n) => `• \`${n}\``)
                  .join('\n')}`
              : `📜 The **${listLabel}** is currently empty.`,
            true
          );
          return;
        }

        // Unknown subcommand – just ignore
        return;
      }
    }

    // 1) Config panel (must be first for immediate config changes)
    try {
      // ✅ FIX: only pass the interaction, NOT the client
      if (await handleConfigInteraction(interaction)) return;
    } catch (e) {
      await safeReply(interaction, `⚠️ ${e.message}`, true);
      return;
    }

    // 2) Alt Manager
    try {
      if (await altMgr.handleAltManagerInteraction(interaction)) return;
    } catch (e) {
      await safeReply(interaction, `⚠️ ${e.message}`, true);
      return;
    }

    // 3) Buffer/Wall dashboard
    try {
      if (await wallBoard.handleInteraction(interaction)) return;
    } catch (e) {
      await safeReply(interaction, `⚠️ ${e.message}`, true);
      return;
    }

    // 4) Outpost dashboard
    try {
      if (await outpostBoard.handleOutpostInteraction(interaction)) return;
    } catch (e) {
      await safeReply(interaction, `⚠️ ${e.message}`, true);
      return;
    }

    // Unknown component? Help the user (and us) debug IDs.
    if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isChannelSelectMenu?.() ||
      interaction.isModalSubmit()
    ) {
      await safeReply(
        interaction,
        '⚠️ This action was not recognized by the bot (unknown component).',
        true
      );
    }
  } catch (e) {
    console.error('[interactionCreate] Unhandled error:', e);
    await safeReply(interaction, `⚠️ ${e.message}`, true);
  }
};

async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, ephemeral });
    } else {
      await interaction.reply({ content, ephemeral });
    }
  } catch {}
}
