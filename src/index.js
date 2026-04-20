require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');
const { getBlockedUser, removeBlockedUser, upsertBlockedUser } = require('./store');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const actionLogChannelId = process.env.ACTION_LOG_CHANNEL_ID?.trim() || null;
const removeJoinMessagesOnBounce =
  (process.env.REMOVE_JOIN_MESSAGES_ON_BOUNCE ?? 'true').trim().toLowerCase() === 'true';

const TEMPLATE_FILES = {
  bounceAdded: 'bounce _added.json',
  bounceRemoved: 'bounce_removed.json',
  bounceDetected: 'bounce_detected.json'
};

const templateCache = new Map();

if (!token || !clientId) {
  throw new Error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment variables.');
}

const commands = [
  new SlashCommandBuilder()
    .setName('bounce')
    .setDescription('Add a user to the auto-kick list and kick them if currently in server.')
    .addStringOption((option) =>
      option
        .setName('user')
        .setDescription('User mention, @handle, or Discord user ID.')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Reason for the ban.')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('member_id')
        .setDescription('Optional external member ID (non-Discord unique number).')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('unbounce')
    .setDescription('Remove a user from the auto-kick list.')
    .addStringOption((option) =>
      option
        .setName('user')
        .setDescription('User mention, @handle, or Discord user ID.')
        .setRequired(true)
    )
].map((command) => command.toJSON());

function parseMentionOrId(rawInput) {
  const input = rawInput.trim();
  const mentionMatch = input.match(/^<@!?(\d{17,20})>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  if (/^\d{17,20}$/.test(input)) {
    return input;
  }

  return null;
}

function hasAdminRoleOrPermission(interaction) {
  const member = interaction.member;
  if (!member) {
    return false;
  }

  if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  return member.roles?.cache?.some((role) => /admin/i.test(role.name)) ?? false;
}

async function resolveUserIdFromInput(guild, rawInput) {
  const directId = parseMentionOrId(rawInput);
  if (directId) {
    return { userId: directId };
  }

  const normalized = rawInput.trim().replace(/^@/, '').toLowerCase();
  if (!normalized) {
    return { error: 'You must provide a valid @handle, mention, or user ID.' };
  }

  const candidates = [];

  const fromCache = guild.members.cache.filter((member) => {
    const username = member.user.username.toLowerCase();
    const globalName = (member.user.globalName || '').toLowerCase();
    const displayName = member.displayName.toLowerCase();
    const tag = member.user.tag.toLowerCase();

    return (
      username === normalized ||
      globalName === normalized ||
      displayName === normalized ||
      tag === normalized ||
      tag.startsWith(`${normalized}#`)
    );
  });

  for (const member of fromCache.values()) {
    candidates.push(member.user.id);
  }

  if (candidates.length === 0) {
    const searchResults = await guild.members.search({ query: normalized, limit: 10 }).catch(() => null);
    if (searchResults) {
      for (const member of searchResults.values()) {
        candidates.push(member.user.id);
      }
    }
  }

  const uniqueIds = [...new Set(candidates)];
  if (uniqueIds.length === 1) {
    return { userId: uniqueIds[0] };
  }

  if (uniqueIds.length > 1) {
    return { error: 'Multiple users matched that handle. Please use a mention or user ID.' };
  }

  return { error: 'Could not resolve that user. Please use a mention or Discord user ID.' };
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered slash commands in guild ${guildId}.`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('Registered global slash commands.');
}

function deepReplace(value, replacements) {
  if (typeof value === 'string') {
    let output = value;
    for (const [token, replacement] of Object.entries(replacements)) {
      output = output.split(token).join(replacement);
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepReplace(entry, replacements));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = deepReplace(item, replacements);
    }
    return out;
  }

  return value;
}

async function getTemplatePayload(templateKey, replacements) {
  const filename = TEMPLATE_FILES[templateKey];
  if (!filename) {
    return null;
  }

  if (!templateCache.has(templateKey)) {
    const filePath = path.resolve(process.cwd(), 'bounce_templates', filename);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    templateCache.set(templateKey, parsed);
  }

  const template = templateCache.get(templateKey);
  const replaced = deepReplace(template, replacements);
  const embeds = Array.isArray(replaced.embeds)
    ? replaced.embeds.map((embed) => ({
        title: embed.title,
        description: embed.description,
        color: embed.color,
        fields: Array.isArray(embed.fields)
          ? embed.fields.map((field) => ({
              name: field.name,
              value: field.value,
              inline: Boolean(field.inline)
            }))
          : [],
        timestamp: new Date().toISOString()
      }))
    : [];

  return {
    content: replaced.content || '',
    tts: Boolean(replaced.tts),
    embeds
  };
}

async function sendActionLogPayload(guild, payload) {
  if (!actionLogChannelId) {
    return;
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return;
  }

  const channel = await guild.channels.fetch(actionLogChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  const perms = channel.permissionsFor(me);
  if (
    !perms?.has(PermissionFlagsBits.ViewChannel) ||
    !perms.has(PermissionFlagsBits.SendMessages) ||
    !perms.has(PermissionFlagsBits.EmbedLinks)
  ) {
    return;
  }

  await channel.send(payload).catch(() => null);
}

async function resolveUserLogLabel(guild, userId) {
  const fromMember = await guild.members.fetch(userId).catch(() => null);
  if (fromMember) {
    return `${fromMember.user.tag} (${fromMember.user.id})`;
  }

  const fromUser = await client.users.fetch(userId).catch(() => null);
  if (fromUser) {
    return `${fromUser.tag} (${fromUser.id})`;
  }

  return `unknown-handle (${userId})`;
}

async function resolveTargetUsername(guild, userId) {
  const fromMember = await guild.members.fetch(userId).catch(() => null);
  if (fromMember) {
    return fromMember.user.username;
  }

  const fromUser = await client.users.fetch(userId).catch(() => null);
  if (fromUser) {
    return fromUser.username;
  }

  return 'unknown-handle';
}

function applyOutcomeToPayload(payload, outcome, failureReason) {
  const out = JSON.parse(JSON.stringify(payload));
  const firstEmbed = out.embeds?.[0];
  if (!firstEmbed) {
    return out;
  }

  if (outcome === 'success') {
    firstEmbed.title = `${firstEmbed.title} - Success`;
    return out;
  }

  firstEmbed.title = `${firstEmbed.title} - Failure`;
  if (!Array.isArray(firstEmbed.fields)) {
    firstEmbed.fields = [];
  }

  firstEmbed.fields.push({
    name: 'Failure Reason',
    value: failureReason || 'Operation failed.',
    inline: false
  });

  return out;
}

async function sendCommandOutcomeLog({
  interaction,
  templateKey,
  outcome,
  targetUserLabel,
  targetUserId,
  requestorLabel,
  reason,
  failureReason
}) {
  if (!interaction.inGuild()) {
    return;
  }

  const payload = await getTemplatePayload(templateKey, {
    '[username]': targetUserLabel || 'unknown',
    '[user ID]': targetUserId || 'unknown',
    '[requesting user]': requestorLabel,
    '[requestor]': requestorLabel,
    '[reason]': reason || failureReason || 'N/A',
    '[time]': new Date().toISOString()
  }).catch(() => null);

  if (!payload) {
    return;
  }

  const finalPayload = applyOutcomeToPayload(payload, outcome, failureReason);
  await sendActionLogPayload(interaction.guild, finalPayload);
}

async function sendDetectedBounceLog({ member, blocked, outcome }) {
  const requesterLabel = blocked.addedBy
    ? await resolveUserLogLabel(member.guild, blocked.addedBy)
    : 'unknown-handle (unknown-id)';

  const payload = await getTemplatePayload('bounceDetected', {
    '[username]': member.user.tag,
    '[user ID]': member.user.id,
    '[time]': new Date().toISOString(),
    '[requestor]': requesterLabel,
    '[reason]': blocked.reason || 'N/A'
  }).catch(() => null);

  if (!payload) {
    return;
  }

  const finalPayload = applyOutcomeToPayload(
    payload,
    outcome,
    outcome === 'failure' ? 'Could not bounce user during join enforcement.' : null
  );

  await sendActionLogPayload(member.guild, finalPayload);
}

async function removeJoinMessagesForMember(member) {
  const guild = member.guild;
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return;
  }

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) {
    return;
  }

  const cutoffTimestamp = Date.now() - 5 * 60 * 1000;

  let deletedCount = 0;

  for (const channel of channels.values()) {
    if (!channel || channel.type !== ChannelType.GuildText) {
      continue;
    }

    const perms = channel.permissionsFor(me);
    if (
      !perms?.has(PermissionFlagsBits.ViewChannel) ||
      !perms.has(PermissionFlagsBits.ReadMessageHistory) ||
      !perms.has(PermissionFlagsBits.ManageMessages)
    ) {
      continue;
    }

    const recentMessages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!recentMessages) {
      continue;
    }

    const matches = recentMessages.filter(
      (message) =>
        message.type === MessageType.UserJoin &&
        message.author?.id === member.user.id &&
        message.createdTimestamp >= cutoffTimestamp
    );

    for (const message of matches.values()) {
      const deleted = await message.delete().then(() => true).catch(() => false);
      if (deleted) {
        deletedCount += 1;
      }
    }
  }

  return deletedCount;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!['bounce', 'unbounce'].includes(interaction.commandName)) {
    return;
  }

  const userInput = interaction.options.getString('user', true);
  const requestorLabel = `${interaction.user.tag} (${interaction.user.id})`;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!hasAdminRoleOrPermission(interaction)) {
    await sendCommandOutcomeLog({
      interaction,
      templateKey: interaction.commandName === 'bounce' ? 'bounceAdded' : 'bounceRemoved',
      outcome: 'failure',
      targetUserLabel: userInput,
      targetUserId: 'unknown',
      requestorLabel,
      failureReason: 'Missing admin permission/role.',
      reason: interaction.commandName === 'bounce' ? interaction.options.getString('reason') || 'N/A' : 'N/A'
    });

    await interaction.reply({
      content: 'Only admins can use this command.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const resolved = await resolveUserIdFromInput(interaction.guild, userInput);
  if (resolved.error) {
    await sendCommandOutcomeLog({
      interaction,
      templateKey: interaction.commandName === 'bounce' ? 'bounceAdded' : 'bounceRemoved',
      outcome: 'failure',
      targetUserLabel: userInput,
      targetUserId: 'unknown',
      requestorLabel,
      failureReason: resolved.error,
      reason: interaction.commandName === 'bounce' ? interaction.options.getString('reason') || 'N/A' : 'N/A'
    });

    await interaction.reply({ content: resolved.error, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = resolved.userId;
  const targetUserLabel = await resolveTargetUsername(interaction.guild, userId);

  if (interaction.commandName === 'bounce') {
    const reason = interaction.options.getString('reason', true).trim();
    const memberId = interaction.options.getString('member_id');

    if (!reason) {
      await sendCommandOutcomeLog({
        interaction,
        templateKey: 'bounceAdded',
        outcome: 'failure',
        targetUserLabel,
        targetUserId: userId,
        requestorLabel,
        reason,
        failureReason: 'Reason is required and cannot be empty.'
      });

      await interaction.reply({
        content: 'Reason is required and cannot be empty.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await upsertBlockedUser(userId, {
      reason,
      memberId: memberId ? memberId.trim() : null,
      addedBy: interaction.user.id,
      addedAt: new Date().toISOString()
    });

    const joinedMember = await interaction.guild.members.fetch(userId).catch(() => null);
    if (joinedMember) {
      await joinedMember
        .kick(`Blocked list enforcement: ${reason}`)
        .catch((error) => console.warn(`Failed to kick ${userId}:`, error.message));
    }

    await interaction.reply({
      content: `User ${userId} is now blocked. They will be kicked on join.${memberId ? ` External member ID: ${memberId}.` : ''}`,
      flags: MessageFlags.Ephemeral
    });

    await sendCommandOutcomeLog({
      interaction,
      templateKey: 'bounceAdded',
      outcome: 'success',
      targetUserLabel,
      targetUserId: userId,
      requestorLabel,
      reason: `${reason}${memberId ? ` | member_id: ${memberId}` : ''}`
    });
    return;
  }

  const removed = await removeBlockedUser(userId);
  if (!removed) {
    await sendCommandOutcomeLog({
      interaction,
      templateKey: 'bounceRemoved',
      outcome: 'failure',
      targetUserLabel,
      targetUserId: userId,
      requestorLabel,
      reason: 'N/A',
      failureReason: 'User is not currently in the bounce list.'
    });

    await interaction.reply({
      content: `User ${userId} was not in the blocked list.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content: `User ${userId} was removed from the blocked list.`,
    flags: MessageFlags.Ephemeral
  });

  await sendCommandOutcomeLog({
    interaction,
    templateKey: 'bounceRemoved',
    outcome: 'success',
    targetUserLabel,
    targetUserId: userId,
    requestorLabel,
    reason: 'N/A'
  });
});

client.on('guildMemberAdd', async (member) => {
  const blocked = await getBlockedUser(member.user.id);
  if (!blocked) {
    return;
  }

  let removedBeforeKick = 0;
  if (removeJoinMessagesOnBounce) {
    removedBeforeKick = await removeJoinMessagesForMember(member).catch((error) => {
      console.warn(`Failed to remove join messages for ${member.user.id}:`, error.message);
      return 0;
    });
  }

  let kickedOnJoin = false;

  await member
    .kick(`Blocked list enforcement: ${blocked.reason}`)
    .then(() => {
      kickedOnJoin = true;
    })
    .catch((error) => console.warn(`Failed to auto-kick ${member.user.id}:`, error.message));

  await sendDetectedBounceLog({
    member,
    blocked: {
      ...blocked,
      reason: `${blocked.reason}${blocked.memberId ? ` | member_id: ${blocked.memberId}` : ''}`
    },
    outcome: kickedOnJoin ? 'success' : 'failure'
  });

  if (removeJoinMessagesOnBounce) {
    setTimeout(() => {
      removeJoinMessagesForMember(member)
        .then(() => null)
        .catch((error) =>
          console.warn(`Delayed join-message cleanup failed for ${member.user.id}:`, error.message)
        );
    }, 2000);
  }
});

(async () => {
  await registerCommands();
  await client.login(token);
})();
