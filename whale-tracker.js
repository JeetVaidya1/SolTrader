// Whale Wallet Tracking - Copy successful traders
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const HELIUS_API = 'https://api.helius.xyz/v0';
const SOLSCAN_API = 'https://pro-api.solscan.io/v2.0';

// Known profitable whale wallets (add more as you discover them)
// These are example addresses - replace with real profitable wallets
const WHALE_WALLETS = [
  // Format: { address: 'wallet', name: 'label', minTradeSize: 1 }
  // You can find these by:
  // 1. Looking at top traders on birdeye.so/find-gems
  // 2. Checking profitable wallets on solscan
  // 3. Following crypto twitter for wallet callouts
];

const WHALE_FILE = './data/whale-wallets.json';
const WHALE_TRADES_FILE = './data/whale-trades.json';

// Load whale wallets from file (persistent storage)
function loadWhaleWallets() {
  try {
    if (fs.existsSync(WHALE_FILE)) {
      const data = JSON.parse(fs.readFileSync(WHALE_FILE, 'utf8'));
      return data.wallets || [];
    }
  } catch (err) {
    console.error('Error loading whale wallets:', err.message);
  }
  return WHALE_WALLETS;
}

// Save whale wallets to file
function saveWhaleWallets(wallets) {
  try {
    const dir = path.dirname(WHALE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WHALE_FILE, JSON.stringify({ wallets, updatedAt: Date.now() }, null, 2));
  } catch (err) {
    console.error('Error saving whale wallets:', err.message);
  }
}

// Add a whale wallet to track
function addWhaleWallet(address, name = 'Unknown', minTradeSize = 1) {
  const wallets = loadWhaleWallets();
  if (!wallets.find(w => w.address === address)) {
    wallets.push({ address, name, minTradeSize, addedAt: Date.now() });
    saveWhaleWallets(wallets);
    console.log(`Added whale wallet: ${name} (${address.slice(0, 8)}...)`);
    return true;
  }
  return false;
}

// Get recent transactions for a wallet using Helius
async function getWalletTransactions(walletAddress, limit = 20) {
  if (!config.heliusApiKey) {
    return [];
  }

  try {
    const response = await axios.get(
      `${HELIUS_API}/addresses/${walletAddress}/transactions`,
      {
        params: {
          'api-key': config.heliusApiKey,
          limit: limit,
        },
        timeout: 15000,
      }
    );

    return response.data || [];
  } catch (err) {
    console.error(`Error fetching wallet txns for ${walletAddress.slice(0, 8)}...: ${err.message}`);
    return [];
  }
}

// Parse swap transactions to find token buys
function parseSwapTransactions(transactions, walletAddress) {
  const swaps = [];

  for (const tx of transactions) {
    try {
      // Look for token transfers indicating swaps
      if (tx.type === 'SWAP' || tx.description?.includes('swap')) {
        const tokenTransfers = tx.tokenTransfers || [];

        for (const transfer of tokenTransfers) {
          // If wallet received tokens (buy)
          if (transfer.toUserAccount === walletAddress && transfer.mint) {
            swaps.push({
              type: 'BUY',
              tokenAddress: transfer.mint,
              amount: transfer.tokenAmount,
              timestamp: tx.timestamp * 1000,
              signature: tx.signature,
              walletAddress,
            });
          }
          // If wallet sent tokens (sell)
          if (transfer.fromUserAccount === walletAddress && transfer.mint) {
            swaps.push({
              type: 'SELL',
              tokenAddress: transfer.mint,
              amount: transfer.tokenAmount,
              timestamp: tx.timestamp * 1000,
              signature: tx.signature,
              walletAddress,
            });
          }
        }
      }
    } catch (err) {
      // Skip malformed transactions
    }
  }

  return swaps;
}

// Get recent whale buys across all tracked wallets
async function getRecentWhaleBuys(maxAgeMinutes = 30) {
  const wallets = loadWhaleWallets();
  const recentBuys = [];
  const cutoffTime = Date.now() - (maxAgeMinutes * 60 * 1000);

  console.log(`Checking ${wallets.length} whale wallets for recent buys...`);

  for (const whale of wallets) {
    try {
      const transactions = await getWalletTransactions(whale.address, 20);
      const swaps = parseSwapTransactions(transactions, whale.address);

      // Filter for recent buys
      const buys = swaps.filter(s =>
        s.type === 'BUY' &&
        s.timestamp > cutoffTime &&
        // Skip SOL and stablecoins
        !['So11111111111111111111111111111111111111112',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(s.tokenAddress)
      );

      for (const buy of buys) {
        recentBuys.push({
          ...buy,
          whaleName: whale.name,
          whaleAddress: whale.address,
        });
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`Error checking whale ${whale.name}: ${err.message}`);
    }
  }

  // Sort by timestamp (most recent first)
  recentBuys.sort((a, b) => b.timestamp - a.timestamp);

  console.log(`Found ${recentBuys.length} recent whale buys`);
  return recentBuys;
}

// Save whale trade for analysis
function saveWhaleTrade(trade) {
  try {
    let trades = { buys: [], sells: [] };
    if (fs.existsSync(WHALE_TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(WHALE_TRADES_FILE, 'utf8'));
    }

    if (trade.type === 'BUY') {
      trades.buys.push({ ...trade, recordedAt: Date.now() });
      // Keep last 100 trades
      trades.buys = trades.buys.slice(-100);
    } else {
      trades.sells.push({ ...trade, recordedAt: Date.now() });
      trades.sells = trades.sells.slice(-100);
    }

    fs.writeFileSync(WHALE_TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (err) {
    console.error('Error saving whale trade:', err.message);
  }
}

// Find wallets that are profitable (for discovering new whales)
async function findProfitableWallets(tokenAddress) {
  // This would require more sophisticated on-chain analysis
  // For now, return empty - users can manually add wallets
  return [];
}

module.exports = {
  loadWhaleWallets,
  saveWhaleWallets,
  addWhaleWallet,
  getWalletTransactions,
  getRecentWhaleBuys,
  saveWhaleTrade,
  findProfitableWallets,
  WHALE_WALLETS,
};
