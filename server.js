const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');

// Contract addresses
const NFT_CONTRACT_ADDRESS = '0x485242262f1e367144fe432ba858f9ef6f491334';
const STAKING_CONTRACT_ADDRESS = '0xdDbcC239527Dedd5E0c761042ef02A7951cEC315';

// ABI snippets for the functions we need
const NFT_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)'
];

const STAKING_ABI = [
    {
        "inputs": [{"name": "_staker", "type": "address"}],
        "name": "getStakerInfo",
        "outputs": [
            {"name": "stakedTokens", "type": "uint256[]"},
            {"name": "totalPoints", "type": "uint256"},
            {"name": "tier", "type": "uint256"},
            {"name": "isMinter", "type": "bool"}
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

const app = express();

// Remove any existing CORS middleware and replace with this configuration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://deape.fi');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
    }
    
    next();
});

// Add request logging middleware (for debugging CORS issues)
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`, {
        origin: req.headers.origin,
        headers: req.headers
    });
    next();
});

// Initialize session maps
const sessions = new Map();
const discordSessions = new Map();

// CORS middleware
const corsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;

    if (origin === 'https://deape.fi') {
        res.setHeader('Access-Control-Allow-Origin', 'https://deape.fi');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
};

// Apply middleware
app.use(corsMiddleware);
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // Increase the limit
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
}));
app.use(express.json());

// Serve static files from the public directory
app.use(express.static('public'));

// API Keys (store these in your .env file)
const BOT_API_KEY = process.env.BOT_API_KEY || uuidv4();
const FRONTEND_API_KEY = process.env.FRONTEND_API_KEY || uuidv4();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// API key validation middleware
const validateApiKey = (req, res, next) => {
    // Skip validation for OPTIONS requests
    if (req.method === 'OPTIONS') {
        return next();
    }

    const apiKey = req.headers['x-api-key'];

    console.log('API Key Validation:', {
        receivedKey: apiKey,
        botKey: BOT_API_KEY,
        frontendKey: FRONTEND_API_KEY,
        matches: {
            bot: apiKey === BOT_API_KEY,
            frontend: apiKey === FRONTEND_API_KEY
        },
        path: req.path
    });

    if (!apiKey) {
        console.log('No API key provided');
        return res.status(401).json({ error: 'API key required' });
    }

    if (apiKey !== BOT_API_KEY && apiKey !== FRONTEND_API_KEY) {
        console.log('Invalid API key provided');
        return res.status(403).json({ error: 'Invalid API key' });
    }

    next();
};

// Apply API key validation only to API routes
app.use('/api', validateApiKey);

// Verification endpoint
app.get('/verify', (req, res) => {
    try {
        const { session } = req.query;
        if (!session) {
            return res.status(400).json({ error: 'Session ID is required' });
        }

        res.sendFile('public/verify.html', { root: __dirname });
    } catch (error) {
        console.error('Error serving verification page:', error);
        res.status(500).json({ error: error.message });
    }
});

// Session management
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

// Create new session
app.post('/api/session', validateApiKey, (req, res) => {
    try {
        const { discordId, username } = req.body;
        
        // Generate a proper UUID for the session
        const sessionId = uuidv4();
        
        // Create session with all required fields
        const session = {
            id: sessionId,
            discordId,
            username,
            isDiscordConnected: true,
            wallets: [],
            createdAt: Date.now(),
            lastActivity: Date.now()
        };

        // Store in both maps
        sessions.set(sessionId, session);
        discordSessions.set(discordId, session);

        console.log('Created new session:', session);

        res.json({ 
            success: true,
            sessionId,
            session 
        });
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get session status
app.get('/api/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = sessions.get(sessionId);
        
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json({ session });
    } catch (error) {
        console.error('Session fetch error:', error);
        res.status(500).json({ error: error.message });
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

// Wallet verification endpoint
app.post('/api/discord/:sessionId/wallets', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { address } = req.body;
        
        console.log('Wallet verification request:', { sessionId, address });

        const session = sessions.get(sessionId);
        if (!session) {
            console.log('Session not found:', sessionId);
            return res.status(404).json({ error: 'Discord session not found' });
        }

        // Initialize provider with error handling
        let provider;
        try {
            provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
            await provider.getNetwork(); // Test the connection
            console.log('Provider initialized successfully');
        } catch (error) {
            console.error('Provider initialization failed:', error);
            return res.status(500).json({ error: 'Failed to connect to blockchain' });
        }

        // Initialize contracts with error handling
        let nftContract, stakingContract;
        try {
            nftContract = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, provider);
            stakingContract = new ethers.Contract(STAKING_CONTRACT_ADDRESS, STAKING_ABI, provider);
            console.log('Contracts initialized successfully');
        } catch (error) {
            console.error('Contract initialization failed:', error);
            return res.status(500).json({ error: 'Failed to initialize contracts' });
        }

        // Check NFT ownership
        try {
            console.log('Checking NFT balance for address:', address);
            const balance = await nftContract.balanceOf(address);
            const balanceNum = Number(balance);
            console.log('NFT balance:', balanceNum);

            // Get staking info
            const stakerInfo = await stakingContract.getStakerInfo(address);
            console.log('Raw staker info:', stakerInfo);

            const stakedTokens = stakerInfo.stakedTokens || [];
            const stakedCount = stakedTokens.length;
            const totalBalance = balanceNum + stakedCount;

            console.log('Staked tokens array:', stakedTokens);
            console.log('Staked count:', stakedCount);
            console.log('Total balance:', totalBalance);

            if (totalBalance === 0) {
                return res.status(400).json({ 
                    error: 'No NFTs found for this address',
                    details: {
                        walletBalance: balanceNum,
                        stakedTokens: stakedCount
                    }
                });
            }

            // Update session with verified wallet
            if (!session.wallets) {
                session.wallets = [];
            }
            
            if (!session.wallets.includes(address)) {
                session.wallets.push(address);
                sessions.set(sessionId, session);
                console.log('Wallet added to session:', address);
            }

            console.log('Session after wallet verification:', session);

            res.json({ 
                success: true, 
                message: 'Wallet verified successfully',
                details: {
                    walletBalance: balanceNum,
                    stakedTokens: stakedCount,
                    totalBalance: totalBalance
                },
                session 
            });

        } catch (error) {
            console.error('NFT balance check failed:', error);
            return res.status(500).json({ 
                error: 'Failed to verify NFT ownership',
                details: error.message
            });
        }

    } catch (error) {
        console.error('Wallet verification error:', error);
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

// Add request logging middleware (place this before your routes)
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
  // More permissive for basic endpoints
  basic: rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // 300 requests per 15 minutes
    message: { error: 'Too many requests, please try again later' },
    standardHeaders: true,
    store: redis ? new RedisStore({ client: redis }) : undefined,
    keyGenerator: (req) => {
      return req.headers['x-forwarded-for'] || req.ip;
    },
  }),

  // Stricter for wallet verification
  wallet: rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 50, // Increase the limit for wallet verification
    message: { error: 'Too many wallet verification attempts' },
    store: redis ? new RedisStore({ client: redis }) : undefined,
    keyGenerator: (req) => {
      // Combine IP and session ID for more granular control
      const ip = req.headers['x-forwarded-for'] || req.ip;
      const sessionId = req.params.sessionId;
      return `${ip}-${sessionId}`;
    },
  }),

  // Very permissive for health checks
  health: rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    store: redis ? new RedisStore({ client: redis }) : undefined,
  })
};

// Apply different rate limits to different routes
app.get('/health', limiters.health);
app.use('/api/discord/session', limiters.basic);
app.use('/api/discord/webhook', limiters.basic);
app.use('/api/discord/:sessionId/wallets', limiters.wallet);

// Add burst handling middleware
const burstProtection = (req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.ip;
  const key = `burst:${ip}`;
  
  if (redis) {
    redis.incr(key).then(count => {
      if (count === 1) {
        redis.expire(key, 1); // Reset after 1 second
      }
      if (count > 20) { // Allow more requests per second
        return res.status(429).json({
          error: 'Please slow down',
          retryAfter: 1
        });
      }
      next();
    });
  } else {
    next();
  }
};

// Apply burst protection to wallet verification
app.use('/api/discord/:sessionId/wallets', burstProtection);

// Add response headers for rate limit info
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 429) {
      const retryAfter = Math.ceil(req.rateLimit.resetTime / 1000) || 60;
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', req.rateLimit.limit);
      res.setHeader('X-RateLimit-Remaining', req.rateLimit.remaining);
    }
  });
  next();
});

// Add IP-based blocking for abuse
const blockList = new Set();
const suspiciousIPs = new Map();

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for'] || req.ip;
  
  if (blockList.has(ip)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (req.statusCode === 429) {
    const count = suspiciousIPs.get(ip) || 0;
    suspiciousIPs.set(ip, count + 1);
    
    if (count > 5) { // Block after 5 rate limit violations
      blockList.add(ip);
      suspiciousIPs.delete(ip);
    }
  }
  
  next();
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`API Server is running on port ${PORT}`);
});
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
