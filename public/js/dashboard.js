// Dashboard functionality
let sessionsChart;
let nftChart;

// Initialize charts
function initializeCharts() {
    const sessionsCtx = document.getElementById('sessionsChart').getContext('2d');
    const nftCtx = document.getElementById('nftChart').getContext('2d');

    // Sessions Chart
    sessionsChart = new Chart(sessionsCtx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Active Sessions',
                data: [],
                borderColor: 'rgb(59, 130, 246)',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: 20
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'Session Activity Over Time'
                }
            }
        }
    });

    // Set fixed height for chart containers
    document.querySelectorAll('.chart-container').forEach(container => {
        container.style.height = '300px';
    });

    // NFT Distribution Chart
    nftChart = new Chart(nftCtx, {
        type: 'doughnut',
        data: {
            labels: ['1-5 NFTs', '6-10 NFTs', '11+ NFTs'],
            datasets: [{
                data: [0, 0, 0],
                backgroundColor: [
                    'rgb(59, 130, 246)',
                    'rgb(16, 185, 129)',
                    'rgb(245, 158, 11)'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: 20
            },
            plugins: {
                legend: {
                    position: 'top',
                },
                title: {
                    display: true,
                    text: 'NFT Holdings Distribution'
                }
            }
        }
    });
}

// Format timestamp
function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

// Update status indicator
function updateStatus(status) {
    const statusElement = document.getElementById('status');
    if (status) {
        statusElement.textContent = 'Online';
        statusElement.className = 'px-4 py-2 rounded-full text-sm font-semibold bg-green-100 text-green-800';
    } else {
        statusElement.textContent = 'Offline';
        statusElement.className = 'px-4 py-2 rounded-full text-sm font-semibold bg-red-100 text-red-800';
    }
}

// Update stats with animation
function updateStats(data) {
    const stats = {
        'activeSessions': data.activeSessions || 0,
        'discordUsers': data.discordUsers || 0,
        'totalNFTs': data.totalNFTs || 0,
        'verifiedWallets': data.verifiedWallets || 0
    };

    Object.entries(stats).forEach(([id, value]) => {
        const element = document.getElementById(id);
        const currentValue = parseInt(element.textContent) || 0;
        if (currentValue !== value) {
            element.textContent = value;
            element.classList.add('text-blue-600');
            setTimeout(() => element.classList.remove('text-blue-600'), 1000);
        }
    });
}

// Update activity log
function updateActivityLog(activities) {
    const tbody = document.getElementById('activityLog');
    tbody.innerHTML = '';

    if (!activities || activities.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="4" class="px-6 py-4 text-center text-sm text-gray-500">
                No recent activity
            </td>
        `;
        tbody.appendChild(row);
        return;
    }

    activities.forEach(activity => {
        const row = document.createElement('tr');
        row.className = 'table-row-hover';
        row.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${activity.username || 'Unknown'}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${activity.action || 'Action'}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${formatTime(activity.timestamp)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${activity.details || ''}</td>
        `;
        tbody.appendChild(row);
    });
}

// Update charts
function updateCharts(data) {
    try {
        // Update sessions chart
        if (data.sessionHistory && Array.isArray(data.sessionHistory)) {
            const labels = data.sessionHistory.map(item => formatTime(item.timestamp));
            const values = data.sessionHistory.map(item => item.count);

            sessionsChart.data.labels = labels;
            sessionsChart.data.datasets[0].data = values;
            sessionsChart.update('none'); // Use 'none' mode for smoother updates
        }

        // Update NFT distribution chart
        if (data.nftDistribution) {
            const values = [
                data.nftDistribution.small || 0,
                data.nftDistribution.medium || 0,
                data.nftDistribution.large || 0
            ];

            nftChart.data.datasets[0].data = values;
            nftChart.update('none'); // Use 'none' mode for smoother updates
        }
    } catch (error) {
        console.error('Error updating charts:', error);
    }
}

// Fetch dashboard data
async function fetchDashboardData() {
    try {
        // Use the frontend API key
        const apiKey = 'toFB_PRi0Fo3ySUgZv8TbkXjBOIW7V6i2lbWUGYuJJY';
        
        console.log('Fetching dashboard data...');
        const response = await fetch('/api/dashboard', {
            headers: {
                'x-api-key': apiKey
            }
        });
        
        if (!response.ok) {
            const error = await response.json();
            console.error('API Error:', error);
            throw new Error(error.error || 'Failed to fetch dashboard data');
        }

        const data = await response.json();
        console.log('Received data:', data);
        
        if (data && typeof data === 'object') {
            updateStatus(data.status?.online ?? false);
            updateStats(data);
            updateActivityLog(data.recentActivity || []);
            updateCharts(data);

            if (data.status?.error) {
                console.warn('Server warning:', data.status.error);
            }
        } else {
            throw new Error('Invalid data format');
        }
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        updateStatus(false);
    }
}

// Initialize dashboard
function initializeDashboard() {
    // Add chart containers
    document.querySelectorAll('.bg-white.shadow.rounded-lg').forEach(container => {
        if (container.querySelector('canvas')) {
            container.classList.add('chart-container');
        }
    });

    initializeCharts();
    fetchDashboardData();
    
    // Update data every 30 seconds
    setInterval(fetchDashboardData, 30000);
}

// Start the dashboard when the page loads
document.addEventListener('DOMContentLoaded', initializeDashboard); 