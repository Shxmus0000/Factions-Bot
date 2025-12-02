// src/discord/registerCommands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  // /setup
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Post the config panel in this channel'),

  // /set
  new SlashCommandBuilder()
    .setName('set')
    .setDescription('Set config values quickly')
    .addSubcommand((sc) =>
      sc
        .setName('walls')
        .setDescription('Set walls channel + interval')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Walls channel')
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName('interval')
            .setDescription('Minutes between checks')
            .setMinValue(5)
            .setMaxValue(180)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('outpost')
        .setDescription('Set outpost channel + interval')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Outpost channel')
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName('interval')
            .setDescription('Minutes between checks')
            .setMinValue(5)
            .setMaxValue(180)
        )
    ),

  // /whitelist — shared for BOTH shard + rpost trackers
  new SlashCommandBuilder()
    .setName('whitelist')
    .setDescription('Manage the shard/outpost player alerts whitelist')
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Add a player to the whitelist')
        .addStringOption((o) =>
          o
            .setName('player')
            .setDescription('Exact Minecraft username')
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription('Remove a player from the whitelist')
        .addStringOption((o) =>
          o
            .setName('player')
            .setDescription('Exact Minecraft username')
            .setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName('list')
        .setDescription('Show all players on the whitelist')
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  // Fetch current app id
  const app = await rest.get(Routes.oauth2CurrentApplication());
  const appId = app.id;

  // If GUILD_ID (or DEV_GUILD_ID) is set, register as guild commands (fast propagate).
  // Otherwise, register globally.
  const guildId = process.env.GUILD_ID || process.env.DEV_GUILD_ID;

  if (guildId) {
    await rest.put(
      Routes.applicationGuildCommands(appId, guildId),
      { body: commands }
    );
    console.log(`✅ registered guild slash commands for guild ${guildId}`);
  } else {
    await rest.put(
      Routes.applicationCommands(appId),
      { body: commands }
    );
    console.log('✅ registered global slash commands');
  }
}

module.exports = {
  registerCommands,
  commands,
};
