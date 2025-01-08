const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');
const nftAbi = require('./abis/nftAbi.json');
const stakingAbi = require('./abis/stakingAbi.json');
const { Client, Intents } = require('discord.js');

const app = express();

// Initialize session maps
const sessions = new Map();
const discordSessions = new Map();

// Middleware
app.use(cors());
app.use(express.json());

// API Keys
const BOT_API_KEY = process.env.BOT_API_KEY;
const FRONTEND_API_KEY = process.env.FRONTEND_API_KEY;

// API key validation middleware
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.BOT_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
};

// Verify signature function
function verifySignature(address, message, signature) {
  try {
    const signerAddress = ethers.utils.verifyMessage(message, signature);
    return signerAddress.toLowerCase() === address.toLowerCase();
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

// Connect to ApeChain
const provider = new ethers.providers.JsonRpcProvider('https://apechain.calderachain.xyz/http');

// Wallet update endpoint
app.post('/api/discord/:sessionId/wallets', async (req, res) => {
  console.log('Received request for session:', req.params.sessionId);
  const { sessionId } = req.params;
  const { address } = req.body;

  try {
    const hasNFTs = await checkNFTHoldings(address);
    const hasStakedNFTs = await checkStakedNFTs(address);

    if (hasNFTs || hasStakedNFTs) {
      await assignDiscordRoles(sessionId, address, hasStakedNFTs);
    }

    res.json({ success: true, hasNFTs, hasStakedNFTs });
  } catch (error) {
    console.error('Error checking NFT holdings:', error);
    res.status(500).json({ error: 'Failed to check NFT holdings' });
  }
});

// Cleanup expired sessions
function cleanupSessions() {
  const now = Date.now();
  sessions.forEach((session, sessionId) => {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log('Cleaning up expired session:', sessionId);
      sessions.delete(sessionId);
      if (session.discordId) {
        discordSessions.delete(session.discordId);
      }
    }
  });
}

// Run cleanup every hour
setInterval(cleanupSessions, 60 * 60 * 1000);

// Import and use dashboard routes
const dashboardRoutes = require('./routes/dashboard');
app.use('/api', dashboardRoutes);

// Basic health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sessions: {
      discord: Array.from(discordSessions.keys()),
      wallet: Array.from(sessions.keys())
    }
  });
});

// Discord session endpoint
app.get('/api/discord/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  console.log('Fetching Discord session:', sessionId);

  const session = discordSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json(session);
});

// Discord webhook endpoint
app.post('/api/discord/webhook', validateApiKey, (req, res) => {
  try {
    const { sessionId, username, discordId } = req.body;

    if (!sessionId || !username || !discordId) {
      return res.status(400).json({
        error: 'Missing required fields',
        received: { sessionId, username, discordId }
      });
    }

    const session = {
      id: sessionId,
      discordId,
      username: decodeURIComponent(username),
      isDiscordConnected: true,
      wallets: [],
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    sessions.set(sessionId, session);
    discordSessions.set(discordId, session);

    res.json({
      success: true,
      sessionId,
      session
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.log('ERROR', 'Unhandled error occurred', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  res.status(500).json({
    error: err.message,
    status: 'error'
  });
});

// Debug logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, {
    headers: req.headers,
    query: req.query,
    body: req.body
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development',
    sessions: {
      total: sessions.size,
      discord: discordSessions.size
    }
  };

  console.log('HEALTH_CHECK', 'Health check requested', health);
  res.json(health);
});

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    console.log(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: Date.now() - start,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });

  next();
});

// Debug sessions endpoint
app.get('/api/debug/sessions', validateApiKey, (req, res) => {
  const allSessions = Array.from(sessions.entries());
  res.json({
    totalSessions: sessions.size,
    sessions: allSessions
  });
});

// Create Redis client if you have Redis URL
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

// Different limiters for different endpoints
const limiters = {
  basic: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    store: redis ? new RedisStore({ client: redis }) : undefined,
    keyGenerator: (req) => {
      return req.headers['x-forwarded-for'] || req.ip;
    },
  }),
  wallet: rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 50,
    message: { error: 'Too many wallet verification attempts' },
    store: redis ? new RedisStore({ client: redis }) : undefined,
    keyGenerator: (req) => {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      const sessionId = req.params.sessionId;
      return `${ip}-${sessionId}`;
    },
  }),
  health: rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    store: redis ? new RedisStore({ client: redis }) : undefined,
  })
};

// Apply different rate limits to different routes
app.get('/health', limiters.health);
app.use('/api/discord/session', limiters.basic);
app.use('/api/discord/webhook', limiters.basic);
app.use('/api/discord/:sessionId/wallets', limiters.wallet);

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API Server is running on port ${PORT}`);
});

// Function to fetch total NFTs (staked + unstaked)
async function fetchTotalNFTs(userId) {
    // Implement logic to fetch both staked and unstaked NFTs
    const stakedNFTs = await fetchStakedNFTs(userId); // Implement this function
    const unstakedNFTs = await fetchUnstakedNFTs(userId); // Implement this function

    return stakedNFTs + unstakedNFTs;
}

// Function to update user roles based on total NFTs
async function updateUserRoles(userId) {
    try {
        console.log('Processing role update for user:', userId);

        const guild = await client.guilds.fetch(GUILD_ID);
        if (!guild) {
            console.error('Guild not found:', GUILD_ID);
            return;
        }

        const member = await guild.members.fetch(userId);
        if (!member) {
            console.error('Member not found:', userId);
            return;
        }

        const totalNFTs = await fetchTotalNFTs(userId);

        // Check current roles
        const hasVerifiedRole = member.roles.cache.has(VERIFIED_ROLE_ID);
        const hasEliteRole = member.roles.cache.has(ELITE_ROLE_ID);

        // Update roles based on total NFT count
        if (totalNFTs >= 1 && !hasVerifiedRole) {
            await member.roles.add(VERIFIED_ROLE_ID);
            console.log(`Added verified role to ${member.user.tag}`);
        } else if (totalNFTs < 1 && hasVerifiedRole) {
            await member.roles.remove(VERIFIED_ROLE_ID);
            console.log(`Removed verified role from ${member.user.tag}`);
        }

        if (totalNFTs >= 10 && !hasEliteRole) {
            await member.roles.add(ELITE_ROLE_ID);
            console.log(`Added elite role to ${member.user.tag}`);
        } else if (totalNFTs < 10 && hasEliteRole) {
            await member.roles.remove(ELITE_ROLE_ID);
            console.log(`Removed elite role from ${member.user.tag}`);
        }

        console.log(`Updated roles for ${member.user.tag}:`, {
            totalNFTs,
            verified: totalNFTs >= 1,
            elite: totalNFTs >= 10
        });

    } catch (error) {
        console.error('Role update error:', error);
    }
}

app.get('/api/session/:sessionId', (req, res) => {
  console.log('Fetching session:', req.params.sessionId);
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    console.error('Session not found:', sessionId);
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

async function updateSessionWithWallet(sessionId, address) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Update the session with the new wallet address
  session.wallets = session.wallets || [];
  if (!session.wallets.includes(address)) {
    session.wallets.push(address);
  }

  // Update the last activity timestamp
  session.lastActivity = Date.now();

  // Save the updated session
  sessions.set(sessionId, session);

  return session;
}

app.get('/api/nft/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Fetch NFT data logic here
    const nftData = await fetchNFTData(session.wallets);
    res.json({ nftData });
  } catch (error) {
    console.error('Error fetching NFT data:', error);
    res.status(500).json({ error: 'Failed to fetch NFT data' });
  }
});

const nftContractAddress = '0x485242262f1e367144fe432ba858f9ef6f491334';
const stakingContractAddress = '0xddbcc239527dedd5e0c761042ef02a7951cec315';

const nftContract = new ethers.Contract(nftContractAddress, nftAbi, provider);
const stakingContract = new ethers.Contract(stakingContractAddress, stakingAbi, provider);

async function checkNFTHoldings(walletAddress) {
  const balance = await nftContract.balanceOf(walletAddress);
  return balance.gt(0);
}

async function checkStakedNFTs(walletAddress) {
  const stakerInfo = await stakingContract.getStakerInfo(walletAddress);
  return stakerInfo.stakedTokens.length > 0;
}

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MEMBERS] });

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

async function assignDiscordRoles(sessionId, walletAddress, hasStakedNFTs) {
  console.log('Assigning Discord roles for session:', sessionId, 'wallet:', walletAddress);

  try {
    const session = sessions.get(sessionId);
    if (!session) {
      console.error('Session not found:', sessionId);
      return;
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    if (!guild) {
      console.error('Guild not found:', process.env.GUILD_ID);
      return;
    }

    const member = await guild.members.fetch(session.discordId);
    if (!member) {
      console.error('Member not found:', session.discordId);
      return;
    }

    // Remove existing roles first
    const rolesToRemove = ['1322623738168213575', '1322624148857557084'];
    await Promise.all(rolesToRemove.map(roleId => member.roles.remove(roleId).catch(err => {
      console.error(`Failed to remove role ${roleId}:`, err);
    })));

    // Add roles based on NFT count
    const totalNFTs = hasStakedNFTs ? 10 : 1; // Example logic
    if (totalNFTs >= 1) {
      await member.roles.add('1322623738168213575');
      console.log(`Added verified role to ${member.user.tag}`);
    }
    
    if (totalNFTs >= 10) {
      await member.roles.add('1322624148857557084');
      console.log(`Added elite role to ${member.user.tag}`);
    }

    console.log(`Updated roles for ${member.user.tag}:`, {
      totalNFTs,
      verified: totalNFTs >= 1,
      elite: totalNFTs >= 10
    });

  } catch (error) {
    console.error('Error assigning Discord roles:', error);
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);

app.get('/api/discord/:sessionId/wallets', (req, res) => {
  try {
    const { sessionId } = req.params;
    const wallets = getWalletsForSession(sessionId);
    if (!wallets) {
      return res.status(404).json({ error: 'Wallets not found for session' });
    }
    res.json(wallets);
  } catch (error) {
    console.error('Error fetching wallets:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

function getWalletsForSession(sessionId) {
  // Example logic to retrieve wallets for a session
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  return session.wallets || [];
}
