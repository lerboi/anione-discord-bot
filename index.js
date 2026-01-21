require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { fetch } = require('undici');
const fs = require('fs');
const path = require('path');

const express = require('express');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
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
  {
    name: 'start-promo',
    description: 'Start the promotional DM drip campaign (Admin only)',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
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
  } else if (commandName === 'start-promo') {
    await handleStartPromo(interaction);
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

// ============================================
// DRIP CAMPAIGN SYSTEM
// ============================================

// Campaign state tracking
let campaignRunning = false;

// File paths (absolute for Railway persistent volumes)
const DATA_DIR = '/app/data';
const MEMBER_IDS_FILE = path.join(DATA_DIR, 'member_ids.txt');
const SENT_FILE = path.join(DATA_DIR, 'sent.txt');

// Promo message
const PROMO_MESSAGE = "Hey! Thanks for being part of Anione. Use code 'DISCORD2026' for 5 free Image tokens: https://www.anione.me/en/Profile?tab=redeem&code=DISCORD2026";

// Ensure data directory exists
function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created directory: ${DATA_DIR}`);
  }

  // Create sent.txt if it doesn't exist
  if (!fs.existsSync(SENT_FILE)) {
    fs.writeFileSync(SENT_FILE, '', 'utf8');
    console.log(`📄 Created file: ${SENT_FILE}`);
  }
}

// Read user IDs from file
function readUserIds(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .map(id => id.trim())
      .filter(id => id.length > 0);
  } catch (error) {
    console.error(`❌ Error reading file ${filePath}:`, error);
    return [];
  }
}

// Append user ID to sent.txt
function appendToSent(userId) {
  try {
    fs.appendFileSync(SENT_FILE, `${userId}\n`, 'utf8');
  } catch (error) {
    console.error(`❌ Error writing to ${SENT_FILE}:`, error);
  }
}

// Main drip campaign function
async function sendDripCampaign(interaction) {
  console.log('🚀 Starting drip campaign...');

  // Ensure data directory and files exist
  ensureDataDirectory();

  // Read member IDs and sent IDs
  const memberIds = readUserIds(MEMBER_IDS_FILE);
  const sentIds = readUserIds(SENT_FILE);

  console.log(`📊 Total member IDs: ${memberIds.length}`);
  console.log(`📊 Already sent: ${sentIds.length}`);

  // Filter out already sent IDs
  const sentSet = new Set(sentIds);
  const toSend = memberIds.filter(id => !sentSet.has(id));

  console.log(`📊 Remaining to send: ${toSend.length}`);

  if (toSend.length === 0) {
    console.log('✅ No new users to message');
    campaignRunning = false;
    return;
  }

  // Send DMs with 3-minute intervals
  let successCount = 0;
  let closedDMCount = 0;
  let errorCount = 0;

  for (let i = 0; i < toSend.length; i++) {
    const userId = toSend[i];

    try {
      // Fetch user
      const user = await client.users.fetch(userId);

      // Send DM
      await user.send(PROMO_MESSAGE);

      console.log(`✅ [${i + 1}/${toSend.length}] Sent to ${user.tag} (${userId})`);
      successCount++;

      // Log to sent.txt immediately
      appendToSent(userId);

    } catch (error) {
      if (error.code === 50007) {
        // DMs are closed
        console.log(`🚫 [${i + 1}/${toSend.length}] DMs Closed for user ${userId}`);
        closedDMCount++;

        // Still log to sent.txt to avoid retry
        appendToSent(userId);
      } else {
        // Other error
        console.error(`❌ [${i + 1}/${toSend.length}] Error sending to ${userId}:`, error.message);
        errorCount++;

        // Don't log to sent.txt - might be temporary error
      }
    }

    // Wait 3 minutes before next message (except for last one)
    if (i < toSend.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 180000)); // 3 minutes = 180,000ms
    }
  }

  console.log('✅ Drip campaign completed!');
  console.log(`📊 Success: ${successCount} | DMs Closed: ${closedDMCount} | Errors: ${errorCount}`);

  campaignRunning = false;
}

// /start-promo command handler
async function handleStartPromo(interaction) {
  // Check if campaign is already running
  if (campaignRunning) {
    await interaction.reply({
      content: '⚠️ Campaign already in progress',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Ensure data directory exists
  ensureDataDirectory();

  // Read member IDs
  const memberIds = readUserIds(MEMBER_IDS_FILE);
  const sentIds = readUserIds(SENT_FILE);

  if (memberIds.length === 0) {
    await interaction.reply({
      content: `❌ No member IDs found in \`${MEMBER_IDS_FILE}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Calculate remaining users
  const sentSet = new Set(sentIds);
  const toSend = memberIds.filter(id => !sentSet.has(id));

  if (toSend.length === 0) {
    await interaction.reply({
      content: '✅ No new users to message. All users have already been contacted!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Set campaign running flag
  campaignRunning = true;

  // Reply to user
  await interaction.reply({
    content: `✅ Drip campaign started! Processing ${toSend.length} users...`,
    flags: MessageFlags.Ephemeral,
  });

  // Start campaign asynchronously (don't await - runs in background)
  sendDripCampaign(interaction).catch(error => {
    console.error('❌ Campaign error:', error);
    campaignRunning = false;
  });
}

const app = express();

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  console.log('📍 Health check accessed');
  res.json({ 
    status: 'Bot is running', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Webhook endpoint
app.post('/webhook/link', async (req, res) => {
  console.log('📥 Webhook endpoint hit!');
  console.log('📥 Request body:', req.body);
  
  try {
    const { discord_id } = req.body;

    if (!discord_id) {
      console.log('❌ No discord_id provided');
      return res.status(400).json({ error: 'discord_id is required' });
    }

    console.log(`🔗 Received link notification for Discord ID: ${discord_id}`);

    // Wait for bot to be ready
    if (!client.isReady()) {
      console.log('⚠️ Bot not ready yet, waiting...');
      await new Promise(resolve => {
        if (client.isReady()) {
          resolve();
        } else {
          client.once('ready', resolve);
        }
      });
    }

    const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
    
    if (!guild) {
      console.error('❌ Guild not found');
      return res.status(404).json({ error: 'Guild not found' });
    }

    console.log(`✅ Found guild: ${guild.name}`);

    const member = await guild.members.fetch(discord_id).catch(err => {
      console.log('❌ Error fetching member:', err.message);
      return null;
    });
    
    if (!member) {
      console.log('⚠️ Member not found in server');
      return res.status(404).json({ error: 'Member not found in server' });
    }

    console.log(`✅ Found member: ${member.user.tag}`);

    const status = await checkUserStatus(discord_id);
    console.log(`📊 User status: ${status}`);
    
    if (status !== 'not_found') {
      await assignRoles(member, status);
      
      try {
        const roleType = status === 'paid' ? '👑 Paid Member' : '🆓 Free Member';
        await member.send(
          `✅ Your Anione account has been linked!\n\n` +
          `You've been verified as a **${roleType}**.\n` +
          `Your roles have been automatically assigned. Enjoy your perks!`
        );
        console.log(`📨 DM sent to ${member.user.tag}`);
      } catch (dmError) {
        console.log(`⚠️ Could not send DM to ${member.user.tag}`);
      }

      console.log(`✅ Roles assigned to ${member.user.tag} (${status})`);
      return res.json({ success: true, status, user: member.user.tag });
    } else {
      console.log('⚠️ User not found in database');
      return res.status(404).json({ error: 'User not found in database' });
    }
  } catch (error) {
    console.error('❌ Error in webhook:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Start Express server FIRST
const PORT = 8080; // Fallback to 3000 if undefined

const server = app.listen(PORT, () => {
  console.log(`🎣 Webhook server running on ${PORT}`);
});

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

// Then login bot AFTER server starts
console.log('🤖 Logging in Discord bot...');
client.login(process.env.DISCORD_BOT_TOKEN);