const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const Redis = require('ioredis');
const nftAbi = require('./abis/nftAbi.json');
const stakingAbi = require('./abis/stakingAbi.json');
const { Client, GatewayIntentBits } = require('discord.js');
const { TRACKED_COLLECTIONS } = require('./trackedCollections');
const LENDING_CONTRACT_ABI = require('./lendingContractABI.json');

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

// Ensure we have the RPC URL
if (!process.env.APECHAIN_RPC_URL) {
  throw new Error('APECHAIN_RPC_URL is not defined in environment variables');
}

// Initialize provider with RPC URL from .env
const provider = new ethers.providers.JsonRpcProvider(process.env.APECHAIN_RPC_URL);

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
async function fetchTotalNFTs(walletAddress) {
  try {
    const nftBalance = await nftContract.balanceOf(walletAddress);
    const stakedNFTs = await fetchStakedNFTs(walletAddress);
    return nftBalance.toNumber() + stakedNFTs;
  } catch (error) {
    console.error('Error fetching total NFTs:', error);
    return 0;
  }
}

// Function to update user roles based on total NFTs
async function updateUserRoles(userId, totalNFTs) {
    try {
        console.log('Processing role update:', { userId, totalNFTs });

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

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

    // Calculate total NFTs
    const totalNFTs = await fetchTotalNFTs(walletAddress);

    // Add roles based on NFT count
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

client.login(process.env.DISCORD_TOKEN);

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

async function fetchStakedNFTs(walletAddress) {
  try {
    const stakerInfo = await stakingContract.getStakerInfo(walletAddress);
    return stakerInfo.stakedTokens.length;
  } catch (error) {
    console.error('Error fetching staked NFTs:', error);
    return 0;
  }
}

const contractAddress = '0xddbcc239527dedd5e0c761042ef02a7951cec315';
const contractABI = [
  {
    "inputs": [{ "internalType": "address", "name": "_user", "type": "address" }],
    "name": "getPoints",
    "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  }
];

const leaderboardCache = {
  data: [],
  lastUpdated: null
};

// Middleware to check API key
function checkApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === process.env.BOT_API_KEY) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
  }
}

app.get('/api/leaderboard', checkApiKey, (req, res) => {
  res.json({
    data: leaderboardCache.data,
    lastUpdated: leaderboardCache.lastUpdated
  });
});

async function updateLeaderboardCache() {
  try {
    const contract = new ethers.Contract(contractAddress, contractABI, provider);
    const startBlock = 6970654;
    const endBlock = await provider.getBlockNumber();
    const filter = {
      address: contractAddress,
      fromBlock: startBlock,
      toBlock: endBlock
    };

    const logs = await provider.getLogs(filter);
    const addresses = new Set();

    logs.forEach(log => {
      if (log.topics.length > 1) {
        const address = ethers.utils.getAddress(`0x${log.topics[1].slice(26)}`);
        if (address !== '0x0000000000000000000000000000000000000000') {
          addresses.add(address);
        }
      }
    });

    const leaderboardData = [];
    for (const address of addresses) {
      try {
        const points = await contract.getPoints(address);
        leaderboardData.push({ address, points: points.toNumber() });
      } catch (error) {
        console.error(`Error fetching points for address ${address}:`, error);
      }
    }

    leaderboardCache.data = leaderboardData.sort((a, b) => b.points - a.points);
    leaderboardCache.lastUpdated = new Date();
    console.log('Leaderboard cache updated');
  } catch (error) {
    console.error('Error updating leaderboard cache:', error);
  }
}

// Update leaderboard cache every 24 hours
setInterval(updateLeaderboardCache, 24 * 60 * 60 * 1000);

// Initial cache update
updateLeaderboardCache();

// Initialize floor price cache
const floorPriceCache = {
  data: {},
  lastUpdated: null
};

// API endpoint to get collection details
app.get('/api/collection/:address', checkApiKey, (req, res) => {
  const requestedAddress = req.params.address.toLowerCase();
  
  const collection = TRACKED_COLLECTIONS.find(
    c => c.contractAddress.toLowerCase() === requestedAddress
  );

  if (!collection) {
    return res.status(404).json({ error: 'Collection not found' });
  }

  // Get cached floor price data
  const floorPriceData = floorPriceCache.data[collection.contractAddress];

  if (!floorPriceData) {
    return res.status(404).json({ error: 'Floor price data not found' });
  }

  // Return combined collection data
  res.json({
    id: collection.id,
    name: collection.name,
    contractAddress: collection.contractAddress,
    magicEdenSymbol: collection.magicEdenSymbol,
    floorPrice: floorPriceData.floorPrice,
    floorPriceUSD: floorPriceData.floorPriceUSD,
    currency: floorPriceData.currency,
    lastUpdated: floorPriceData.lastUpdated
  });
});

async function updateFloorPriceCache() {
  try {
    console.log('Updating floor price cache...');
    
    for (const collection of TRACKED_COLLECTIONS) {
      try {
        const response = await fetch(
          `https://api-mainnet.magiceden.dev/v3/rtp/apechain/collections/v7?contract=${collection.contractAddress}&sortBy=allTimeVolume`,
          {
            headers: {
              'Authorization': `Bearer ${process.env.MAGICEDEN_API_KEY}`
            }
          }
        );
        
        const data = await response.json();
        const collectionData = data.collections?.[0];
        
        if (collectionData?.floorAsk?.price?.amount?.decimal) {
          const floorPriceData = {
            id: collection.id,
            floorPrice: collectionData.floorAsk.price.amount.decimal,
            floorPriceUSD: collectionData.floorAsk.price.amount.usd,
            lastUpdated: new Date(),
            name: collection.name,
            symbol: collection.magicEdenSymbol,
            currency: {
              name: collectionData.floorAsk.price.currency.name,
              symbol: collectionData.floorAsk.price.currency.symbol,
              decimals: collectionData.floorAsk.price.currency.decimals
            }
          };
          
          // Store by both ID and contract address for flexible lookups
          floorPriceCache.data[collection.id] = floorPriceData;
          floorPriceCache.data[collection.contractAddress] = floorPriceData;
          
          console.log(`Updated floor price for ${collection.name}: ${floorPriceData.floorPrice} ${floorPriceData.currency.symbol} ($${floorPriceData.floorPriceUSD})`);
        }
        
        // Add delay between requests to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error fetching floor price for ${collection.name}:`, error);
      }
    }
    
    floorPriceCache.lastUpdated = new Date();
    console.log('Floor price cache updated successfully');
  } catch (error) {
    console.error('Error updating floor price cache:', error);
  }
}

// API endpoint to get floor prices
app.get('/api/floor-prices', checkApiKey, (req, res) => {
  res.json({
    data: floorPriceCache.data,
    lastUpdated: floorPriceCache.lastUpdated
  });
});

// Update cache every 30 minutes
setInterval(updateFloorPriceCache, 30 * 60 * 1000);

// Initial cache update
updateFloorPriceCache();

// Add this after the floor price cache
const poolStatsCache = {
  data: {},
  lastUpdated: null
};

// Contract configuration
const LENDING_CONTRACT_ADDRESS = process.env.LENDING_CONTRACT_ADDRESS;
if (!LENDING_CONTRACT_ADDRESS) {
  throw new Error('LENDING_CONTRACT_ADDRESS is not defined in environment variables');
}

// Initialize contract
const lendingContract = new ethers.Contract(
  LENDING_CONTRACT_ADDRESS,
  LENDING_CONTRACT_ABI,
  provider
);

async function updatePoolStatsCache() {
  try {
    console.log('Updating pool stats cache...');
    
    // Get all collections using the contract instance
    const collections = await lendingContract.getCollections();
    
    for (const collection of collections) {
      try {
        const collectionAddress = collection.nftContract;
        let bestOffer = ethers.BigNumber.from(0);
        let totalPool = ethers.BigNumber.from(0);
        
        // Get all active collection offers
        const eventSignature = ethers.utils.id("CollectionOfferCreated(uint256,address,address,uint256,uint256,uint256)");
        const filter = {
          address: LENDING_CONTRACT_ADDRESS,
          topics: [
            eventSignature,
            null, // offerId (any)
            null, // lender address (any)
            ethers.utils.hexZeroPad(collectionAddress, 32) // collection address (specific)
          ],
          fromBlock: 0
        };
        
        const events = await provider.getLogs(filter);
        
        // Process each event
        for (const event of events) {
          const offerId = ethers.BigNumber.from(event.topics[1]).toNumber();
          const offerDetails = await lendingContract.getOfferDetails(offerId);
          
          if (offerDetails.isActive) {
            totalPool = totalPool.add(offerDetails.loanAmount);
            if (offerDetails.loanAmount.gt(bestOffer)) {
              bestOffer = offerDetails.loanAmount;
            }
          }
        }

        poolStatsCache.data[collectionAddress] = {
          availablePool: ethers.utils.formatEther(totalPool),
          bestOffer: ethers.utils.formatEther(bestOffer),
          lastUpdated: new Date()
        };

        console.log(`Updated pool stats for ${collection.name}:`, {
          availablePool: ethers.utils.formatEther(totalPool),
          bestOffer: ethers.utils.formatEther(bestOffer)
        });

      } catch (error) {
        console.error(`Error processing collection ${collection.name}:`, error);
      }
    }
    
    poolStatsCache.lastUpdated = new Date();
    console.log('Pool stats cache updated successfully');
  } catch (error) {
    console.error('Error updating pool stats cache:', error);
  }
}

// Add API endpoint to get pool stats
app.get('/api/pool-stats', checkApiKey, (req, res) => {
  res.json({
    data: poolStatsCache.data,
    lastUpdated: poolStatsCache.lastUpdated
  });
});

// Update cache every 5 minutes
setInterval(updatePoolStatsCache, 5 * 60 * 1000);

// Initial cache update
updatePoolStatsCache();
