// Risk management configuration
require('dotenv').config();

const config = {
  // API Keys
  heliusApiKey: process.env.HELIUS_API_KEY,
  birdeyeApiKey: process.env.BIRDEYE_API_KEY,

  // Wallet
  walletAddress: process.env.WALLET_ADDRESS,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,

  // RPC Endpoint
  rpcUrl: process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com',

  // Token addresses
  tokens: {
    SOL: 'So11111111111111111111111111111111111111112', // Wrapped SOL
  },

  // Risk Management
  risk: {
    // Maximum SOL to keep in trading wallet
    solBalanceLimit: parseFloat(process.env.SOL_BALANCE_LIMIT) || 100,

    // Maximum position size in SOL (smaller = less risk per trade)
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE) || 5,

    // Maximum loss per day in SOL before stopping
    maxLossPerDay: parseFloat(process.env.MAX_LOSS_PER_DAY) || 20,

    // Maximum number of concurrent positions (lower = less risk, more selective)
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 2,

    // Stop loss percentage (tight = cut losses fast)
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || -15,

    // Take profit levels - take profits quickly, don't get greedy
    takeProfitLevels: [
      { percent: 20, sellPercent: 50 },   // At +20%, sell 50% (lock in half!)
      { percent: 40, sellPercent: 30 },   // At +40%, sell 30% more
      { percent: 100, sellPercent: 20 },  // At +100%, sell most of rest
    ],

    // Trailing stop (activates after first take profit hit)
    trailingStopPercent: 12, // Sell if drops 12% from highest price (tight protection)

    // Dead token timeout - exit if no movement
    deadTokenTimeoutHours: 6,

    // Minimum liquidity in USD for a token to be considered
    // Lower for pump.fun tokens (they start small)
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD) || 10000,

    // Maximum token age in hours (focus on fresh tokens)
    maxTokenAgeHours: parseInt(process.env.MAX_TOKEN_AGE_HOURS) || 6,

    // Minimum token age in minutes (lower = riskier but earlier entries)
    minTokenAgeMinutes: parseInt(process.env.MIN_TOKEN_AGE_MINUTES) || 10,
  },

  // Screening Settings
  screening: {
    // How often to scan for new tokens (in minutes)
    intervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES) || 5,

    // Number of top tokens to analyze per scan
    tokensPerScan: parseInt(process.env.TOKENS_PER_SCAN) || 10,

    // Minimum 24h volume in USD (lower for pump.fun)
    minVolume24h: parseFloat(process.env.MIN_VOLUME_24H) || 5000,

    // Minimum number of holders (lower for pump.fun - new tokens)
    minHolders: parseInt(process.env.MIN_HOLDERS) || 20,

    // Maximum top 10 holder concentration (e.g., 0.5 = 50%)
    maxTop10HolderPercent: parseFloat(process.env.MAX_TOP10_HOLDER_PERCENT) || 0.5,
  },

  // Paths
  paths: {
    stateFile: './data/state.json',
    tradeHistoryFile: './data/trade-history.json',
    decisionsFile: './data/decisions.json',
    strategyFile: './claude-strategy.md',
    claudeLog: './data/claude-decisions.log',
  },

  // Claude Code settings
  claude: {
    // Timeout for Claude decisions in milliseconds
    decisionTimeout: parseInt(process.env.CLAUDE_TIMEOUT) || 120000,
  },
};

// Validation
function validateConfig() {
  // Only wallet address is required now (pump.fun API is free)
  const required = ['walletAddress'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    console.error('Missing required configuration:', missing.join(', '));
    console.error('Please check your .env file');
    process.exit(1);
  }

  // Warn if no private key (can still run in paper mode)
  if (!config.walletPrivateKey) {
    console.warn('WARNING: No WALLET_PRIVATE_KEY set. Live trading will not work.');
  }
}

module.exports = config;
module.exports.validateConfig = validateConfig;
