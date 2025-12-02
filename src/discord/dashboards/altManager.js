// src/discord/dashboards/altManager.js
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} = require('discord.js');

const {
  listAlts,
  getAltById,
  insertAlt,
  updateAlt,
  deleteAlt,
  decryptAltRowSecrets,
  getAltManagerConfig,
  upsertAltManagerConfig,
} = require('../../database');

const altRunner = require('../../services/altRunner');

const IDS = {
  REFRESH: 'alts_refresh',
  ADD: 'alts_add',
  ADD_PICK_MODE: 'alts_add_pick_mode',
  MODAL_ADD_OFFLINE: 'alts_add_modal_offline',
  MODAL_ADD_MS: 'alts_add_modal_ms',
  REMOVE: 'alts_remove',
  REMOVE_PICK: 'alts_remove_pick',
  EDIT: 'alts_edit',
  EDIT_PICK: 'alts_edit_pick',
  EDIT_MODAL_PREFIX: 'alts_edit_modal_',
  CONTROL: 'alts_control',
  CONTROL_PICK: 'alts_control_pick',
  CONTROL_START_PREFIX: 'alts_control_start_',
  CONTROL_STOP_PREFIX: 'alts_control_stop_',
  CONTROL_CMD_PREFIX: 'alts_control_cmd_',
  CONTROL_CMD_MODAL_PREFIX: 'alts_control_cmd_modal_',
  CONTROL_HOME_PREFIX: 'alts_control_home_',
  CONTROL_FACTIONS_PREFIX: 'alts_control_factions_',
};

let _wiredWorldListener = false;
function wireWorldListenerOnce(client) {
  if (_wiredWorldListener) return;
  _wiredWorldListener = true;
  altRunner.on('world-changed', async ({ guildId }) => {
    try {
      const cfg = await getAltManagerConfig(guildId).catch(() => null);
      if (!cfg?.channel_id) return;
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return;
      await ensureAltManagerDashboard(guild, cfg.channel_id);
    } catch {}
  });
}

function statusEmoji(s) {
  if (s === 'online') return '🟢';
  if (s === 'auth-wait') return '🟠';
  return s === 'offline' ? '🔴' : '⚪';
}

function lineOf(alt) {
  const s = altRunner.getAltStatus(alt.id);

  const liveWorld = altRunner.getAltWorld(alt.id);
  const world = (liveWorld && liveWorld !== '—') ? liveWorld : (alt.last_world || '—');

  // NEW: live timestamp from altRunner (updated whenever shard changes)
  const liveTs = typeof altRunner.getAltWorldUpdatedAt === 'function'
    ? (altRunner.getAltWorldUpdatedAt(alt.id) || 0)
    : 0;

  // Prefer liveTs from altRunner; then DB world_updated_at; then updated_at; then last_seen.
  const tsRaw =
    liveTs ||
    alt.world_updated_at ||
    alt.updated_at ||
    alt.last_seen ||
    0;

  const ts = Number(tsRaw) || 0;
  const lastUpdated = ts ? `<t:${ts}:R>` : '`never`';

  const mode = (alt.auth_mode || 'offline');

  return `${statusEmoji(s)} — **${alt.label}** — status: \`${s}\` · world: \`${world}\` · last updated: ${lastUpdated}`;
}


function buildMain(alts) {
  const listText = alts.length
    ? alts.map(lineOf).join('\n')
    : '_No alts yet — click **Add Alt** below._';

  const embed = new EmbedBuilder()
    .setTitle('Alt Manager')
    .setColor(0xeb1102)
    .setDescription(
      [
        '**Available Alts**',                      // subtitle
        '',
        listText,                                  // alt list
        ''
      ].join('\n')
    )
    .setFooter({ text: 'Factions Bot Alt Manager' });  // subtext

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.ADD).setLabel('Add Alt').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.CONTROL).setLabel('Control Alt').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.EDIT).setLabel('Edit Alt').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.REMOVE).setLabel('Remove Alt').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.RELOAD || IDS.REFRESH).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [row] };
}

async function ensureAltManagerDashboard(guild, channelId) {
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Alt Manager channel missing or not text.');

  const alts = await listAlts(guild.id);
  const { embed, components } = buildMain(alts);

  const cfg = await getAltManagerConfig(guild.id).catch(() => null);
  if (cfg?.dashboard_message_id) {
    try {
      const msg = await channel.messages.fetch(cfg.dashboard_message_id);
      if (msg?.author?.id === guild.client.user.id) {
        await msg.edit({ embeds: [embed], components });
        return msg;
      }
    } catch {}
  }

  const sent = await channel.send({ embeds: [embed], components });
  try { await sent.pin().catch(() => {}); } catch {}
  await upsertAltManagerConfig({ guild_id: guild.id, channel_id: channel.id, dashboard_message_id: sent.id });
  return sent;
}

function selectFromAlts(customId, alts, placeholder = 'Select an alt…') {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1).setMaxValues(1);
  alts.slice(0, 25).forEach(a => {
    menu.addOptions(new StringSelectMenuOptionBuilder().setLabel(a.label).setValue(String(a.id)));
  });
  return new ActionRowBuilder().addComponents(menu);
}

function modePickerRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(IDS.ADD_PICK_MODE)
    .setPlaceholder('Choose authentication mode')
    .addOptions([
      { label: 'Microsoft (device-code)', value: 'microsoft', emoji: '🔐', description: 'Secure, posts a code + link here' },
      { label: 'Offline', value: 'offline', emoji: '📴', description: 'No Microsoft login' },
    ]);
  return new ActionRowBuilder().addComponents(menu);
}

function modalAddOffline() {
  return new ModalBuilder()
    .setCustomId(IDS.MODAL_ADD_OFFLINE)
    .setTitle('Add Alt — Offline')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('label').setLabel('Label').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('mc_username').setLabel('Minecraft Username').setStyle(TextInputStyle.Short).setRequired(true)
      ),
    );
}

function modalAddMS() {
  return new ModalBuilder()
    .setCustomId(IDS.MODAL_ADD_MS)
    .setTitle('Add Alt — Microsoft')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('label').setLabel('Label').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('msa_label').setLabel('MSA Cache Label (nickname)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('email').setLabel('Email (optional, shown as hint)').setStyle(TextInputStyle.Short).setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('password').setLabel('Password (ignored for device-code)').setStyle(TextInputStyle.Short).setRequired(false)
      ),
    );
}

function modalControlCmd(altId) {
  return new ModalBuilder()
    .setCustomId(IDS.CONTROL_CMD_MODAL_PREFIX + altId)
    .setTitle('Send Command to Alt')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('cmd').setLabel('Command or chat text').setStyle(TextInputStyle.Paragraph).setRequired(true)
      ),
    );
}

async function handleAltManagerInteraction(interaction) {
  if (!interaction.inGuild()) return false;

  try { altRunner.init(interaction.client); } catch {}
  wireWorldListenerOnce(interaction.client);

  if (interaction.isButton()) {
    switch (interaction.customId) {
      case IDS.REFRESH: {
        await interaction.deferUpdate().catch(() => {});
        const cfg = await getAltManagerConfig(interaction.guildId).catch(() => null);
        if (cfg?.channel_id) await ensureAltManagerDashboard(interaction.guild, cfg.channel_id);
        return true;
      }
      case IDS.ADD: {
        await interaction.reply({
          content: 'Choose authentication mode for the new alt:',
          components: [modePickerRow()],
          ephemeral: true,
          fetchReply: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return true;
      }
      case IDS.REMOVE: {
        const alts = await listAlts(interaction.guildId);
        await interaction.reply({
          content: 'Pick an alt to remove:',
          components: [selectFromAlts(IDS.REMOVE_PICK, alts)],
          ephemeral: true,
          fetchReply: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return true;
      }
      case IDS.EDIT: {
        const alts = await listAlts(interaction.guildId);
        await interaction.reply({
          content: 'Pick an alt to edit:',
          components: [selectFromAlts(IDS.EDIT_PICK, alts)],
          ephemeral: true,
          fetchReply: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return true;
      }
      case IDS.CONTROL: {
        const alts = await listAlts(interaction.guildId);
        if (!alts.length) {
          await interaction.reply({ content: 'No alts available.', ephemeral: true });
          setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
          return true;
        }
        await interaction.reply({
          content: 'Pick an alt to send a command:',
          components: [selectFromAlts(IDS.CONTROL_PICK, alts, 'Select an alt…')],
          ephemeral: true,
          fetchReply: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 60000);
        return true;
      }
    }

    if (interaction.customId.startsWith(IDS.CONTROL_START_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.CONTROL_START_PREFIX, ''));
      const alt = await getAltById(altId).catch(() => null);
      const label = alt?.label || `Alt ${altId}`;
      await altRunner.startAlt(interaction.guildId, altId);
      await interaction.reply({ content: `🟢 Starting **${label}**…`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }
    if (interaction.customId.startsWith(IDS.CONTROL_STOP_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.CONTROL_STOP_PREFIX, ''));
      const alt = await getAltById(altId).catch(() => null);
      const label = alt?.label || `Alt ${altId}`;
      await altRunner.stopAlt(altId);
      await interaction.reply({ content: `🔴 Stopped **${label}**.`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }
    if (interaction.customId.startsWith(IDS.CONTROL_HOME_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.CONTROL_HOME_PREFIX, ''));
      const alt = await getAltById(altId).catch(() => null);
      const label = alt?.label || `Alt ${altId}`;
      await altRunner.runCommand(altId, process.env.MC_ALT_HOME_CMD || '/home home');
      await interaction.reply({ content: `🏠 Sent home to **${label}**.`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }
    if (interaction.customId.startsWith(IDS.CONTROL_FACTIONS_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.CONTROL_FACTIONS_PREFIX, ''));
      const alt = await getAltById(altId).catch(() => null);
      const label = alt?.label || `Alt ${altId}`;
      await altRunner.runCommand(altId, '/factions');
      await interaction.reply({ content: `🏴 Sent "/factions" to **${label}**.`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }

    return false;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === IDS.ADD_PICK_MODE) {
      const v = interaction.values?.[0];
      if (v === 'microsoft') await interaction.showModal(modalAddMS());
      else await interaction.showModal(modalAddOffline());
      return true;
    }

    if (interaction.customId === IDS.REMOVE_PICK) {
      const altId = Number(interaction.values?.[0] || 0);
      const alt = altId ? await getAltById(altId) : null;
      if (!alt || alt.guild_id !== interaction.guildId) {
        await interaction.reply({ content: 'Alt not found.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }
      await deleteAlt(altId).catch(() => {});
      const cfg = await getAltManagerConfig(interaction.guildId).catch(() => null);
      if (cfg?.channel_id) await ensureAltManagerDashboard(interaction.guild, cfg.channel_id);
      await interaction.reply({ content: `🗑️ Removed **${alt.label}**.`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }

    if (interaction.customId === IDS.EDIT_PICK) {
      const altId = Number(interaction.values?.[0] || 0);
      const alt = altId ? await getAltById(altId) : null;
      if (!alt || alt.guild_id !== interaction.guildId) {
        await interaction.reply({ content: 'Alt not found.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }

      const withSecrets = decryptAltRowSecrets(alt);
      const modal = new ModalBuilder()
        .setCustomId(IDS.EDIT_MODAL_PREFIX + alt.id)
        .setTitle(`Edit Alt — ${alt.label}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('label').setLabel('Label').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(alt.label || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('mc_username').setLabel('Minecraft Username (offline)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(alt.mc_username || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('msa_label').setLabel('MSA Cache Label').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(alt.msa_label || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('email').setLabel('Email (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(withSecrets.email_plain || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('password').setLabel('Password (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(withSecrets.password_plain ? '********' : '')
          ),
        );

      await interaction.showModal(modal);
      return true;
    }

    if (interaction.customId === IDS.CONTROL_PICK) {
      const altId = Number(interaction.values?.[0] || 0);
      const alt = altId ? await getAltById(altId) : null;
      if (!alt || alt.guild_id !== interaction.guildId) {
        await interaction.reply({ content: 'Alt not found.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }
      await interaction.showModal(modalControlCmd(alt.id));
      return true;
    }

    return false;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === IDS.MODAL_ADD_OFFLINE) {
      const label = interaction.fields.getTextInputValue('label')?.trim();
      const mc_username = interaction.fields.getTextInputValue('mc_username')?.trim();
      if (!label || !mc_username) {
        await interaction.reply({ content: 'Label and Minecraft Username are required.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }

      await insertAlt({ guild_id: interaction.guildId, label, auth_mode: 'offline', mc_username });
      const cfg = await getAltManagerConfig(interaction.guildId).catch(() => null);
      if (cfg?.channel_id) await ensureAltManagerDashboard(interaction.guild, cfg.channel_id);
      await interaction.reply({ content: `✅ Alt **${label}** added (offline).`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }

    if (interaction.customId === IDS.MODAL_ADD_MS) {
        const label = interaction.fields.getTextInputValue('label')?.trim();
        const msa_label = interaction.fields.getTextInputValue('msa_label')?.trim();
        const email = (interaction.fields.getTextInputValue('email') || '').trim() || null;
        const password = (interaction.fields.getTextInputValue('password') || '').trim() || null;

        if (!label || !msa_label) {
            await interaction.reply({ content: 'Label and MSA Cache Label are required.', ephemeral: true });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
            return true;
        }

        const altId = await insertAlt({
            guild_id: interaction.guildId,
            label,
            auth_mode: 'microsoft',
            msa_label,
            email_plain: email,
            password_plain: password,
        });

        // 👇 no more "Starting Microsoft auth..." message here

        try { await altRunner.startAlt(interaction.guildId, altId); } catch {}

        await interaction.reply({
            content: `✅ Alt **${label}** created. Watch **#alt-manager** for the sign-in code.`,
            ephemeral: true,
        });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);

        const cfg = await getAltManagerConfig(interaction.guildId).catch(() => null);
        if (cfg?.channel_id) await ensureAltManagerDashboard(interaction.guild, cfg.channel_id);

        return true;
    }

    if (interaction.customId.startsWith(IDS.EDIT_MODAL_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.EDIT_MODAL_PREFIX, ''));
      const alt = await getAltById(altId).catch(() => null);
      if (!alt || alt.guild_id !== interaction.guildId) {
        await interaction.reply({ content: 'Alt not found.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }

      const label = (interaction.fields.getTextInputValue('label') || '').trim();
      const mc_username = (interaction.fields.getTextInputValue('mc_username') || '').trim();
      const msa_label = (interaction.fields.getTextInputValue('msa_label') || '').trim();
      const email = (interaction.fields.getTextInputValue('email') || '').trim();
      const password = (interaction.fields.getTextInputValue('password') || '').trim();

      await updateAlt({
        id: altId,
        label: label || null,
        mc_username: mc_username || null,
        msa_label: msa_label || null,
        email_plain: email || undefined,
        password_plain: password || undefined,
      });

      const cfg = await getAltManagerConfig(interaction.guildId).catch(() => null);
      if (cfg?.channel_id) await ensureAltManagerDashboard(interaction.guild, cfg.channel_id);
      await interaction.reply({ content: `✅ Updated **${label || alt.label}**.`, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }

    if (interaction.customId.startsWith(IDS.CONTROL_CMD_MODAL_PREFIX)) {
      const altId = Number(interaction.customId.replace(IDS.CONTROL_CMD_MODAL_PREFIX, ''));
      const cmd = interaction.fields.getTextInputValue('cmd')?.trim();
      if (!cmd) {
        await interaction.reply({ content: 'Please enter a command or chat text.', ephemeral: true });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
        return true;
      }

      const alt = await getAltById(altId).catch(() => null);
      const label = alt?.label || `Alt ${altId}`;
      await altRunner.runCommand(altId, cmd);
      await interaction.reply({ content: `📨 Sent to **${label}**: \`${cmd}\``, ephemeral: true });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 10000);
      return true;
    }

    return false;
  }

  return false;
}

module.exports = {
  ensureAltManagerDashboard,
  handleAltManagerInteraction,
};
