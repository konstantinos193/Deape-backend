const express = require('express');
const router = express.Router();

// Store pending role updates
const pendingRoleUpdates = new Map();

// Add role update to pending queue
router.post('/role-update', async (req, res) => {
    try {
        const { userId, totalNFTs } = req.body;
        
        if (!userId || totalNFTs === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        pendingRoleUpdates.set(userId, {
            userId,
            totalNFTs,
            timestamp: Date.now()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error queueing role update:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get pending role updates
router.get('/pending-role-updates', async (req, res) => {
    try {
        const updates = Array.from(pendingRoleUpdates.values());
        pendingRoleUpdates.clear(); // Clear after sending
        res.json(updates);
    } catch (error) {
        console.error('Error fetching pending role updates:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle role update completion
router.post('/role-update/complete', async (req, res) => {
    try {
        const { userId, success, roles, error } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }

        // Remove from pending updates since it's completed
        pendingRoleUpdates.delete(userId);

        // Log the result
        if (success) {
            console.log(`Role update completed for user ${userId}:`, roles);
        } else {
            console.error(`Role update failed for user ${userId}:`, error);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error handling role update completion:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get dashboard data
router.get('/dashboard', async (req, res) => {
    try {
        console.log('Fetching dashboard data...');
        
        // Get data from the sessions map
        const sessions = req.app.get('sessions');
        const discordSessions = req.app.get('discordSessions');
        
        console.log('Sessions:', sessions ? sessions.size : 'null');
        console.log('Discord Sessions:', discordSessions ? discordSessions.size : 'null');

        // Initialize empty maps if not exists
        if (!sessions || !discordSessions) {
            console.log('Initializing empty sessions');
            req.app.set('sessions', new Map());
            req.app.set('discordSessions', new Map());
        }

        // Calculate statistics
        const activeSessions = sessions?.size || 0;
        const discordUsers = discordSessions?.size || 0;
        let totalNFTs = 0;
        let verifiedWallets = 0;
        const nftDistribution = { small: 0, medium: 0, large: 0 };

        // Process session data
        if (sessions) {
            Array.from(sessions.values()).forEach(session => {
                if (session && session.wallets && Array.isArray(session.wallets)) {
                    verifiedWallets += session.wallets.length;
                    session.wallets.forEach(wallet => {
                        if (wallet && typeof wallet === 'object') {
                            const nftCount = parseInt(wallet.totalNFTs) || 0;
                            totalNFTs += nftCount;

                            // Update NFT distribution
                            if (nftCount <= 5) nftDistribution.small++;
                            else if (nftCount <= 10) nftDistribution.medium++;
                            else nftDistribution.large++;
                        }
                    });
                }
            });
        }

        // Generate recent activity
        const recentActivity = sessions ? Array.from(sessions.values())
            .filter(session => session && session.wallets && Array.isArray(session.wallets) && session.wallets.length > 0)
            .map(session => ({
                username: session.username || 'Unknown User',
                action: 'Wallet Verification',
                timestamp: session.createdAt || Date.now(),
                details: `Verified ${session.wallets.length} wallet(s)`
            }))
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            .slice(0, 10) : [];

        // Generate session history
        const sessionHistory = [];
        const now = Date.now();
        const validSessions = sessions ? Array.from(sessions.values()).filter(session => session && session.createdAt) : [];

        for (let i = 23; i >= 0; i--) {
            const timestamp = now - (i * 3600000);
            const count = validSessions.filter(session => session.createdAt <= timestamp).length;
            sessionHistory.push({ timestamp, count });
        }

        const response = {
            activeSessions: Math.max(0, activeSessions),
            discordUsers: Math.max(0, discordUsers),
            totalNFTs: Math.max(0, totalNFTs),
            verifiedWallets: Math.max(0, verifiedWallets),
            nftDistribution: {
                small: Math.max(0, nftDistribution.small),
                medium: Math.max(0, nftDistribution.medium),
                large: Math.max(0, nftDistribution.large)
            },
            recentActivity,
            sessionHistory,
            status: {
                uptime: Math.max(0, process.uptime() * 1000),
                timestamp: now,
                online: true
            }
        };

        console.log('Sending response:', response);
        res.json(response);
    } catch (error) {
        console.error('Error in dashboard route:', error);
        res.json({
            activeSessions: 0,
            discordUsers: 0,
            totalNFTs: 0,
            verifiedWallets: 0,
            nftDistribution: { small: 0, medium: 0, large: 0 },
            recentActivity: [],
            sessionHistory: Array(24).fill(0).map((_, i) => ({
                timestamp: Date.now() - (i * 3600000),
                count: 0
            })),
            status: {
                uptime: 0,
                timestamp: Date.now(),
                online: false,
                error: error.message
            }
        });
    }
});

module.exports = router; 