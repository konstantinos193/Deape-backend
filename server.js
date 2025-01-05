const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');

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
  if (!apiKey || (apiKey !== BOT_API_KEY && apiKey !== FRONTEND_API_KEY)) {
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
    const { sessionId } = req.params;
    const { address, signature, message, timestamp } = req.body;
  
    console.log('Received data:', { address, signature, message, timestamp });
  
    try {
      const FIVE_MINUTES = 5 * 60 * 1000;
      if (Date.now() - timestamp > FIVE_MINUTES) {
        console.error('Timestamp is too old:', timestamp);
        return res.status(400).json({ error: 'Timestamp is too old' });
      }
  
      const isValid = verifySignature(address, message, signature);
      if (!isValid) {
        console.error('Invalid signature for address:', address);
        return res.status(400).json({ error: 'Invalid signature' });
      }
  
      const session = await updateSessionWithWallet(sessionId, address);
      res.json({ session });
    } catch (error) {
      console.error('Error updating wallets:', error);
      res.status(500).json({ error: 'Failed to update wallets' });
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

    console.log('Creating session:', {
      sessionId,
      username,
      discordId,
      existingSessions: sessions.size
    });

    if (!sessionId || !username || !discordId) {
      console.error('Missing required fields:', { sessionId, username, discordId });
      return res.status(400).json({
        error: 'Missing required fields',
        received: { sessionId, username, discordId }
      });
    }

    // Create session with all required fields
    const session = {
      id: sessionId,
      discordId,
      username: decodeURIComponent(username),
      isDiscordConnected: true,
      wallets: [],
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    // Store in both maps
    sessions.set(sessionId, session);
    discordSessions.set(discordId, session);

    console.log('Session created:', {
      sessionId,
      sessionData: session,
      totalSessions: sessions.size
    });

    res.json({
      success: true,
      sessionId,
      session
    });
  } catch (error) {
    console.error('Webhook error:', error);
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

// Update user roles function
async function updateUserRoles(userId, totalNFTs) {
  try {
    console.log('Processing role update:', { userId, totalNFTs });

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    if (!guild) {
      console.error('Guild not found:', process.env.GUILD_ID);
      return;
    }

    const member = await guild.members.fetch(userId);
    if (!member) {
      console.error('Member not found:', userId);
      return;
    }

    // Remove existing roles first
    const rolesToRemove = [VERIFIED_ROLE_ID, ELITE_ROLE_ID];
    await Promise.all(rolesToRemove.map(roleId => member.roles.remove(roleId).catch(err => {
      console.error(`Failed to remove role ${roleId}:`, err);
    })));

    // Add roles based on NFT count
    if (totalNFTs >= 1) {
      await member.roles.add(VERIFIED_ROLE_ID);
      console.log(`Added verified role to ${member.user.tag}`);
    }
    
    if (totalNFTs >= 10) {
      await member.roles.add(ELITE_ROLE_ID);
      console.log(`Added elite role to ${member.user.tag}`);
    }

    // Log the successful role update
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
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(session);
});

app.post('/api/discord/:sessionId/wallets', (req, res) => {
  console.log('Received data:', req.body);
  // ... existing code ...
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
