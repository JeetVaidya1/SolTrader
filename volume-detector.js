// Volume Spike Detection - Find tokens with sudden activity
const axios = require('axios');
const fs = require('fs');
const config = require('./config');

const DEXSCREENER_API = 'https://api.dexscreener.com';
const VOLUME_CACHE_FILE = './data/volume-cache.json';

// Load volume history cache
function loadVolumeCache() {
  try {
    if (fs.existsSync(VOLUME_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(VOLUME_CACHE_FILE, 'utf8'));
    }
  } catch (err) {}
  return { tokens: {}, lastUpdate: 0 };
}

// Save volume cache
function saveVolumeCache(cache) {
  try {
    fs.writeFileSync(VOLUME_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Error saving volume cache:', err.message);
  }
}

// Get token data from DexScreener
async function getTokenData(tokenAddress) {
  try {
    const response = await axios.get(
      `${DEXSCREENER_API}/latest/dex/tokens/${tokenAddress}`,
      { timeout: 15000 }
    );

    if (!response.data?.pairs?.length) return null;

    // Get the main Solana pair
    const pair = response.data.pairs.find(p => p.chainId === 'solana');
    return pair || response.data.pairs[0];
  } catch (err) {
    return null;
  }
}

// Calculate volume metrics for a token
function calculateVolumeMetrics(currentData, historicalData) {
  const metrics = {
    volume1h: currentData.volume?.h1 || 0,
    volume24h: currentData.volume?.h24 || 0,
    volume5m: currentData.volume?.m5 || 0,
    txns1h: (currentData.txns?.h1?.buys || 0) + (currentData.txns?.h1?.sells || 0),
    txns24h: (currentData.txns?.h24?.buys || 0) + (currentData.txns?.h24?.sells || 0),
    buySellRatio: 1,
    volumeSpike: 1,
    activitySpike: 1,
  };

  // Calculate buy/sell ratio
  const buys = currentData.txns?.h1?.buys || 0;
  const sells = currentData.txns?.h1?.sells || 0;
  metrics.buySellRatio = sells > 0 ? buys / sells : (buys > 0 ? 2 : 1);

  // Calculate spikes if we have historical data
  if (historicalData) {
    const histVolume = historicalData.volume1h || 1;
    const histTxns = historicalData.txns1h || 1;

    metrics.volumeSpike = metrics.volume1h / histVolume;
    metrics.activitySpike = metrics.txns1h / histTxns;
  }

  return metrics;
}

// Detect tokens with volume spikes
async function detectVolumeSpikes(minSpikeMultiple = 3) {
  const cache = loadVolumeCache();
  const spikes = [];

  // Get trending tokens to check
  let tokensToCheck = [];

  try {
    // Get boosted/promoted tokens
    const boostResponse = await axios.get(`${DEXSCREENER_API}/token-boosts/top/v1`, {
      timeout: 15000,
    });

    if (boostResponse.data && Array.isArray(boostResponse.data)) {
      tokensToCheck = boostResponse.data
        .filter(t => t.chainId === 'solana')
        .map(t => t.tokenAddress)
        .slice(0, 20);
    }
  } catch (err) {
    console.error('Error fetching tokens for volume check:', err.message);
  }

  // Also check tokens we've been tracking
  const trackedAddresses = Object.keys(cache.tokens).slice(0, 30);
  tokensToCheck = [...new Set([...tokensToCheck, ...trackedAddresses])];

  console.log(`Checking ${tokensToCheck.length} tokens for volume spikes...`);

  for (const address of tokensToCheck) {
    try {
      const data = await getTokenData(address);
      if (!data) continue;

      const historical = cache.tokens[address];
      const metrics = calculateVolumeMetrics(data, historical);

      // Update cache with current data
      cache.tokens[address] = {
        symbol: data.baseToken?.symbol,
        volume1h: metrics.volume1h,
        volume24h: metrics.volume24h,
        txns1h: metrics.txns1h,
        lastUpdate: Date.now(),
      };

      // Check for significant spike
      const isVolumeSpike = metrics.volumeSpike >= minSpikeMultiple;
      const isActivitySpike = metrics.activitySpike >= minSpikeMultiple;
      const hasHighBuyPressure = metrics.buySellRatio > 1.5;

      if ((isVolumeSpike || isActivitySpike) && hasHighBuyPressure) {
        spikes.push({
          address,
          symbol: data.baseToken?.symbol || 'UNKNOWN',
          name: data.baseToken?.name || 'Unknown',
          priceUsd: parseFloat(data.priceUsd) || 0,
          priceChange1h: data.priceChange?.h1 || 0,
          priceChange24h: data.priceChange?.h24 || 0,
          liquidity: data.liquidity?.usd || 0,
          marketCap: data.marketCap || data.fdv || 0,
          ...metrics,
          spikeType: isVolumeSpike ? 'volume' : 'activity',
          spikeReason: getSpikeReason(metrics, isVolumeSpike, isActivitySpike),
        });
      }

      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      // Skip errors
    }
  }

  // Clean old cache entries
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const addr of Object.keys(cache.tokens)) {
    if (cache.tokens[addr].lastUpdate < oneHourAgo) {
      delete cache.tokens[addr];
    }
  }

  cache.lastUpdate = Date.now();
  saveVolumeCache(cache);

  // Sort by spike magnitude
  spikes.sort((a, b) => (b.volumeSpike + b.activitySpike) - (a.volumeSpike + a.activitySpike));

  console.log(`Detected ${spikes.length} volume spikes`);
  return spikes;
}

// Generate reason for spike
function getSpikeReason(metrics, isVolumeSpike, isActivitySpike) {
  const reasons = [];

  if (isVolumeSpike) {
    reasons.push(`Volume ${metrics.volumeSpike.toFixed(1)}x spike`);
  }
  if (isActivitySpike) {
    reasons.push(`Activity ${metrics.activitySpike.toFixed(1)}x spike`);
  }
  if (metrics.buySellRatio > 2) {
    reasons.push(`Strong buy pressure (${metrics.buySellRatio.toFixed(1)}x)`);
  }

  return reasons.join(', ');
}

// Track a specific token for volume changes
function trackToken(tokenAddress, symbol) {
  const cache = loadVolumeCache();
  if (!cache.tokens[tokenAddress]) {
    cache.tokens[tokenAddress] = {
      symbol,
      volume1h: 0,
      txns1h: 0,
      lastUpdate: Date.now(),
      tracking: true,
    };
    saveVolumeCache(cache);
  }
}

// Get volume trend for a specific token
async function getVolumeTrend(tokenAddress) {
  const cache = loadVolumeCache();
  const historical = cache.tokens[tokenAddress];

  const data = await getTokenData(tokenAddress);
  if (!data) return null;

  const metrics = calculateVolumeMetrics(data, historical);

  return {
    ...metrics,
    trend: metrics.volumeSpike > 1.5 ? 'increasing' :
           metrics.volumeSpike < 0.5 ? 'decreasing' : 'stable',
  };
}

module.exports = {
  detectVolumeSpikes,
  getVolumeTrend,
  trackToken,
  loadVolumeCache,
  calculateVolumeMetrics,
};
