// Social Sentiment Signals - Detect viral tokens early
const axios = require('axios');
const fs = require('fs');
const config = require('./config');

// Free/accessible APIs for social signals
const DEXSCREENER_API = 'https://api.dexscreener.com';

// Track tokens we've seen and their social scores
const SOCIAL_CACHE_FILE = './data/social-cache.json';

// Load social cache
function loadSocialCache() {
  try {
    if (fs.existsSync(SOCIAL_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(SOCIAL_CACHE_FILE, 'utf8'));
    }
  } catch (err) {}
  return { tokens: {}, lastUpdate: 0 };
}

// Save social cache
function saveSocialCache(cache) {
  try {
    fs.writeFileSync(SOCIAL_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Error saving social cache:', err.message);
  }
}

// Get tokens that are being promoted/boosted on DexScreener
// This is a proxy for social attention
async function getBoostedTokens() {
  try {
    const response = await axios.get(`${DEXSCREENER_API}/token-boosts/latest/v1`, {
      timeout: 15000,
    });

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    // Filter for Solana and recent boosts
    return response.data
      .filter(t => t.chainId === 'solana')
      .map(t => ({
        address: t.tokenAddress,
        symbol: t.symbol || 'UNKNOWN',
        boostAmount: t.amount || 0,
        totalBoosts: t.totalAmount || 0,
        url: t.url,
        source: 'dexscreener_boost',
      }));
  } catch (err) {
    console.error('Error fetching boosted tokens:', err.message);
    return [];
  }
}

// Search for trending tokens by common memecoin themes
async function searchTrendingThemes() {
  const themes = [
    // Classic memes
    'pepe', 'doge', 'shib', 'wojak', 'chad', 'bonk', 'floki',
    // Political/celebrity
    'trump', 'elon', 'biden', 'musk', 'kanye',
    // Tech/AI themes
    'ai', 'grok', 'gpt', 'agent', 'bot', 'neural',
    // Animals
    'cat', 'dog', 'frog', 'monkey', 'ape', 'bear', 'bull', 'whale',
    // Crypto culture
    'moon', 'rocket', 'gem', 'diamond', 'hodl', 'wagmi', 'gm',
    // Current events (update these periodically)
    'valentine', 'love', 'heart', 'super', 'bowl',
    // Solana specific
    'sol', 'solana', 'pump', 'fun', 'raydium',
    // Misc trending
    'baby', 'mini', 'inu', 'coin', 'token', 'meme', 'based'
  ];

  const allTokens = [];

  // Search 4 random themes (balanced speed vs coverage)
  const selectedThemes = themes.sort(() => Math.random() - 0.5).slice(0, 4);

  for (const theme of selectedThemes) {
    try {
      const response = await axios.get(`${DEXSCREENER_API}/latest/dex/search`, {
        params: { q: theme },
        timeout: 15000,
      });

      if (response.data?.pairs) {
        const solanaTokens = response.data.pairs
          .filter(p => p.chainId === 'solana')
          .slice(0, 10)
          .map(p => ({
            address: p.baseToken?.address,
            symbol: p.baseToken?.symbol,
            name: p.baseToken?.name,
            priceChange1h: p.priceChange?.h1 || 0,
            priceChange24h: p.priceChange?.h24 || 0,
            volume24h: p.volume?.h24 || 0,
            liquidity: p.liquidity?.usd || 0,
            txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
            theme: theme,
            source: 'theme_search',
          }));

        allTokens.push(...solanaTokens);
      }

      await new Promise(r => setTimeout(r, 150)); // Faster
    } catch (err) {
      // Skip errors
    }
  }

  return allTokens;
}

// Detect tokens with sudden social/trading activity spike
async function detectViralTokens() {
  const cache = loadSocialCache();
  const viralTokens = [];

  // Get boosted tokens (paid promotion = attention)
  const boosted = await getBoostedTokens();
  console.log(`Found ${boosted.length} boosted tokens`);

  // Get trending theme tokens
  const trending = await searchTrendingThemes();
  console.log(`Found ${trending.length} theme-matching tokens`);

  // Combine and analyze
  const allTokens = [...boosted, ...trending];

  for (const token of allTokens) {
    if (!token.address) continue;

    const cached = cache.tokens[token.address];
    const now = Date.now();

    // Calculate "viral score" based on:
    // 1. Being boosted on DexScreener
    // 2. High transaction count
    // 3. Positive momentum

    let viralScore = 0;

    // Boosted = high interest
    if (token.source === 'dexscreener_boost') {
      viralScore += 30;
      viralScore += Math.min(token.totalBoosts || 0, 50); // Cap at 50 for boosts
    }

    // High activity
    if (token.txns24h > 100) viralScore += 20;
    else if (token.txns24h > 50) viralScore += 10;

    // Positive momentum
    if (token.priceChange1h > 50) viralScore += 25;
    else if (token.priceChange1h > 20) viralScore += 15;
    else if (token.priceChange1h > 0) viralScore += 5;

    // Volume spike (if we have cached data)
    if (cached && cached.volume24h > 0) {
      const volumeMultiple = (token.volume24h || 0) / cached.volume24h;
      if (volumeMultiple > 5) viralScore += 30;
      else if (volumeMultiple > 2) viralScore += 15;
    }

    // Update cache
    cache.tokens[token.address] = {
      symbol: token.symbol,
      volume24h: token.volume24h || 0,
      lastSeen: now,
      viralScore,
    };

    // Consider viral if score > 40
    if (viralScore >= 40) {
      viralTokens.push({
        ...token,
        viralScore,
        reason: getViralReason(token, viralScore),
      });
    }
  }

  // Clean old cache entries (older than 24h)
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  for (const addr of Object.keys(cache.tokens)) {
    if (cache.tokens[addr].lastSeen < oneDayAgo) {
      delete cache.tokens[addr];
    }
  }

  cache.lastUpdate = Date.now();
  saveSocialCache(cache);

  // Sort by viral score
  viralTokens.sort((a, b) => b.viralScore - a.viralScore);

  console.log(`Detected ${viralTokens.length} potentially viral tokens`);
  return viralTokens;
}

// Generate reason for viral detection
function getViralReason(token, score) {
  const reasons = [];

  if (token.source === 'dexscreener_boost') {
    reasons.push('DexScreener boosted');
  }
  if (token.priceChange1h > 50) {
    reasons.push(`+${token.priceChange1h.toFixed(0)}% 1h momentum`);
  }
  if (token.txns24h > 100) {
    reasons.push(`High activity (${token.txns24h} txns)`);
  }
  if (token.theme) {
    reasons.push(`Trending theme: ${token.theme}`);
  }

  return reasons.join(', ') || 'Social signals detected';
}

// Get social signal summary for a specific token
async function getTokenSocialSignals(tokenAddress) {
  const cache = loadSocialCache();
  const cached = cache.tokens[tokenAddress];

  const signals = {
    viralScore: cached?.viralScore || 0,
    isBoosted: false,
    theme: null,
    volumeTrend: 'stable',
  };

  // Check if currently boosted
  const boosted = await getBoostedTokens();
  signals.isBoosted = boosted.some(t => t.address === tokenAddress);

  return signals;
}

module.exports = {
  getBoostedTokens,
  searchTrendingThemes,
  detectViralTokens,
  getTokenSocialSignals,
  loadSocialCache,
};
