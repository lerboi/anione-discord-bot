require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags } = require('discord.js');
const { fetch } = require('undici');

const express = require('express');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

const PAID_ROLE_ID = process.env.PAID_ROLE_ID;
const FREE_ROLE_ID = process.env.FREE_ROLE_ID;
const API_BASE_URL = process.env.API_BASE_URL;
const API_KEY = process.env.DISCORD_API_KEY;

// Register slash commands
const commands = [
  {
    name: 'link-account',
    description: 'Get a code to link your Anione account',
  },
  {
    name: 'verify',
    description: 'Manually verify your account status and update roles',
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
})();

// Bot ready event
client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
});

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'link-account') {
    await handleLinkAccount(interaction);
  } else if (commandName === 'verify') {
    await handleVerify(interaction);
  }
});

// Handle new member joins
client.on('guildMemberAdd', async (member) => {
  console.log(`👋 New member joined: ${member.user.tag}`);
  await assignRolesByDiscordId(member);
});

async function handleLinkAccount(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const response = await fetch(`${API_BASE_URL}/api/discord/initiate-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-discord-api-key': API_KEY,
      },
      body: JSON.stringify({
        discord_id: interaction.user.id,
      }),
    });

    const textResponse = await response.text();
    
    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON:', textResponse);
      await interaction.editReply({
        content: '❌ Server returned an invalid response. Please contact support.',
      });
      return;
    }

    if (response.ok) {
      const expiresAt = new Date(data.expires_at);
      const expiresInMinutes = Math.round((expiresAt - new Date()) / 60000);

      await interaction.editReply({
        content: `🔗 **Your Linking Code:** \`${data.code}\`\n\n` +
                 `📝 **Instructions:**\n` +
                 `1. Go to https://www.anione.me and log in\n` +
                 `2. Navigate to Profile → Connect Accounts\n` +
                 `3. Enter the code above\n\n` +
                 `⏰ This code expires in ${expiresInMinutes} minutes.`,
      });
    } else if (response.status === 409 && data.already_linked) {
      await interaction.editReply({
        content: '✅ Your Discord account is already linked to an Anione account!',
      });
    } else {
      await interaction.editReply({
        content: `❌ Error: ${data.error || 'Failed to generate code. Please try again.'}`,
      });
    }
  } catch (error) {
    console.error('❌ Error in /link-account:', error);
    await interaction.editReply({
      content: '❌ An error occurred. Please try again later.',
    });
  }
}

// /verify command handler
async function handleVerify(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const member = interaction.member;
    const status = await checkUserStatus(interaction.user.id);

    if (status === 'not_found') {
      await interaction.editReply({
        content: '❌ No linked account found. Use `/link-account` to get started!',
      });
      return;
    }

    await assignRoles(member, status);

    const roleEmoji = status === 'paid' ? '👑' : '🆓';
    const roleName = status === 'paid' ? 'Paid Member' : 'Free Member';

    await interaction.editReply({
      content: `✅ ${roleEmoji} Your roles have been updated! You are a **${roleName}**.`,
    });
  } catch (error) {
    console.error('Error in /verify:', error);
    await interaction.editReply({
      content: '❌ An error occurred while verifying your account.',
    });
  }
}

// Check user status via API
async function checkUserStatus(discordId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/discord/check-status/${discordId}`, {
      headers: {
        'x-discord-api-key': API_KEY,
      },
    });

    const data = await response.json();
    return data.status; // 'paid', 'free', or 'not_found'
  } catch (error) {
    console.error('Error checking user status:', error);
    return 'not_found';
  }
}

// Assign roles based on user status
async function assignRoles(member, status) {
  try {
    if (status === 'paid') {
      // Add paid role, remove free role
      if (FREE_ROLE_ID && member.roles.cache.has(FREE_ROLE_ID)) {
        await member.roles.remove(FREE_ROLE_ID);
      }
      if (PAID_ROLE_ID && !member.roles.cache.has(PAID_ROLE_ID)) {
        await member.roles.add(PAID_ROLE_ID);
      }
      console.log(`✅ Assigned Paid role to ${member.user.tag}`);
    } else if (status === 'free') {
      // Add free role, remove paid role
      if (PAID_ROLE_ID && member.roles.cache.has(PAID_ROLE_ID)) {
        await member.roles.remove(PAID_ROLE_ID);
      }
      if (FREE_ROLE_ID && !member.roles.cache.has(FREE_ROLE_ID)) {
        await member.roles.add(FREE_ROLE_ID);
      }
      console.log(`✅ Assigned Free role to ${member.user.tag}`);
    }
  } catch (error) {
    console.error('Error assigning roles:', error);
  }
}

// Assign roles when member joins (auto-detect)
async function assignRolesByDiscordId(member) {
  const status = await checkUserStatus(member.user.id);

  if (status !== 'not_found') {
    await assignRoles(member, status);
    
    // Send welcome DM
    try {
      const roleType = status === 'paid' ? '👑 Paid Member' : '🆓 Free Member';
      await member.send(
        `🎉 Welcome to Anione Discord!\n\n` +
        `Your account has been automatically verified as a **${roleType}**.\n` +
        `Enjoy your exclusive perks!`
      );
    } catch (error) {
      console.log(`Could not send DM to ${member.user.tag}`);
    }
  }
}

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Bot is running', uptime: process.uptime() });
});

// Webhook endpoint - receives link notifications from website
app.post('/webhook/link', async (req, res) => {
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      return res.status(400).json({ error: 'discord_id is required' });
    }

    console.log(`🔗 Received link notification for Discord ID: ${discord_id}`);

    // Get the guild (server)
    const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
    
    if (!guild) {
      console.error('❌ Guild not found');
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Fetch the member
    const member = await guild.members.fetch(discord_id).catch(() => null);
    
    if (!member) {
      console.log('⚠️ Member not found in server');
      return res.status(404).json({ error: 'Member not found in server' });
    }

    // Check user status and assign roles
    const status = await checkUserStatus(discord_id);
    
    if (status !== 'not_found') {
      await assignRoles(member, status);
      
      // Send DM to user
      try {
        const roleType = status === 'paid' ? '👑 Paid Member' : '🆓 Free Member';
        await member.send(
          `✅ Your Anione account has been linked!\n\n` +
          `You've been verified as a **${roleType}**.\n` +
          `Your roles have been automatically assigned. Enjoy your perks!`
        );
      } catch (dmError) {
        console.log(`Could not send DM to ${member.user.tag}`);
      }

      console.log(`✅ Roles assigned to ${member.user.tag} (${status})`);
      return res.json({ success: true, status });
    } else {
      console.log('⚠️ User not found in database');
      return res.status(404).json({ error: 'User not found in database' });
    }
  } catch (error) {
    console.error('❌ Error in webhook:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🎣 Webhook server running on port ${PORT}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);