#!/usr/bin/env node
// MOMENTUM SCALPER v3 - Fixed re-entry & data source issues
// Key fixes: cooldown, lower max pump, wider stop loss, better token discovery

const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// ============== MODE ==============
const LIVE_MODE = process.argv.includes('--live');
const VERBOSE = !process.argv.includes('--quiet');

// ============== CONFIGURATION ==============
const CONFIG = {
  // Timing
  SCAN_INTERVAL_MS: 30000,        // Scan for entries every 30 seconds
  MONITOR_INTERVAL_MS: 2000,      // Check position every 2 seconds

  // Position
  MAX_POSITIONS: 1,               // Focus on ONE trade at a time
  POSITION_SIZE_SOL: 5,           // SOL per trade

  // Entry Rules
  MIN_SIGNALS: 1,                 // 1 signal OK if pumping
  MIN_BUY_SELL_RATIO: 1.0,        // Just needs positive ratio
  MIN_5M_CHANGE: 5,               // Catch pumps early (5%+ in 5min)
  MAX_5M_CHANGE: 40,              // DON'T BUY TOPS - lowered from 80% to 40%
  MIN_LIQUIDITY: 8000,            // $8K minimum
  MAX_AGE_HOURS: 4,               // Focus on fresher tokens (4h max)

  // Cooldowns (CRITICAL - prevents re-entry disasters)
  COOLDOWN_MINUTES: 10,           // Don't re-buy ANY token for 10 min after selling
  PROFIT_COOLDOWN_MINUTES: 30,    // Don't re-buy tokens we sold at PROFIT for 30 min (they're topping)

  // Exit Rules
  TAKE_PROFIT_PERCENT: 5,         // +5% = quick scalp, take profit fast
  STOP_LOSS_PERCENT: -10,         // -10% = cut losses
  MAX_HOLD_MINUTES: 10,           // Dead trade timeout
  MIN_PROFIT_FOR_HOLD: 5,         // Need +5% to hold past timeout

  // API
  DEXSCREENER_API: 'https://api.dexscreener.com',
  GECKOTERMINAL_API: 'https://api.geckoterminal.com/api/v2',
};

// ============== STATE ==============
let currentPosition = null;
let stats = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
let isScanning = false;

// Cooldown tracking
let tokenCooldowns = new Map();      // address -> { time, wasProfit }
let seenTokens = new Set();          // Track tokens we've seen this session

// ============== UTILITIES ==============
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Check if token is on cooldown
function isOnCooldown(address) {
  if (!tokenCooldowns.has(address)) return false;
  const cd = tokenCooldowns.get(address);
  const cooldownMs = cd.wasProfit
    ? CONFIG.PROFIT_COOLDOWN_MINUTES * 60 * 1000  // Longer cooldown for profit exits
    : CONFIG.COOLDOWN_MINUTES * 60 * 1000;
  const elapsed = Date.now() - cd.time;
  return elapsed < cooldownMs;
}

function getCooldownInfo(address) {
  if (!tokenCooldowns.has(address)) return null;
  const cd = tokenCooldowns.get(address);
  const cooldownMs = cd.wasProfit
    ? CONFIG.PROFIT_COOLDOWN_MINUTES * 60 * 1000
    : CONFIG.COOLDOWN_MINUTES * 60 * 1000;
  const remaining = cooldownMs - (Date.now() - cd.time);
  return { remaining: Math.max(0, remaining), wasProfit: cd.wasProfit };
}

// ============== API FUNCTIONS ==============

// Get latest token profiles
async function getLatestProfiles() {
  try {
    const response = await axios.get(
      `${CONFIG.DEXSCREENER_API}/token-profiles/latest/v1`,
      { timeout: 5000 }
    );

    if (!response.data || !Array.isArray(response.data)) return [];

    return response.data
      .filter(t => t.chainId === 'solana')
      .slice(0, 20)
      .map(t => ({
        address: t.tokenAddress,
        source: 'PROFILE'
      }));
  } catch (err) {
    return [];
  }
}

// Search DexScreener with multiple terms - FIXED to actually work
async function getSearchTokens() {
  try {
    const results = [];

    // Use different search terms each time for variety
    const allSearches = ['pump', 'moon', 'pepe', 'dog', 'cat', 'ai', 'meme', 'sol', 'doge', 'shib', 'elon', 'trump', 'wojak', 'chad', 'based'];
    const picks = allSearches.sort(() => Math.random() - 0.5).slice(0, 4);

    for (const q of picks) {
      try {
        const response = await axios.get(
          `${CONFIG.DEXSCREENER_API}/latest/dex/search?q=${q}`,
          { timeout: 5000 }
        );

        if (response.data?.pairs) {
          const fresh = response.data.pairs
            .filter(p => {
              if (p.chainId !== 'solana') return false;
              const ageHours = (Date.now() - (p.pairCreatedAt || Date.now())) / (1000 * 60 * 60);
              const hasLiquidity = (p.liquidity?.usd || 0) >= 5000; // Lower threshold for discovery
              const isPumping = (p.priceChange?.m5 || 0) > 0;
              return ageHours <= CONFIG.MAX_AGE_HOURS && hasLiquidity && isPumping;
            })
            .slice(0, 5)
            .map(p => ({
              address: p.baseToken?.address,
              source: 'SEARCH'
            }));
          results.push(...fresh);
        }
        await sleep(100); // Small delay to avoid rate limits
      } catch (e) {}
    }

    // Deduplicate
    const seen = new Set();
    return results.filter(r => {
      if (!r.address || seen.has(r.address)) return false;
      seen.add(r.address);
      return true;
    });
  } catch (err) {
    return [];
  }
}

// Get gainers from search - FIXED
async function getGainers() {
  try {
    // Search for "solana" and filter by gainers
    const response = await axios.get(
      `${CONFIG.DEXSCREENER_API}/latest/dex/search?q=pump`,
      { timeout: 5000 }
    );

    if (!response.data?.pairs) return [];

    return response.data.pairs
      .filter(p => {
        if (p.chainId !== 'solana') return false;
        const change5m = p.priceChange?.m5 || 0;
        const hasLiquidity = (p.liquidity?.usd || 0) >= 5000;
        const ageHours = (Date.now() - (p.pairCreatedAt || Date.now())) / (1000 * 60 * 60);
        return change5m >= 5 && hasLiquidity && ageHours <= CONFIG.MAX_AGE_HOURS;
      })
      .sort((a, b) => (b.priceChange?.m5 || 0) - (a.priceChange?.m5 || 0))
      .slice(0, 10)
      .map(p => ({
        address: p.baseToken?.address,
        source: 'GAINER'
      }));
  } catch (err) {
    return [];
  }
}

// Get new pairs - search for recently created
async function getNewPairs() {
  try {
    const response = await axios.get(
      `${CONFIG.DEXSCREENER_API}/latest/dex/search?q=new`,
      { timeout: 5000 }
    );

    if (!response.data?.pairs) return [];

    return response.data.pairs
      .filter(p => {
        if (p.chainId !== 'solana') return false;
        const ageHours = (Date.now() - (p.pairCreatedAt || Date.now())) / (1000 * 60 * 60);
        const hasLiquidity = (p.liquidity?.usd || 0) >= 5000;
        return ageHours <= 2 && hasLiquidity; // Very fresh (< 2 hours)
      })
      .slice(0, 10)
      .map(p => ({
        address: p.baseToken?.address,
        source: 'NEW'
      }));
  } catch (err) {
    return [];
  }
}

// Get trending tokens (top boosts)
async function getTrendingTokens() {
  try {
    const response = await axios.get(`${CONFIG.DEXSCREENER_API}/token-boosts/top/v1`, {
      timeout: 5000,
    });

    if (!response.data || !Array.isArray(response.data)) return [];

    return response.data
      .filter(t => t.chainId === 'solana')
      .slice(0, 10)
      .map(t => ({
        address: t.tokenAddress,
        source: 'TREND'
      }));
  } catch (err) {
    return [];
  }
}

// Get boosted tokens (latest boosts)
async function getBoostedTokens() {
  try {
    const response = await axios.get(`${CONFIG.DEXSCREENER_API}/token-boosts/latest/v1`, {
      timeout: 5000,
    });

    if (!response.data || !Array.isArray(response.data)) return [];

    return response.data
      .filter(t => t.chainId === 'solana')
      .slice(0, 10)
      .map(t => ({
        address: t.tokenAddress,
        source: 'BOOST'
      }));
  } catch (err) {
    return [];
  }
}

// GET FRESH TOKENS FROM GECKOTERMINAL (NEW POOLS!) - This is the key source for fresh tokens
async function getGeckoNewPools() {
  try {
    const response = await axios.get(`${CONFIG.GECKOTERMINAL_API}/networks/solana/new_pools?page=1`, {
      timeout: 10000,
      headers: { 'Accept': 'application/json' }
    });

    if (!response.data?.data) return [];

    return response.data.data
      .filter(p => {
        const attrs = p.attributes;
        const liquidity = parseFloat(attrs.reserve_in_usd) || 0;
        const ageMinutes = (Date.now() - new Date(attrs.pool_created_at).getTime()) / 60000;
        const isPumpFun = p.relationships?.dex?.data?.id === 'pump-fun';

        // Lower liquidity threshold for pump.fun (they start small), higher for others
        const minLiq = isPumpFun ? 2000 : 5000;
        return liquidity >= minLiq && ageMinutes <= 60; // Fresh tokens only (1 hour)
      })
      .slice(0, 20)
      .map(p => {
        const tokenAddress = p.relationships?.base_token?.data?.id?.replace('solana_', '');
        const isPumpFun = p.relationships?.dex?.data?.id === 'pump-fun';
        return {
          address: tokenAddress,
          source: isPumpFun ? 'PUMP_FUN' : 'GECKO_NEW'  // Tag pump.fun tokens specifically
        };
      })
      .filter(t => t.address);
  } catch (err) {
    return [];
  }
}

// Get trending pools from GeckoTerminal
async function getGeckoTrending() {
  try {
    const response = await axios.get(`${CONFIG.GECKOTERMINAL_API}/networks/solana/trending_pools`, {
      timeout: 10000,
      headers: { 'Accept': 'application/json' }
    });

    if (!response.data?.data) return [];

    return response.data.data
      .filter(p => {
        const attrs = p.attributes;
        const liquidity = parseFloat(attrs.reserve_in_usd) || 0;
        return liquidity >= 5000;
      })
      .slice(0, 10)
      .map(p => {
        const tokenAddress = p.relationships?.base_token?.data?.id?.replace('solana_', '');
        return {
          address: tokenAddress,
          source: 'GECKO_TREND'
        };
      })
      .filter(t => t.address);
  } catch (err) {
    return [];
  }
}

// Get token data
async function getTokenData(address) {
  try {
    const response = await axios.get(
      `${CONFIG.DEXSCREENER_API}/latest/dex/tokens/${address}`,
      { timeout: 5000 }
    );

    if (!response.data?.pairs?.length) return null;

    const pair = response.data.pairs.find(p => p.chainId === 'solana');
    if (!pair) return null;

    return {
      address: pair.baseToken?.address,
      symbol: pair.baseToken?.symbol || '???',
      priceUsd: parseFloat(pair.priceUsd) || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume1h: pair.volume?.h1 || 0,
      buys: pair.txns?.h1?.buys || 0,
      sells: pair.txns?.h1?.sells || 0,
      buySellRatio: (() => {
        const b = pair.txns?.h1?.buys || 0;
        const s = pair.txns?.h1?.sells || 0;
        return s > 0 ? b / s : (b > 0 ? 2 : 1);
      })(),
      ageHours: (Date.now() - (pair.pairCreatedAt || Date.now())) / (1000 * 60 * 60),
      marketCap: pair.marketCap || pair.fdv || 0,
    };
  } catch (err) {
    return null;
  }
}

// ============== EXIT LOGIC ==============

function checkExitRules(position, currentPrice) {
  const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const holdMinutes = (Date.now() - position.entryTime) / (1000 * 60);

  // Take profit
  if (pnlPercent >= CONFIG.TAKE_PROFIT_PERCENT) {
    return { shouldExit: true, reason: 'TAKE_PROFIT', pnlPercent };
  }

  // Stop loss
  if (pnlPercent <= CONFIG.STOP_LOSS_PERCENT) {
    return { shouldExit: true, reason: 'STOP_LOSS', pnlPercent };
  }

  // Timeout
  if (holdMinutes >= CONFIG.MAX_HOLD_MINUTES && pnlPercent < CONFIG.MIN_PROFIT_FOR_HOLD) {
    return { shouldExit: true, reason: 'TIMEOUT', pnlPercent };
  }

  return { shouldExit: false, pnlPercent, holdMinutes };
}

// ============== TRADE EXECUTION ==============

function executeBuy(token) {
  const mode = LIVE_MODE ? '🔴 LIVE' : '📝 PAPER';

  currentPosition = {
    address: token.address,
    symbol: token.symbol,
    entryPrice: token.priceUsd,
    entryTime: Date.now(),
    solAmount: CONFIG.POSITION_SIZE_SOL,
  };

  // Mark as seen
  seenTokens.add(token.address);

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  🟢 ${mode} BUY ${token.symbol}`);
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  💵 Price: $${token.priceUsd.toFixed(8)}`);
  console.log(`│  📦 Size: ${CONFIG.POSITION_SIZE_SOL} SOL`);
  console.log(`│  📊 5m: +${token.priceChange5m.toFixed(1)}% | Ratio: ${token.buySellRatio.toFixed(2)} | Liq: $${(token.liquidity/1000).toFixed(0)}K`);
  console.log(`│  🎯 TP: +${CONFIG.TAKE_PROFIT_PERCENT}% | SL: ${CONFIG.STOP_LOSS_PERCENT}% | Timeout: ${CONFIG.MAX_HOLD_MINUTES}min`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  stats.trades++;
}

function executeSell(reason, currentPrice, pnlPercent) {
  const mode = LIVE_MODE ? '🔴 LIVE' : '📝 PAPER';
  const pnlSol = (pnlPercent / 100) * currentPosition.solAmount;
  const wasProfit = pnlPercent >= 0;

  const emoji = wasProfit ? '🟢' : '🔴';
  const reasonEmoji = reason === 'TAKE_PROFIT' ? '🎯' : reason === 'STOP_LOSS' ? '🛑' : '⏰';
  const holdTime = ((Date.now() - currentPosition.entryTime) / 60000).toFixed(1);

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  ${emoji} ${mode} SELL ${currentPosition.symbol}`);
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  ${reasonEmoji} Reason: ${reason}`);
  console.log(`│  💵 Exit: $${currentPrice.toFixed(8)} (Entry: $${currentPosition.entryPrice.toFixed(8)})`);
  console.log(`│  ⏱️  Hold Time: ${holdTime} minutes`);
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  ${emoji} P&L: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(2)} SOL)`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // Add to cooldown with profit flag
  tokenCooldowns.set(currentPosition.address, {
    time: Date.now(),
    wasProfit: wasProfit
  });

  const cooldownMins = wasProfit ? CONFIG.PROFIT_COOLDOWN_MINUTES : CONFIG.COOLDOWN_MINUTES;
  log(`⏸️ ${currentPosition.symbol} on cooldown for ${cooldownMins} min ${wasProfit ? '(profit exit - longer cooldown)' : ''}`);

  if (wasProfit) {
    stats.wins++;
  } else {
    stats.losses++;
  }
  stats.totalPnl += pnlSol;

  currentPosition = null;
  printStats();
}

function printStats() {
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(0) : 0;
  const pnlEmoji = stats.totalPnl >= 0 ? '🟢' : '🔴';
  log(`${pnlEmoji} Session: ${stats.trades} trades | ${stats.wins}W/${stats.losses}L (${winRate}%) | P&L: ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} SOL`);
}

// ============== POSITION MONITOR ==============

async function monitorPosition() {
  if (!currentPosition) return;

  const token = await getTokenData(currentPosition.address);
  if (!token) {
    log(`⚠️ Cannot get price for ${currentPosition.symbol}`);
    return;
  }

  const exitCheck = checkExitRules(currentPosition, token.priceUsd);

  if (exitCheck.shouldExit) {
    executeSell(exitCheck.reason, token.priceUsd, exitCheck.pnlPercent);
  } else {
    const pnl = exitCheck.pnlPercent;
    const mins = exitCheck.holdMinutes.toFixed(1);
    const emoji = pnl >= 0 ? '📈' : '📉';
    const pnlSol = (pnl / 100) * currentPosition.solAmount;

    // Progress bar for TP/SL (-10% to +5%)
    const progress = Math.min(100, Math.max(0, (pnl + 10) / 15 * 100));
    const barLen = 20;
    const filled = Math.round(progress / 100 * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    process.stdout.write(`\r${' '.repeat(100)}\r`);
    process.stdout.write(`${emoji} ${currentPosition.symbol} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(2)} SOL) | SL[${bar}]TP | ⏱️${mins}m`);
  }
}

// ============== SCANNER ==============

async function scanForEntry() {
  if (currentPosition) return;
  if (isScanning) return;

  isScanning = true;
  const scanStart = Date.now();

  try {
    // Get tokens from multiple sources in parallel
    const [profiles, searchTokens, gainers, newPairs, trending, boosted, geckoNew, geckoTrend] = await Promise.all([
      getLatestProfiles(),
      getSearchTokens(),
      getGainers(),
      getNewPairs(),
      getTrendingTokens(),
      getBoostedTokens(),
      getGeckoNewPools(),    // FRESH tokens from GeckoTerminal!
      getGeckoTrending(),    // Trending from GeckoTerminal
    ]);

    // Combine and deduplicate, tracking sources
    // PRIORITY ORDER: Fresh pump.fun tokens FIRST, then other sources
    const tokenMap = new Map();

    // 1. PUMP_FUN tokens first (freshest, highest priority)
    for (const t of geckoNew) {
      if (t.source === 'PUMP_FUN' && t.address && !tokenMap.has(t.address)) {
        tokenMap.set(t.address, new Set());
      }
      if (t.source === 'PUMP_FUN' && t.address) tokenMap.get(t.address)?.add('PUMP_FUN');
    }
    // 2. Other GECKO_NEW tokens (fresh but not pump.fun)
    for (const t of geckoNew) {
      if (t.source === 'GECKO_NEW' && t.address && !tokenMap.has(t.address)) {
        tokenMap.set(t.address, new Set());
      }
      if (t.source === 'GECKO_NEW' && t.address) tokenMap.get(t.address)?.add('GECKO_NEW');
    }
    // 3. Gecko trending
    for (const t of geckoTrend) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('GECKO_TREND');
    }
    // 4. DexScreener sources (lower priority - often stale)
    for (const t of profiles) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('PROFILE');
    }
    for (const t of searchTokens) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('SEARCH');
    }
    for (const t of gainers) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('GAINER');
    }
    for (const t of newPairs) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('NEW');
    }
    for (const t of trending) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('TREND');
    }
    for (const t of boosted) {
      if (t.address && !tokenMap.has(t.address)) tokenMap.set(t.address, new Set());
      if (t.address) tokenMap.get(t.address).add('BOOST');
    }

    // Count new vs seen tokens
    let newTokenCount = 0;
    for (const [address] of tokenMap) {
      if (!seenTokens.has(address)) newTokenCount++;
    }

    const allTokens = [...tokenMap.entries()].slice(0, 40);

    if (allTokens.length === 0) {
      log('⚠️ No tokens found from API');
      isScanning = false;
      return;
    }

    // Count pump.fun vs other gecko tokens
    const pumpFunCount = geckoNew.filter(t => t.source === 'PUMP_FUN').length;
    const otherGeckoCount = geckoNew.filter(t => t.source === 'GECKO_NEW').length;

    if (VERBOSE) {
      console.log('\n' + '─'.repeat(115));
      log(`🔍 SCANNING ${allTokens.length} tokens (${newTokenCount} new) | dex:${profiles.length + searchTokens.length + gainers.length + newPairs.length + trending.length + boosted.length} | 🎰pump.fun:${pumpFunCount} | 🦎gecko:${otherGeckoCount + geckoTrend.length}`);
      console.log('─'.repeat(115));
    }

    let checked = 0;
    let bestCandidate = null;
    let bestScore = 0;

    for (const [address, sources] of allTokens) {
      if (currentPosition) break;

      // Check cooldown FIRST
      if (isOnCooldown(address)) {
        const cdInfo = getCooldownInfo(address);
        if (VERBOSE) {
          const mins = (cdInfo.remaining / 60000).toFixed(1);
          console.log(`⏸️ COOLDOWN  | ${address.slice(0, 8)}... | ${mins}m remaining ${cdInfo.wasProfit ? '(profit exit)' : ''}`);
        }
        continue;
      }

      const token = await getTokenData(address);
      if (!token) continue;
      checked++;

      // Mark as seen
      seenTokens.add(address);

      const sourceList = [...sources];
      const signalCount = sourceList.length + (token.priceChange1h > 50 ? 1 : 0);
      const signalList = [...sourceList];
      if (token.priceChange1h > 50) signalList.push('1H+50%');

      const strongPump = token.priceChange5m >= 8;
      if (strongPump && !signalList.includes('PUMP5M')) signalList.push('PUMP5M');
      const effectiveSignals = signalCount + (strongPump ? 1 : 0);

      // For fresh tokens (GECKO_NEW or PUMP_FUN), relax some filters
      const isGeckoFresh = sources.has('GECKO_NEW');
      const isPumpFun = sources.has('PUMP_FUN');
      const isFreshSource = isGeckoFresh || isPumpFun;

      // Lower liquidity requirement for pump.fun tokens (they start small)
      const minLiquidity = isPumpFun ? 2000 : CONFIG.MIN_LIQUIDITY;

      const checks = {
        hasSignals: effectiveSignals >= CONFIG.MIN_SIGNALS,
        goodRatio: token.buySellRatio >= CONFIG.MIN_BUY_SELL_RATIO,
        isPumping: token.priceChange5m >= CONFIG.MIN_5M_CHANGE,
        notTopped: isFreshSource ? true : token.priceChange5m <= CONFIG.MAX_5M_CHANGE,  // Skip for fresh tokens
        hasLiquidity: token.liquidity >= minLiquidity,
        isFresh: token.ageHours <= CONFIG.MAX_AGE_HOURS,
        notDumping: token.priceChange5m > -5,
      };

      const pass = Object.values(checks).every(v => v);

      if (VERBOSE) {
        const signals = signalList.join('+') || 'none';
        const passIcon = pass ? '✅' : '❌';
        const fails = [];
        if (!checks.hasSignals) fails.push(`sig:${effectiveSignals}<1`);
        if (!checks.goodRatio) fails.push(`ratio:${token.buySellRatio.toFixed(1)}<1.0`);
        if (!checks.isPumping) fails.push(`5m:${token.priceChange5m.toFixed(1)}%<5%`);
        if (!checks.notTopped) fails.push(`TOPPED:${token.priceChange5m.toFixed(0)}%>40%`);
        // Note: GECKO_NEW tokens bypass the topped check
        if (!checks.hasLiquidity) fails.push(`liq:$${(token.liquidity/1000).toFixed(0)}K<$${minLiquidity/1000}K`);
        if (!checks.isFresh) fails.push(`OLD:${token.ageHours.toFixed(1)}h>4h`);
        if (!checks.notDumping) fails.push(`dump:${token.priceChange5m.toFixed(1)}%`);

        const ageStr = token.ageHours < 1 ? `${(token.ageHours * 60).toFixed(0)}m` : `${token.ageHours.toFixed(1)}h`;
        const failStr = fails.length > 0 ? ` [${fails.join(', ')}]` : '';
        const trendIcon = token.priceChange1h > 50 ? '🔥' : token.priceChange5m >= 10 ? '🚀' : token.priceChange5m >= 5 ? '📈' : '➡️';
        const newIcon = !seenTokens.has(address) ? '🆕' : '  ';
        console.log(`${passIcon} ${token.symbol.padEnd(10)} | ${signals.padEnd(20)} | Age:${ageStr.padStart(4)} | 5m:${(token.priceChange5m >= 0 ? '+' : '') + token.priceChange5m.toFixed(0).padStart(3)}% ${trendIcon} | Liq:$${(token.liquidity/1000).toFixed(0)}K | Ratio:${token.buySellRatio.toFixed(1)}${failStr}`);
      }

      // Track best near-miss
      if (!pass && effectiveSignals >= 1) {
        const score = effectiveSignals + (token.buySellRatio / 2) + (token.priceChange5m / 10);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = { token, signalList, checks };
        }
      }

      if (pass) {
        console.log('');
        log(`✨ ENTRY SIGNAL: ${token.symbol} (${signalList.join('+')})`);
        executeBuy(token);
        break;
      }
    }

    const scanTime = Date.now() - scanStart;
    if (!currentPosition) {
      console.log('─'.repeat(115));
      log(`📊 Scanned ${checked} tokens in ${scanTime}ms - No entry found`);
      log(`💰 Session: ${stats.trades} trades | ${stats.wins}W/${stats.losses}L | P&L: ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} SOL`);
      log(`🔄 Tracking ${seenTokens.size} unique tokens | ${tokenCooldowns.size} on cooldown`);
      if (bestCandidate && VERBOSE) {
        const bc = bestCandidate;
        log(`💡 Closest: ${bc.token.symbol} (${bc.signalList.join('+')} | 5m: ${bc.token.priceChange5m.toFixed(1)}% | ratio: ${bc.token.buySellRatio.toFixed(2)})`);
      }
      console.log(`⏳ Next scan in ${CONFIG.SCAN_INTERVAL_MS / 1000}s...`);
    }

  } catch (err) {
    log(`Scan error: ${err.message}`);
  }

  isScanning = false;
}

// ============== MAIN LOOP ==============

async function startScalper() {
  const modeStr = LIVE_MODE ? '🔴 LIVE TRADING' : '📝 PAPER TRADING';

  console.log('\n' + '═'.repeat(70));
  console.log(`⚡ MOMENTUM SCALPER v3 - ${modeStr}`);
  console.log('═'.repeat(70));
  if (LIVE_MODE) {
    console.log('⚠️  WARNING: LIVE MODE - Real money at risk!');
    console.log('═'.repeat(70));
  }
  console.log(`📊 Entry Rules:`);
  console.log(`   • 5m change: +${CONFIG.MIN_5M_CHANGE}% to +${CONFIG.MAX_5M_CHANGE}% (avoid buying tops!)`);
  console.log(`   • Liquidity: $${CONFIG.MIN_LIQUIDITY/1000}K+ | Max age: ${CONFIG.MAX_AGE_HOURS}h`);
  console.log(`   • Cooldown: ${CONFIG.COOLDOWN_MINUTES}min (${CONFIG.PROFIT_COOLDOWN_MINUTES}min after profit)`);
  console.log('');
  console.log(`🎯 Exit Rules:`);
  console.log(`   • Take Profit: +${CONFIG.TAKE_PROFIT_PERCENT}% (quick scalp)`);
  console.log(`   • Stop Loss: ${CONFIG.STOP_LOSS_PERCENT}%`);
  console.log(`   • Timeout: ${CONFIG.MAX_HOLD_MINUTES}min`);
  console.log('');
  console.log(`💰 Position: ${CONFIG.POSITION_SIZE_SOL} SOL per trade`);
  console.log(`⏱️  Speed: Scan/${CONFIG.SCAN_INTERVAL_MS/1000}s | Monitor/${CONFIG.MONITOR_INTERVAL_MS/1000}s`);
  console.log('═'.repeat(70) + '\n');

  log('🚀 Starting scalper...');

  // Initial scan
  await scanForEntry();

  // Scan loop
  setInterval(async () => {
    if (!currentPosition) {
      await scanForEntry();
    }
  }, CONFIG.SCAN_INTERVAL_MS);

  // Monitor loop
  setInterval(async () => {
    if (currentPosition) {
      await monitorPosition();
    }
  }, CONFIG.MONITOR_INTERVAL_MS);

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    printStats();
    log(`📊 Tracked ${seenTokens.size} unique tokens this session`);

    if (currentPosition) {
      log(`⚠️ Open position: ${currentPosition.symbol}`);
    }

    process.exit(0);
  });
}

// Start
startScalper();
