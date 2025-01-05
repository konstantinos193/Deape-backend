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

app.post('/api/discord/:sessionId/wallets', async (req, res) => {
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

const nftAbi = [
  [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"AlreadyInitialized","type":"error"},{"inputs":[],"name":"ApprovalCallerNotOwnerNorApproved","type":"error"},{"inputs":[],"name":"ApprovalQueryForNonexistentToken","type":"error"},{"inputs":[],"name":"BalanceQueryForZeroAddress","type":"error"},{"inputs":[],"name":"CannotIncreaseMaxMintableSupply","type":"error"},{"inputs":[],"name":"CosignerNotSet","type":"error"},{"inputs":[],"name":"CreatorTokenBase__InvalidTransferValidatorContract","type":"error"},{"inputs":[],"name":"GlobalWalletLimitOverflow","type":"error"},{"inputs":[],"name":"InitialOwnerCannotBeZero","type":"error"},{"inputs":[],"name":"InsufficientBalance","type":"error"},{"inputs":[],"name":"InsufficientStageTimeGap","type":"error"},{"inputs":[],"name":"InvalidCosignSignature","type":"error"},{"inputs":[],"name":"InvalidProof","type":"error"},{"inputs":[],"name":"InvalidQueryRange","type":"error"},{"inputs":[],"name":"InvalidStage","type":"error"},{"inputs":[],"name":"InvalidStageArgsLength","type":"error"},{"inputs":[],"name":"InvalidStartAndEndTimestamp","type":"error"},{"inputs":[],"name":"MintERC2309QuantityExceedsLimit","type":"error"},{"inputs":[],"name":"MintToZeroAddress","type":"error"},{"inputs":[],"name":"MintZeroQuantity","type":"error"},{"inputs":[],"name":"Mintable","type":"error"},{"inputs":[],"name":"NewOwnerIsZeroAddress","type":"error"},{"inputs":[],"name":"NewSupplyLessThanTotalSupply","type":"error"},{"inputs":[],"name":"NoHandoverRequest","type":"error"},{"inputs":[],"name":"NoSupplyLeft","type":"error"},{"inputs":[],"name":"NotAuthorized","type":"error"},{"inputs":[],"name":"NotCompatibleWithSpotMints","type":"error"},{"inputs":[],"name":"NotEnoughValue","type":"error"},{"inputs":[],"name":"NotMintable","type":"error"},{"inputs":[],"name":"NotSupported","type":"error"},{"inputs":[],"name":"NotTransferable","type":"error"},{"inputs":[],"name":"OwnerQueryForNonexistentToken","type":"error"},{"inputs":[],"name":"OwnershipNotInitializedForExtraData","type":"error"},{"inputs":[],"name":"Reentrancy","type":"error"},{"inputs":[],"name":"RoyaltyOverflow","type":"error"},{"inputs":[],"name":"RoyaltyReceiverIsZeroAddress","type":"error"},{"inputs":[],"name":"SequentialMintExceedsLimit","type":"error"},{"inputs":[],"name":"SequentialUpToTooSmall","type":"error"},{"inputs":[],"name":"ShouldNotMintToBurnAddress","type":"error"},{"inputs":[],"name":"SpotMintTokenIdTooSmall","type":"error"},{"inputs":[],"name":"StageSupplyExceeded","type":"error"},{"inputs":[],"name":"TimestampExpired","type":"error"},{"inputs":[],"name":"TokenAlreadyExists","type":"error"},{"inputs":[],"name":"TransferCallerNotOwnerNorApproved","type":"error"},{"inputs":[],"name":"TransferFailed","type":"error"},{"inputs":[],"name":"TransferFromIncorrectOwner","type":"error"},{"inputs":[],"name":"TransferToNonERC721ReceiverImplementer","type":"error"},{"inputs":[],"name":"TransferToZeroAddress","type":"error"},{"inputs":[],"name":"URIQueryForNonexistentToken","type":"error"},{"inputs":[],"name":"Unauthorized","type":"error"},{"inputs":[],"name":"WalletGlobalLimitExceeded","type":"error"},{"inputs":[],"name":"WalletStageLimitExceeded","type":"error"},{"inputs":[],"name":"WithdrawFailed","type":"error"},{"inputs":[],"name":"WrongMintCurrency","type":"error"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"approved","type":"address"},{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"operator","type":"address"},{"indexed":false,"internalType":"bool","name":"approved","type":"bool"}],"name":"ApprovalForAll","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"minter","type":"address"}],"name":"AuthorizedMinterAdded","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"minter","type":"address"}],"name":"AuthorizedMinterRemoved","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"bool","name":"autoApproved","type":"bool"}],"name":"AutomaticApprovalOfTransferValidatorSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"fromTokenId","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"toTokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"}],"name":"ConsecutiveTransfer","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"receiver","type":"address"},{"indexed":false,"internalType":"uint96","name":"feeNumerator","type":"uint96"}],"name":"DefaultRoyaltySet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint8","name":"version","type":"uint8"}],"name":"Initialized","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"pendingOwner","type":"address"}],"name":"OwnershipHandoverCanceled","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"pendingOwner","type":"address"}],"name":"OwnershipHandoverRequested","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"oldOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"activeStage","type":"uint256"}],"name":"SetActiveStage","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"string","name":"baseURI","type":"string"}],"name":"SetBaseURI","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"string","name":"uri","type":"string"}],"name":"SetContractURI","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"cosigner","type":"address"}],"name":"SetCosigner","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"receiver","type":"address"},{"indexed":false,"internalType":"uint96","name":"feeNumerator","type":"uint96"}],"name":"SetDefaultRoyalty","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"globalWalletLimit","type":"uint256"}],"name":"SetGlobalWalletLimit","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"maxMintableSupply","type":"uint256"}],"name":"SetMaxMintableSupply","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"mintCurrency","type":"address"}],"name":"SetMintCurrency","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"bool","name":"mintable","type":"bool"}],"name":"SetMintable","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"timestampExpirySeconds","type":"uint256"}],"name":"SetTimestampExpirySeconds","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"string","name":"suffix","type":"string"}],"name":"SetTokenURISuffix","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"},{"indexed":true,"internalType":"address","name":"receiver","type":"address"},{"indexed":false,"internalType":"uint96","name":"feeNumerator","type":"uint96"}],"name":"TokenRoyaltySet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":true,"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"Transfer","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"oldValidator","type":"address"},{"indexed":false,"internalType":"address","name":"newValidator","type":"address"}],"name":"TransferValidatorUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"stage","type":"uint256"},{"indexed":false,"internalType":"uint80","name":"price","type":"uint80"},{"indexed":false,"internalType":"uint80","name":"mintFee","type":"uint80"},{"indexed":false,"internalType":"uint32","name":"walletLimit","type":"uint32"},{"indexed":false,"internalType":"bytes32","name":"merkleRoot","type":"bytes32"},{"indexed":false,"internalType":"uint24","name":"maxStageSupply","type":"uint24"},{"indexed":false,"internalType":"uint256","name":"startTimeUnixSeconds","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"endTimeUnixSeconds","type":"uint256"}],"name":"UpdateStage","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Withdraw","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"mintCurrency","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"WithdrawERC20","type":"event"},{"inputs":[],"name":"DEFAULT_TRANSFER_VALIDATOR","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"string","name":"name_","type":"string"},{"internalType":"string","name":"symbol_","type":"string"}],"name":"__ERC721ACQueryableInitializable_init","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"}],"name":"addAuthorizedMinter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"approve","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"},{"internalType":"uint32","name":"qty","type":"uint32"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"},{"internalType":"uint256","name":"cosignNonce","type":"uint256"}],"name":"assertValidCosign","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"qty","type":"uint32"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint32","name":"limit","type":"uint32"},{"internalType":"bytes32[]","name":"proof","type":"bytes32[]"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"name":"authorizedMint","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"autoApproveTransfersFromValidator","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"cancelOwnershipHandover","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"pendingOwner","type":"address"}],"name":"completeOwnershipHandover","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"contractNameAndVersion","outputs":[{"internalType":"string","name":"","type":"string"},{"internalType":"string","name":"","type":"string"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"contractURI","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"explicitOwnershipOf","outputs":[{"components":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"uint64","name":"startTimestamp","type":"uint64"},{"internalType":"bool","name":"burned","type":"bool"},{"internalType":"uint24","name":"extraData","type":"uint24"}],"internalType":"struct IERC721AUpgradeable.TokenOwnership","name":"ownership","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256[]","name":"tokenIds","type":"uint256[]"}],"name":"explicitOwnershipsOf","outputs":[{"components":[{"internalType":"address","name":"addr","type":"address"},{"internalType":"uint64","name":"startTimestamp","type":"uint64"},{"internalType":"bool","name":"burned","type":"bool"},{"internalType":"uint24","name":"extraData","type":"uint24"}],"internalType":"struct IERC721AUpgradeable.TokenOwnership[]","name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"timestamp","type":"uint256"}],"name":"getActiveStageFromTimestamp","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"getApproved","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"},{"internalType":"uint32","name":"qty","type":"uint32"},{"internalType":"bool","name":"waiveMintFee","type":"bool"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"uint256","name":"cosignNonce","type":"uint256"}],"name":"getCosignDigest","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"}],"name":"getCosignNonce","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getCosigner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getGlobalWalletLimit","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getMaxMintableSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getMintCurrency","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getMintable","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getNumberStages","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"index","type":"uint256"}],"name":"getStageInfo","outputs":[{"components":[{"internalType":"uint80","name":"price","type":"uint80"},{"internalType":"uint80","name":"mintFee","type":"uint80"},{"internalType":"uint32","name":"walletLimit","type":"uint32"},{"internalType":"bytes32","name":"merkleRoot","type":"bytes32"},{"internalType":"uint24","name":"maxStageSupply","type":"uint24"},{"internalType":"uint256","name":"startTimeUnixSeconds","type":"uint256"},{"internalType":"uint256","name":"endTimeUnixSeconds","type":"uint256"}],"internalType":"struct MintStageInfo","name":"","type":"tuple"},{"internalType":"uint32","name":"","type":"uint32"},{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getTimestampExpirySeconds","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"getTransferValidationFunction","outputs":[{"internalType":"bytes4","name":"functionSignature","type":"bytes4"},{"internalType":"bool","name":"isViewFunction","type":"bool"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"getTransferValidator","outputs":[{"internalType":"address","name":"validator","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"symbol","type":"string"},{"internalType":"address","name":"initialOwner","type":"address"}],"name":"initialize","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"operator","type":"address"}],"name":"isApprovedForAll","outputs":[{"internalType":"bool","name":"isApproved","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"}],"name":"isAuthorizedMinter","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"qty","type":"uint32"},{"internalType":"uint32","name":"limit","type":"uint32"},{"internalType":"bytes32[]","name":"proof","type":"bytes32[]"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"name":"mint","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"result","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"qty","type":"uint32"},{"internalType":"address","name":"to","type":"address"}],"name":"ownerMint","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"pendingOwner","type":"address"}],"name":"ownershipHandoverExpiresAt","outputs":[{"internalType":"uint256","name":"result","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"minter","type":"address"}],"name":"removeAuthorizedMinter","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"requestOwnershipHandover","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"},{"internalType":"uint256","name":"salePrice","type":"uint256"}],"name":"royaltyInfo","outputs":[{"internalType":"address","name":"receiver","type":"address"},{"internalType":"uint256","name":"royaltyAmount","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"safeTransferFrom","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"tokenId","type":"uint256"},{"internalType":"bytes","name":"_data","type":"bytes"}],"name":"safeTransferFrom","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"operator","type":"address"},{"internalType":"bool","name":"approved","type":"bool"}],"name":"setApprovalForAll","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bool","name":"autoApprove","type":"bool"}],"name":"setAutomaticApprovalOfTransfersFromValidator","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"string","name":"baseURI","type":"string"}],"name":"setBaseURI","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"string","name":"uri","type":"string"}],"name":"setContractURI","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"cosigner","type":"address"}],"name":"setCosigner","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"receiver","type":"address"},{"internalType":"uint96","name":"feeNumerator","type":"uint96"}],"name":"setDefaultRoyalty","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"globalWalletLimit","type":"uint256"}],"name":"setGlobalWalletLimit","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"maxMintableSupply","type":"uint256"}],"name":"setMaxMintableSupply","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bool","name":"mintable","type":"bool"}],"name":"setMintable","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"uint80","name":"price","type":"uint80"},{"internalType":"uint80","name":"mintFee","type":"uint80"},{"internalType":"uint32","name":"walletLimit","type":"uint32"},{"internalType":"bytes32","name":"merkleRoot","type":"bytes32"},{"internalType":"uint24","name":"maxStageSupply","type":"uint24"},{"internalType":"uint256","name":"startTimeUnixSeconds","type":"uint256"},{"internalType":"uint256","name":"endTimeUnixSeconds","type":"uint256"}],"internalType":"struct MintStageInfo[]","name":"newStages","type":"tuple[]"}],"name":"setStages","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"timestampExpirySeconds","type":"uint256"}],"name":"setTimestampExpirySeconds","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"string","name":"suffix","type":"string"}],"name":"setTokenURISuffix","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"transferValidator_","type":"address"}],"name":"setTransferValidator","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"maxMintableSupply","type":"uint256"},{"internalType":"uint256","name":"globalWalletLimit","type":"uint256"},{"internalType":"address","name":"mintCurrency","type":"address"},{"internalType":"address","name":"fundReceiver","type":"address"},{"components":[{"internalType":"uint80","name":"price","type":"uint80"},{"internalType":"uint80","name":"mintFee","type":"uint80"},{"internalType":"uint32","name":"walletLimit","type":"uint32"},{"internalType":"bytes32","name":"merkleRoot","type":"bytes32"},{"internalType":"uint24","name":"maxStageSupply","type":"uint24"},{"internalType":"uint256","name":"startTimeUnixSeconds","type":"uint256"},{"internalType":"uint256","name":"endTimeUnixSeconds","type":"uint256"}],"internalType":"struct MintStageInfo[]","name":"initialStages","type":"tuple[]"},{"internalType":"address","name":"royaltyReceiver","type":"address"},{"internalType":"uint96","name":"royaltyFeeNumerator","type":"uint96"}],"name":"setup","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes4","name":"interfaceId","type":"bytes4"}],"name":"supportsInterface","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"tokenURI","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"tokensOfOwner","outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"uint256","name":"start","type":"uint256"},{"internalType":"uint256","name":"stop","type":"uint256"}],"name":"tokensOfOwnerIn","outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"a","type":"address"}],"name":"totalMintedByAddress","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"result","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"tokenId","type":"uint256"}],"name":"transferFrom","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"withdrawERC20","outputs":[],"stateMutability":"nonpayable","type":"function"}]
];

const stakingAbi = [
    [
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_nftCollection",
              "type": "address"
            }
          ],
          "stateMutability": "nonpayable",
          "type": "constructor"
        },
        {
          "inputs": [],
          "name": "emergencyUnstakeAll",
          "outputs": [],
          "stateMutability": "onlyOwner",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_staker",
              "type": "address"
            }
          ],
          "name": "getStakerInfo",
          "outputs": [
            {
              "internalType": "uint256[]",
              "name": "stakedTokens",
              "type": "uint256[]"
            },
            {
              "internalType": "uint256",
              "name": "totalPoints",
              "type": "uint256"
            },
            {
              "internalType": "uint256",
              "name": "tier",
              "type": "uint256"
            },
            {
              "internalType": "bool",
              "name": "isMinter",
              "type": "bool"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256",
              "name": "limit",
              "type": "uint256"
            }
          ],
          "name": "getLeaderboard",
          "outputs": [
            {
              "internalType": "address[]",
              "name": "users",
              "type": "address[]"
            },
            {
              "internalType": "uint256[]",
              "name": "points",
              "type": "uint256[]"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_user",
              "type": "address"
            }
          ],
          "name": "getPoints",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address",
              "name": "_user",
              "type": "address"
            }
          ],
          "name": "getUserTier",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "view",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "createSnapshot",
          "outputs": [
            {
              "internalType": "uint256",
              "name": "",
              "type": "uint256"
            }
          ],
          "stateMutability": "onlyOwner",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "address[]",
              "name": "_minters",
              "type": "address[]"
            }
          ],
          "name": "initializeMinters",
          "outputs": [],
          "stateMutability": "onlyOwner",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256[]",
              "name": "tokenIds",
              "type": "uint256[]"
            }
          ],
          "name": "stakeNFTs",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [
            {
              "internalType": "uint256[]",
              "name": "tokenIds",
              "type": "uint256[]"
            }
          ],
          "name": "unstakeNFTs",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "pause",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        },
        {
          "inputs": [],
          "name": "unpause",
          "outputs": [],
          "stateMutability": "nonpayable",
          "type": "function"
        }
      ]
      ];

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

async function assignDiscordRoles(sessionId, walletAddress) {
  // Use Discord.js or another library to interact with the Discord API
  // Assign roles based on the wallet's NFT holdings
}
