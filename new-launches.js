// New Token Launch Detection - Find freshly created tokens
const axios = require('axios');
const config = require('./config');

const DEXSCREENER_API = 'https://api.dexscreener.com';

// Search terms that often catch new launches
const NEW_LAUNCH_SEARCHES = [
  'new', 'launch', 'fair', 'stealth', 'just', 'live',
  '2026', 'february', 'today', 'now'
];

// Get the latest token profiles (new listings)
async function getLatestProfiles() {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/token-profiles/latest/v1`, {
      timeout: 15000,
    });

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    // Filter for Solana tokens
    return response.data
      .filter(t => t.chainId === 'solana')
      .slice(0, 30)
      .map(t => ({
        address: t.tokenAddress,
        symbol: t.symbol || 'NEW',
        url: t.url,
        source: 'latest_profile',
      }));
  } catch (err) {
    console.error('Error fetching latest profiles:', err.message);
    return [];
  }
}

// Search for very new tokens using various queries
async function searchNewLaunches() {
  const allTokens = [];
  const seen = new Set();

  // Pick 2 random search terms (faster)
  const searches = NEW_LAUNCH_SEARCHES
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  for (const query of searches) {
    try {
      const response = await axios.get(`${DEXSCREENER_API}/latest/dex/search`, {
        params: { q: query },
        timeout: 15000,
      });

      if (response.data?.pairs) {
        const newTokens = response.data.pairs
          .filter(p => {
            if (p.chainId !== 'solana') return false;

            // Calculate age
            const ageMs = Date.now() - (p.pairCreatedAt || Date.now());
            const ageHours = ageMs / (1000 * 60 * 60);

            // Only tokens less than 6 hours old
            return ageHours < 6;
          })
          .slice(0, 10);

        for (const p of newTokens) {
          const addr = p.baseToken?.address;
          if (addr && !seen.has(addr)) {
            seen.add(addr);
            allTokens.push({
              address: addr,
              symbol: p.baseToken?.symbol,
              name: p.baseToken?.name,
              ageHours: (Date.now() - (p.pairCreatedAt || Date.now())) / (1000 * 60 * 60),
              priceUsd: parseFloat(p.priceUsd) || 0,
              liquidity: p.liquidity?.usd || 0,
              volume24h: p.volume?.h24 || 0,
              source: 'new_launch_search',
            });
          }
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      // Skip errors
    }
  }

  // Sort by age (newest first)
  allTokens.sort((a, b) => a.ageHours - b.ageHours);

  return allTokens;
}

// Get pairs sorted by creation time (newest first)
async function getNewestPairs() {
  try {
    // Search for generic terms that return many results, then filter by age
    const response = await axios.get(`${DEXSCREENER_API}/latest/dex/search`, {
      params: { q: 'sol' },
      timeout: 15000,
    });

    if (!response.data?.pairs) {
      return [];
    }

    const now = Date.now();

    return response.data.pairs
      .filter(p => p.chainId === 'solana')
      .map(p => ({
        ...p,
        ageHours: (now - (p.pairCreatedAt || now)) / (1000 * 60 * 60),
      }))
      .filter(p => p.ageHours < 4) // Only tokens less than 4 hours old
      .sort((a, b) => a.ageHours - b.ageHours)
      .slice(0, 20)
      .map(p => ({
        address: p.baseToken?.address,
        symbol: p.baseToken?.symbol,
        name: p.baseToken?.name,
        ageHours: p.ageHours,
        ageMinutes: Math.round(p.ageHours * 60),
        priceUsd: parseFloat(p.priceUsd) || 0,
        priceChange1h: p.priceChange?.h1 || 0,
        liquidity: p.liquidity?.usd || 0,
        volume24h: p.volume?.h24 || 0,
        marketCap: p.marketCap || p.fdv || 0,
        txns: (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0),
        buySellRatio: (() => {
          const buys = p.txns?.h1?.buys || 0;
          const sells = p.txns?.h1?.sells || 0;
          return sells > 0 ? buys / sells : (buys > 0 ? 2 : 1);
        })(),
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        source: 'newest_pairs',
      }));
  } catch (err) {
    console.error('Error fetching newest pairs:', err.message);
    return [];
  }
}

// Main function to detect new launches
async function detectNewLaunches() {
  // Removed duplicate console.log - called from monitor.js

  const results = [];
  const seen = new Set();

  // Get latest profiles
  const profiles = await getLatestProfiles();
  console.log(`    Found ${profiles.length} latest profiles`);

  // Get newest pairs
  const newest = await getNewestPairs();
  console.log(`    Found ${newest.length} very new pairs (<4h old)`);

  // Search for new launches
  const searched = await searchNewLaunches();
  console.log(`    Found ${searched.length} from launch searches`);

  // Combine all sources
  for (const token of [...profiles, ...newest, ...searched]) {
    if (token.address && !seen.has(token.address)) {
      seen.add(token.address);
      results.push(token);
    }
  }

  // Sort by age (newest first)
  results.sort((a, b) => (a.ageHours || 0) - (b.ageHours || 0));

  console.log(`    Total ${results.length} new launch candidates`);

  return results;
}

module.exports = {
  detectNewLaunches,
  getLatestProfiles,
  getNewestPairs,
  searchNewLaunches,
};
