// Token screening using DexScreener API (indexes Pump.fun tokens)
const axios = require('axios');
const config = require('./config');

const DEXSCREENER_API = 'https://api.dexscreener.com';

// Rate limiting helper
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Get new Solana pairs from DexScreener (includes pump.fun)
async function getNewPairs() {
  try {
    // Search for recent Solana memecoins
    const response = await axios.get(`${DEXSCREENER_API}/latest/dex/search`, {
      params: { q: 'solana' },
      timeout: 15000,
    });

    if (!response.data?.pairs || !Array.isArray(response.data.pairs)) {
      return [];
    }

    return response.data.pairs
      .filter(pair => {
        // Only Solana pairs
        if (pair.chainId !== 'solana') return false;
        // Filter out stablecoins and major tokens
        const symbol = pair.baseToken?.symbol?.toUpperCase() || '';
        const skipSymbols = ['SOL', 'USDC', 'USDT', 'WETH', 'BTC', 'ETH', 'RAY', 'SRM', 'WSOL'];
        return !skipSymbols.includes(symbol);
      })
      .slice(0, 30)
      .map(pair => formatDexScreenerPair(pair));
  } catch (err) {
    console.error('Error fetching DexScreener pairs:', err.message);
    return [];
  }
}

// Search for trending/boosted tokens
async function getTrendingTokens() {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/token-boosts/top/v1`, {
      timeout: 15000,
    });

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    // Filter for Solana tokens
    const solanaTokens = response.data.filter(t => t.chainId === 'solana');

    // Get full pair data for each token
    const tokens = [];
    for (const token of solanaTokens.slice(0, 10)) {
      await delay(200);
      const details = await getTokenPairs(token.tokenAddress);
      if (details.length > 0) {
        tokens.push(details[0]);
      }
    }

    return tokens;
  } catch (err) {
    console.error('Error fetching trending tokens:', err.message);
    return [];
  }
}

// Get pairs for a specific token
async function getTokenPairs(tokenAddress) {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/latest/dex/tokens/${tokenAddress}`, {
      timeout: 15000,
    });

    if (!response.data?.pairs || !Array.isArray(response.data.pairs)) {
      return [];
    }

    // Get the main pair (highest liquidity)
    const solPairs = response.data.pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

    return solPairs.map(pair => formatDexScreenerPair(pair));
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`Error fetching token ${tokenAddress?.slice(0, 8)}...: ${err.message}`);
    }
    return [];
  }
}

// Search for tokens by name/symbol
async function searchTokens(query) {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/latest/dex/search`, {
      params: { q: query },
      timeout: 15000,
    });

    if (!response.data?.pairs) {
      return [];
    }

    return response.data.pairs
      .filter(p => p.chainId === 'solana')
      .map(pair => formatDexScreenerPair(pair));
  } catch (err) {
    console.error('Error searching tokens:', err.message);
    return [];
  }
}

// Format DexScreener pair data to our standard format
function formatDexScreenerPair(pair) {
  // Calculate token age
  const pairCreatedAt = pair.pairCreatedAt || Date.now();
  const ageMs = Date.now() - pairCreatedAt;
  const ageHours = ageMs / (1000 * 60 * 60);

  // Extract price changes
  const priceChange5m = pair.priceChange?.m5 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;

  // Detect if it's from pump.fun (Raydium pairs from pump.fun graduation)
  const dexId = pair.dexId || '';
  const isPumpFun = dexId.includes('pump') || pair.url?.includes('pump.fun');
  const isRaydium = dexId.includes('raydium');

  // Buy/sell counts from txns
  const buys = pair.txns?.h24?.buys || pair.txns?.h1?.buys || 0;
  const sells = pair.txns?.h24?.sells || pair.txns?.h1?.sells || 0;

  return {
    // Basic info
    address: pair.baseToken?.address || '',
    symbol: pair.baseToken?.symbol || 'UNKNOWN',
    name: pair.baseToken?.name || 'Unknown Token',
    pairAddress: pair.pairAddress || '',

    // Price data
    priceUsd: parseFloat(pair.priceUsd) || 0,
    priceNative: parseFloat(pair.priceNative) || 0,
    priceChange5m: priceChange5m,
    priceChange1h: priceChange1h,
    priceChange24h: priceChange24h,
    momentum: priceChange1h,

    // Volume and liquidity
    volume24h: pair.volume?.h24 || 0,
    volume1h: pair.volume?.h1 || 0,
    liquidity: pair.liquidity?.usd || 0,
    marketCap: pair.marketCap || pair.fdv || 0,

    // For compatibility
    virtualLiquidity: pair.liquidity?.usd || 0,

    // Trading activity
    recentBuyCount: buys,
    recentSellCount: sells,
    recentBuyVolume: 0,
    recentSellVolume: 0,
    buySellRatio: sells > 0 ? buys / sells : (buys > 0 ? 2 : 1),
    totalTxns24h: (buys + sells),

    // Holder data (DexScreener doesn't provide this directly)
    totalHolders: 0,
    top10HolderPercent: 0,

    // Security (assume safe for DEX-listed tokens)
    isMintable: false,
    isFreezable: false,
    ownerPercentage: 0,
    creatorPercentage: 0,

    // Age
    ageHours: ageHours,
    createdAt: pairCreatedAt,

    // Source info
    dexId: dexId,
    isPumpFun: isPumpFun,
    isRaydium: isRaydium,
    url: pair.url || '',

    // Risk assessment (will be calculated)
    riskFlags: [],
    riskScore: 0,

    // Raw data
    recentTrades: [],
    priceHistory: [],
  };
}

// Calculate risk flags for a token
function assessRisk(token) {
  const riskFlags = [];

  // Age checks
  if (token.ageHours !== null && token.ageHours !== undefined) {
    if (token.ageHours < config.risk.minTokenAgeMinutes / 60) {
      riskFlags.push(`Too new: ${token.ageHours.toFixed(1)}h`);
    }
    if (token.ageHours > config.risk.maxTokenAgeHours) {
      riskFlags.push(`Too old: ${token.ageHours.toFixed(1)}h`);
    }
  }

  // Liquidity check
  if (token.liquidity < config.risk.minLiquidityUsd) {
    riskFlags.push(`Low liquidity: $${(token.liquidity / 1000).toFixed(1)}K`);
  }

  // Volume check
  if (token.volume24h < config.screening.minVolume24h) {
    riskFlags.push(`Low volume: $${(token.volume24h / 1000).toFixed(1)}K`);
  }

  // Buy/sell ratio check
  if (token.buySellRatio < 0.5) {
    riskFlags.push(`Heavy selling: ${token.buySellRatio.toFixed(2)} ratio`);
  }

  // Price dropping
  if (token.priceChange1h < -20) {
    riskFlags.push(`Dumping: ${token.priceChange1h.toFixed(0)}% 1h`);
  }

  // Very low activity
  if (token.totalTxns24h < 10) {
    riskFlags.push(`Low activity: ${token.totalTxns24h} txns`);
  }

  return riskFlags;
}

// Pre-filter tokens based on config criteria
function preFilterTokens(tokens) {
  return tokens.filter(token => {
    // Must have address
    if (!token.address) return false;

    // Skip very old tokens
    if (token.ageHours > config.risk.maxTokenAgeHours) return false;

    // Skip very new tokens
    if (token.ageHours < config.risk.minTokenAgeMinutes / 60) return false;

    // Minimum liquidity
    if (token.liquidity < config.risk.minLiquidityUsd) return false;

    // Some activity required
    if (token.totalTxns24h < 5) return false;

    return true;
  });
}

// Full screening of a single token (quiet mode - no console spam)
async function screenToken(tokenAddress) {
  const pairs = await getTokenPairs(tokenAddress);
  if (pairs.length === 0) {
    return null;
  }

  // Get the best pair (highest liquidity)
  const token = pairs[0];

  // Assess risk
  token.riskFlags = assessRisk(token);
  token.riskScore = token.riskFlags.length;

  return token;
}

// Main screening function
async function screenMarket() {
  console.log('Starting DexScreener market screening...');

  // Get new pairs
  const newPairs = await getNewPairs();
  console.log(`Found ${newPairs.length} new pairs`);

  await delay(500);

  // Get trending tokens
  const trending = await getTrendingTokens();
  console.log(`Found ${trending.length} trending tokens`);

  // Combine and dedupe
  const seen = new Set();
  const allTokens = [];

  [...newPairs, ...trending].forEach(token => {
    if (token && token.address && !seen.has(token.address)) {
      seen.add(token.address);
      allTokens.push(token);
    }
  });

  console.log(`Total ${allTokens.length} unique tokens`);

  // Pre-filter
  const filtered = preFilterTokens(allTokens);
  console.log(`${filtered.length} tokens pass pre-filter`);

  if (filtered.length === 0 && allTokens.length > 0) {
    // Relaxed filter - just check liquidity
    console.log('Trying relaxed filter...');
    const relaxed = allTokens.filter(t =>
      t.liquidity >= 5000 &&
      t.ageHours <= 168 &&
      t.totalTxns24h >= 3
    );
    if (relaxed.length > 0) {
      console.log(`${relaxed.length} tokens pass relaxed filter`);
      filtered.push(...relaxed.slice(0, 5));
    }
  }

  // Sort by potential (momentum + volume)
  filtered.sort((a, b) => {
    const scoreA = (a.priceChange1h || 0) + (a.buySellRatio * 10) + Math.log10(a.volume24h + 1);
    const scoreB = (b.priceChange1h || 0) + (b.buySellRatio * 10) + Math.log10(b.volume24h + 1);
    return scoreB - scoreA;
  });

  // Screen top tokens
  const maxToScreen = Math.min(config.screening.tokensPerScan, 5);
  const toScreen = filtered.slice(0, maxToScreen);

  console.log(`Screening top ${toScreen.length} tokens...`);

  const screenedTokens = [];
  for (const token of toScreen) {
    // Already have data from the list, just assess risk
    token.riskFlags = assessRisk(token);
    token.riskScore = token.riskFlags.length;
    screenedTokens.push(token);
    await delay(200);
  }

  console.log(`Successfully screened ${screenedTokens.length} tokens`);

  return screenedTokens;
}

// Get current price for a token (for position monitoring)
async function getCurrentPrice(tokenAddress) {
  try {
    const pairs = await getTokenPairs(tokenAddress);
    return pairs[0]?.priceUsd || 0;
  } catch (err) {
    console.error(`Error fetching price for ${tokenAddress?.slice(0, 8)}...: ${err.message}`);
    return 0;
  }
}

// Get SOL price
async function getSolPrice() {
  try {
    const pairs = await getTokenPairs('So11111111111111111111111111111111111111112');
    return pairs[0]?.priceUsd || 100;
  } catch (err) {
    return 100; // Fallback estimate
  }
}

module.exports = {
  getNewPairs,
  getTrendingTokens,
  getTokenPairs,
  searchTokens,
  screenToken,
  screenMarket,
  getCurrentPrice,
  getSolPrice,
  preFilterTokens,
};
