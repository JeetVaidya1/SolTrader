#!/usr/bin/env node
// 24/7 monitoring script - Token screening and Claude decision triggers
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { validateConfig } = require('./config');
const state = require('./state');
const screener = require('./screener');
const executor = require('./executor');

// Advanced signal modules
const whaleTracker = require('./whale-tracker');
const socialSignals = require('./social-signals');
const volumeDetector = require('./volume-detector');
const newLaunches = require('./new-launches');

// Parse command line arguments
const args = process.argv.slice(2);
const liveMode = args.includes('--live');
const paperMode = !liveMode; // Default to paper mode

// Global state
let isRunning = false;
let lastScanTime = null;
let scanCount = 0;

if (liveMode) {
  console.log('\n⚠️  WARNING: LIVE TRADING MODE ⚠️');
  console.log('This will execute real trades with real money.');
  console.log('Press Ctrl+C within 5 seconds to cancel...\n');

  setTimeout(() => {
    console.log('Starting live trading...\n');
    startMonitor();
  }, 5000);
} else {
  console.log('\n📝 PAPER TRADING MODE');
  console.log('No real trades will be executed.\n');
  startMonitor();
}

// Print status header
function printStatus() {
  const stateData = state.readState();
  const positions = stateData.positions?.length || 0;
  const pnl = stateData.pnl || { today: 0, total: 0 };

  console.log('\n' + '='.repeat(60));
  console.log(`📊 Solana Memecoin Trader - ${paperMode ? 'PAPER' : 'LIVE'} MODE`);
  console.log('='.repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Scan #${scanCount} | Last scan: ${lastScanTime || 'Never'}`);
  console.log(`Positions: ${positions}/${config.risk.maxConcurrentPositions}`);
  console.log(`P&L Today: ${pnl.today >= 0 ? '+' : ''}${pnl.today.toFixed(4)} SOL`);
  console.log(`P&L Total: ${pnl.total >= 0 ? '+' : ''}${pnl.total.toFixed(4)} SOL`);

  if (stateData.isPaused) {
    console.log(`\n🛑 TRADING PAUSED: ${stateData.pauseReason}`);
  }

  console.log('='.repeat(60) + '\n');
}

// Build prompt for Claude entry decision
function buildEntryPrompt(tokenData, portfolioState, additionalSignals = {}) {
  const strategyPath = path.resolve(config.paths.strategyFile);
  let strategy = '';

  try {
    strategy = fs.readFileSync(strategyPath, 'utf8');
  } catch (err) {
    strategy = 'Use conservative trading approach. Focus on risk management.';
  }

  // Build signal context
  let signalContext = '';

  if (additionalSignals.whaleActivity) {
    signalContext += `\n## Whale Activity Signal
${JSON.stringify(additionalSignals.whaleActivity, null, 2)}
NOTE: Whales recently bought this token - consider this a STRONG bullish indicator.`;
  }

  if (additionalSignals.viralSignal) {
    signalContext += `\n## Social/Viral Signal
Viral Score: ${additionalSignals.viralSignal.viralScore}
Reason: ${additionalSignals.viralSignal.reason}
NOTE: This token is showing viral/social momentum.`;
  }

  if (additionalSignals.volumeSpike) {
    signalContext += `\n## Volume Spike Signal
Volume Spike: ${additionalSignals.volumeSpike.volumeSpike?.toFixed(1)}x
Activity Spike: ${additionalSignals.volumeSpike.activitySpike?.toFixed(1)}x
Buy/Sell Ratio: ${additionalSignals.volumeSpike.buySellRatio?.toFixed(2)}
Reason: ${additionalSignals.volumeSpike.spikeReason}
NOTE: Unusual volume detected - potential breakout incoming.`;
  }

  if (additionalSignals.freshLaunch) {
    signalContext += `\n## Fresh Launch Signal
Age: ${additionalSignals.freshLaunch.ageMinutes} minutes old
Source: ${additionalSignals.freshLaunch.source}
NOTE: This is a VERY NEW token - higher risk but potential for early gains. Check liquidity and activity carefully.`;
  }

  return `
You are a memecoin trading analyst. Analyze this token for a potential BUY.

## Your Trading Strategy
${strategy}

## Current Portfolio State
${JSON.stringify(portfolioState, null, 2)}

## Token Data
${JSON.stringify(tokenData, null, 2)}
${signalContext}

## Task: EVALUATE FOR ENTRY

Consider any whale activity, viral signals, or volume spikes as ADDITIONAL bullish indicators.
These signals suggest smart money interest or growing momentum.

Respond with ONLY valid JSON:
{
  "action": "BUY" or "SKIP",
  "confidence": 0-100,
  "positionSizeSol": number (how much SOL to spend, max ${config.risk.maxPositionSize}),
  "reasoning": "brief explanation",
  "riskAssessment": "Low|Medium|High - explanation"
}
`;
}

// Build prompt for Claude exit decision
function buildExitPrompt(position, tokenData, portfolioState) {
  const strategyPath = path.resolve(config.paths.strategyFile);
  let strategy = '';

  try {
    strategy = fs.readFileSync(strategyPath, 'utf8');
  } catch (err) {
    strategy = 'Use conservative trading approach. Focus on risk management.';
  }

  const pnlPercent = ((tokenData.priceUsd - position.entryPrice) / position.entryPrice) * 100;

  return `
You are a memecoin trading analyst. Evaluate if we should EXIT this position.

## Your Trading Strategy
${strategy}

## Current Position
- Token: ${position.tokenSymbol}
- Entry Price: $${position.entryPrice}
- Current Price: $${tokenData.priceUsd}
- P&L: ${pnlPercent.toFixed(1)}%
- Holding Since: ${position.entryTime}
- SOL Invested: ${position.solSpent}

## Current Token Data
${JSON.stringify(tokenData, null, 2)}

## Portfolio State
${JSON.stringify(portfolioState, null, 2)}

## Task: EVALUATE FOR EXIT

Respond with ONLY valid JSON:
{
  "action": "SELL" or "HOLD",
  "sellPercent": 100 (percentage of position to sell, if SELL),
  "confidence": 0-100,
  "reasoning": "brief explanation"
}
`;
}

// Evaluate positions for exits
async function evaluatePositions(tokenDataMap) {
  const positions = state.getPositions();
  const results = [];

  for (const position of positions) {
    const tokenData = tokenDataMap[position.tokenAddress];
    if (!tokenData) continue;

    const currentPrice = tokenData.priceUsd;

    // Update position with current price
    state.updatePositionPrice(position.tokenAddress, currentPrice);

    // Check mechanical exits first (stop loss, take profit, trailing stop, dead token)
    const exitCheck = executor.checkMechanicalExits(position, currentPrice);

    if (exitCheck.shouldExit) {
      console.log(`  🔧 Mechanical exit: ${exitCheck.reason} - ${exitCheck.detail}`);

      const result = await executor.executeSell(
        position.tokenAddress,
        exitCheck.exitPercent,
        paperMode
      );

      if (result.success) {
        // Update state
        if (exitCheck.exitPercent === 100) {
          state.closePosition(position.tokenAddress, currentPrice, position.solSpent * (1 + (currentPrice - position.entryPrice) / position.entryPrice));
        } else {
          // Partial exit - update takeProfitHit
          if (exitCheck.tpLevel) {
            const updatedPosition = state.getPosition(position.tokenAddress);
            updatedPosition.takeProfitHit = updatedPosition.takeProfitHit || [];
            updatedPosition.takeProfitHit.push(exitCheck.tpLevel);
            state.writeState(state.readState());
          }
        }

        results.push({
          type: exitCheck.reason,
          tokenSymbol: position.tokenSymbol,
          success: true,
          txHash: result.txHash,
        });
      }

      continue;
    }

    // Update highest price for trailing stop
    if (!position.highestPrice || currentPrice > position.highestPrice) {
      position.highestPrice = currentPrice;
    }

    // No mechanical exit - ask Claude if we should exit
    const portfolioState = state.getStateSummary();
    const prompt = buildExitPrompt(position, tokenData, portfolioState);

    try {
      const decision = executor.callClaudeForDecision(prompt, paperMode);

      if (decision.action === 'SELL') {
        console.log(`  🧠 Claude says SELL ${position.tokenSymbol}: ${decision.reasoning}`);

        const result = await executor.executeSell(
          position.tokenAddress,
          decision.sellPercent || 100,
          paperMode
        );

        if (result.success && decision.sellPercent === 100) {
          const pnlMultiplier = (currentPrice - position.entryPrice) / position.entryPrice;
          state.closePosition(position.tokenAddress, currentPrice, position.solSpent * (1 + pnlMultiplier));
        }

        results.push({
          type: 'claude_decision',
          tokenSymbol: position.tokenSymbol,
          success: result.success,
        });
      } else {
        results.push({
          type: 'hold',
          tokenSymbol: position.tokenSymbol,
        });
      }
    } catch (err) {
      console.error(`  Error evaluating ${position.tokenSymbol}:`, err.message);
    }
  }

  return results;
}

// Evaluate token for entry
async function evaluateForEntry(tokenData, additionalSignals = {}) {
  // Check if we already have a position
  if (state.getPosition(tokenData.address)) {
    console.log(`  Already have position in ${tokenData.symbol}`);
    return null;
  }

  // Check if we can open a position
  const canOpen = state.canOpenPosition();
  if (!canOpen.allowed) {
    console.log(`  Cannot open position: ${canOpen.reason}`);
    return null;
  }

  const portfolioState = state.getStateSummary();
  const prompt = buildEntryPrompt(tokenData, portfolioState, additionalSignals);

  try {
    const decision = executor.callClaudeForDecision(prompt, paperMode);

    console.log(`  🧠 Claude decision: ${decision.action} (confidence: ${decision.confidence}%)`);
    console.log(`     Reasoning: ${decision.reasoning}`);

    if (decision.action === 'BUY' && decision.confidence >= 50) {
      const positionSize = Math.min(decision.positionSizeSol || 1, config.risk.maxPositionSize);

      const result = await executor.executeBuy(
        tokenData.address,
        positionSize,
        paperMode
      );

      if (result.success) {
        // Record position in state
        state.addPosition({
          tokenAddress: tokenData.address,
          tokenSymbol: tokenData.symbol,
          tokenName: tokenData.name,
          entryPrice: tokenData.priceUsd,
          amount: positionSize * 1e9 / tokenData.priceUsd, // Approximate token amount
          solSpent: positionSize,
        });

        return { success: true, action: 'BUY', txHash: result.txHash };
      }
    }

    return { success: true, action: decision.action };
  } catch (err) {
    console.error(`  Error evaluating ${tokenData.symbol}:`, err.message);
    return null;
  }
}

// Main scan cycle
async function runScanCycle() {
  if (isRunning) {
    console.log('Previous scan still running, skipping...');
    return;
  }

  isRunning = true;
  scanCount++;
  lastScanTime = new Date().toISOString();

  try {
    printStatus();

    // Check if trading is paused
    const stateData = state.readState();
    if (stateData.isPaused) {
      console.log('Trading is paused. Skipping scan.');
      isRunning = false;
      return;
    }

    // Step 1: Gather signals from multiple sources
    console.log('🔍 Gathering signals from multiple sources...');

    // Regular market screening
    console.log('  📊 Screening market...');
    const marketCandidates = await screener.screenMarket();
    console.log(`  Found ${marketCandidates.length} market candidates`);

    // Whale activity tracking
    console.log('  🐋 Checking whale activity...');
    let whaleBuys = [];
    try {
      whaleBuys = await whaleTracker.getRecentWhaleBuys(30);
      console.log(`  Found ${whaleBuys.length} recent whale buys`);
    } catch (err) {
      console.log(`  Whale tracking unavailable: ${err.message}`);
    }

    // Social/viral signals
    console.log('  📱 Detecting viral tokens...');
    let viralTokens = [];
    try {
      viralTokens = await socialSignals.detectViralTokens();
      console.log(`  Found ${viralTokens.length} viral tokens`);
    } catch (err) {
      console.log(`  Social signals unavailable: ${err.message}`);
    }

    // Volume spike detection
    console.log('  📈 Detecting volume spikes...');
    let volumeSpikes = [];
    try {
      volumeSpikes = await volumeDetector.detectVolumeSpikes(3);
      console.log(`  Found ${volumeSpikes.length} volume spikes`);
    } catch (err) {
      console.log(`  Volume detection unavailable: ${err.message}`);
    }

    // New launches detection (freshest tokens)
    console.log('  🆕 Scanning for new launches...');
    let freshLaunches = [];
    try {
      freshLaunches = await newLaunches.detectNewLaunches();
      console.log(`  Found ${freshLaunches.length} fresh launches`);
    } catch (err) {
      console.log(`  New launch detection unavailable: ${err.message}`);
    }

    // Step 2: Combine and dedupe all signals
    const signalMap = {}; // Maps token address -> signal data

    // Add market candidates
    for (const candidate of marketCandidates) {
      if (candidate.address) {
        signalMap[candidate.address] = {
          tokenData: candidate,
          signals: { source: 'market_scan' },
        };
      }
    }

    // Add whale buy signals
    for (const whaleBuy of whaleBuys) {
      if (whaleBuy.tokenAddress) {
        if (signalMap[whaleBuy.tokenAddress]) {
          signalMap[whaleBuy.tokenAddress].signals.whaleActivity = {
            whaleName: whaleBuy.whaleName,
            type: whaleBuy.type,
            timestamp: whaleBuy.timestamp,
          };
        } else {
          // Fetch token data for whale buy
          const tokenData = await screener.screenToken(whaleBuy.tokenAddress);
          if (tokenData) {
            signalMap[whaleBuy.tokenAddress] = {
              tokenData,
              signals: {
                source: 'whale_copy',
                whaleActivity: {
                  whaleName: whaleBuy.whaleName,
                  type: whaleBuy.type,
                  timestamp: whaleBuy.timestamp,
                },
              },
            };
          }
        }
      }
    }

    // Add viral signals - ONLY screen top 8 by viral score (efficiency)
    const topViral = viralTokens
      .filter(v => v.address && !signalMap[v.address])
      .sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0))
      .slice(0, 8);

    for (const viral of viralTokens) {
      if (viral.address) {
        if (signalMap[viral.address]) {
          // Just add signal to existing entry
          signalMap[viral.address].signals.viralSignal = {
            viralScore: viral.viralScore,
            reason: viral.reason,
          };
        } else if (topViral.find(v => v.address === viral.address)) {
          // Only screen top viral tokens
          const tokenData = await screener.screenToken(viral.address);
          if (tokenData) {
            signalMap[viral.address] = {
              tokenData,
              signals: {
                source: 'viral_detection',
                viralSignal: {
                  viralScore: viral.viralScore,
                  reason: viral.reason,
                },
              },
            };
          }
        }
      }
    }

    // Add volume spike signals
    for (const spike of volumeSpikes) {
      if (spike.address) {
        if (signalMap[spike.address]) {
          signalMap[spike.address].signals.volumeSpike = {
            volumeSpike: spike.volumeSpike,
            activitySpike: spike.activitySpike,
            buySellRatio: spike.buySellRatio,
            spikeReason: spike.spikeReason,
          };
        } else {
          // Fetch token data for volume spike
          const tokenData = await screener.screenToken(spike.address);
          if (tokenData) {
            signalMap[spike.address] = {
              tokenData,
              signals: {
                source: 'volume_spike',
                volumeSpike: {
                  volumeSpike: spike.volumeSpike,
                  activitySpike: spike.activitySpike,
                  buySellRatio: spike.buySellRatio,
                  spikeReason: spike.spikeReason,
                },
              },
            };
          }
        }
      }
    }

    // Add fresh launch signals - ONLY screen top 10 newest (efficiency)
    const topFresh = freshLaunches
      .filter(l => l.address && !signalMap[l.address])
      .sort((a, b) => (a.ageHours || 99) - (b.ageHours || 99)) // Newest first
      .slice(0, 10);

    for (const launch of freshLaunches) {
      if (launch.address) {
        if (signalMap[launch.address]) {
          // Just add signal to existing entry
          signalMap[launch.address].signals.freshLaunch = {
            ageMinutes: Math.round((launch.ageHours || 0) * 60),
            source: launch.source,
          };
        } else if (topFresh.find(l => l.address === launch.address)) {
          // Only screen top fresh launches
          const tokenData = await screener.screenToken(launch.address);
          if (tokenData) {
            signalMap[launch.address] = {
              tokenData,
              signals: {
                source: 'fresh_launch',
                freshLaunch: {
                  ageMinutes: Math.round((launch.ageHours || 0) * 60),
                  source: launch.source,
                },
              },
            };
          }
        }
      }
    }

    // Convert to array of candidates with signals
    const candidates = Object.entries(signalMap)
      .map(([address, data]) => ({
        ...data.tokenData,
        additionalSignals: data.signals,
        signalCount: Object.keys(data.signals).filter(k => k !== 'source').length,
      }))
      .filter(c => c && c.address);

    if (candidates.length === 0) {
      console.log('No candidates found this scan.');
      isRunning = false;
      return;
    }

    console.log(`\nTotal ${candidates.length} unique candidates from all sources.`);
    console.log(`  - With whale signals: ${candidates.filter(c => c.additionalSignals?.whaleActivity).length}`);
    console.log(`  - With viral signals: ${candidates.filter(c => c.additionalSignals?.viralSignal).length}`);
    console.log(`  - With volume spikes: ${candidates.filter(c => c.additionalSignals?.volumeSpike).length}`);
    console.log(`  - Fresh launches (<4h): ${candidates.filter(c => c.additionalSignals?.freshLaunch).length}`);

    // Step 2: Build token data map
    const tokenDataMap = {};
    for (const candidate of candidates) {
      tokenDataMap[candidate.address] = candidate;
    }

    // Fetch data for positions not in candidates
    const positionAddresses = state.getPositions().map(p => p.tokenAddress);
    for (const addr of positionAddresses) {
      if (!tokenDataMap[addr]) {
        const tokenData = await screener.screenToken(addr);
        if (tokenData) {
          tokenDataMap[addr] = tokenData;
        }
      }
    }

    // Step 3: Evaluate current positions first
    console.log('\n📈 Evaluating current positions...');
    const exitResults = await evaluatePositions(tokenDataMap);

    for (const result of exitResults) {
      if (result.type === 'stop_loss') {
        console.log(`  🛑 Stop loss: ${result.tokenSymbol}`);
      } else if (result.type === 'take_profit') {
        console.log(`  💰 Take profit: ${result.tokenSymbol}`);
      } else if (result.type === 'trailing_stop') {
        console.log(`  📉 Trailing stop: ${result.tokenSymbol}`);
      } else if (result.type === 'dead_token') {
        console.log(`  💀 Dead token exit: ${result.tokenSymbol}`);
      } else if (result.type === 'claude_decision') {
        console.log(`  🧠 Claude exit: ${result.tokenSymbol}`);
      }
    }

    // Step 4: Evaluate new entry opportunities
    console.log('\n🎯 Evaluating entry opportunities...');

    // Sort candidates by potential - prioritize tokens with multiple signals
    // ACCUMULATION STRATEGY: Require 2+ signals for higher win rate
    const sortedCandidates = candidates
      .filter(c => {
        // Must pass risk check
        if (c.riskScore > 3) return false;

        // Count signals (excluding 'source' key)
        const signalKeys = Object.keys(c.additionalSignals || {}).filter(k => k !== 'source');
        const signalCount = signalKeys.length;

        // PROFIT MODE: Balanced requirements (not too strict, not too loose)

        // Must have 2+ signals (no more "fresh launch alone" entries)
        if (signalCount < 2) {
          return false;
        }

        // Require decent buy/sell ratio
        if ((c.buySellRatio || 0) < 1.25) return false;

        // Require positive momentum (5m OR 1h must be positive)
        const priceChange5m = c.priceChange5m || 0;
        const priceChange1h = c.priceChange1h || 0;
        if (priceChange5m < -5 && priceChange1h < 0) {
          return false; // Skip if BOTH are negative/weak
        }

        // Skip tokens that already pumped too much (>800% in 24h = likely to dump)
        const priceChange24h = c.priceChange24h || 0;
        if (priceChange24h > 800) {
          return false;
        }

        // Require minimum liquidity (avoid traps)
        if ((c.liquidity || 0) < 10000) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Signal bonus: each signal type adds significant weight
        const signalBonusA = (a.signalCount || 0) * 30;
        const signalBonusB = (b.signalCount || 0) * 30;

        // Extra bonus for whale activity
        const whaleBonusA = a.additionalSignals?.whaleActivity ? 50 : 0;
        const whaleBonusB = b.additionalSignals?.whaleActivity ? 50 : 0;

        // Viral score bonus
        const viralBonusA = (a.additionalSignals?.viralSignal?.viralScore || 0) * 0.5;
        const viralBonusB = (b.additionalSignals?.viralSignal?.viralScore || 0) * 0.5;

        // Volume spike bonus
        const volumeBonusA = a.additionalSignals?.volumeSpike ?
          Math.min((a.additionalSignals.volumeSpike.volumeSpike || 1) * 10, 40) : 0;
        const volumeBonusB = b.additionalSignals?.volumeSpike ?
          Math.min((b.additionalSignals.volumeSpike.volumeSpike || 1) * 10, 40) : 0;

        // Fresh launch bonus - newer is better (max 60 points for <30min old)
        const freshBonusA = a.additionalSignals?.freshLaunch ?
          Math.max(60 - (a.additionalSignals.freshLaunch.ageMinutes || 60), 0) : 0;
        const freshBonusB = b.additionalSignals?.freshLaunch ?
          Math.max(60 - (b.additionalSignals.freshLaunch.ageMinutes || 60), 0) : 0;

        const scoreA = signalBonusA + whaleBonusA + viralBonusA + volumeBonusA + freshBonusA +
          (a.momentum || 0) + ((a.buySellRatio || 1) * 10) - (a.riskScore * 15);
        const scoreB = signalBonusB + whaleBonusB + viralBonusB + volumeBonusB + freshBonusB +
          (b.momentum || 0) + ((b.buySellRatio || 1) * 10) - (b.riskScore * 15);
        return scoreB - scoreA;
      });

    console.log(`${sortedCandidates.length} candidates pass PROFIT filter (2+ signals, buy/sell >1.25, momentum OK, >$10K liq).`);

    // Evaluate top 5 candidates (increased from 3 to catch more signal-rich opportunities)
    for (const candidate of sortedCandidates.slice(0, 5)) {
      const canOpen = state.canOpenPosition();
      if (!canOpen.allowed) {
        console.log(`Cannot open more positions: ${canOpen.reason}`);
        break;
      }

      console.log(`\n📋 Evaluating ${candidate.symbol}...`);
      console.log(`   Price: $${candidate.priceUsd?.toFixed(8)}`);
      console.log(`   24h Change: ${candidate.priceChange24h?.toFixed(1)}%`);
      console.log(`   Liquidity: $${((candidate.liquidity || 0) / 1000).toFixed(0)}K`);
      console.log(`   Holders: ${candidate.totalHolders || 'N/A'}`);
      console.log(`   Risk Flags: ${candidate.riskFlags?.length > 0 ? candidate.riskFlags.join(', ') : 'None'}`);

      // Display signal information
      if (candidate.additionalSignals?.freshLaunch) {
        console.log(`   🆕 FRESH LAUNCH: ${candidate.additionalSignals.freshLaunch.ageMinutes} minutes old`);
      }
      if (candidate.additionalSignals?.whaleActivity) {
        console.log(`   🐋 WHALE SIGNAL: ${candidate.additionalSignals.whaleActivity.whaleName} bought recently`);
      }
      if (candidate.additionalSignals?.viralSignal) {
        console.log(`   📱 VIRAL SIGNAL: Score ${candidate.additionalSignals.viralSignal.viralScore} - ${candidate.additionalSignals.viralSignal.reason}`);
      }
      if (candidate.additionalSignals?.volumeSpike) {
        console.log(`   📈 VOLUME SPIKE: ${candidate.additionalSignals.volumeSpike.volumeSpike?.toFixed(1)}x - ${candidate.additionalSignals.volumeSpike.spikeReason}`);
      }

      const result = await evaluateForEntry(candidate, candidate.additionalSignals);

      if (result?.success && result.action === 'BUY') {
        console.log(`  ✅ Entered position in ${candidate.symbol}`);
      }

      // Delay between evaluations
      await new Promise(r => setTimeout(r, 2000));
    }

    printStatus();
  } catch (err) {
    console.error('Scan cycle error:', err);
  } finally {
    isRunning = false;
  }
}

// Position monitoring (runs every minute)
async function monitorPositions() {
  const positions = state.getPositions();

  if (positions.length === 0) {
    return;
  }

  console.log(`\n👁️ Monitoring ${positions.length} position(s)...`);

  for (const position of positions) {
    try {
      const currentPrice = await screener.getCurrentPrice(position.tokenAddress);

      if (currentPrice > 0) {
        state.updatePositionPrice(position.tokenAddress, currentPrice);

        const updated = state.getPosition(position.tokenAddress);
        const pnlPercent = updated?.unrealizedPnlPercent || 0;

        const indicator = pnlPercent >= 0 ? '📈' : '📉';
        console.log(
          `   ${indicator} ${position.tokenSymbol}: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}% ` +
          `($${currentPrice.toFixed(8)})`
        );

        // Check mechanical exits
        const exitCheck = executor.checkMechanicalExits(updated || position, currentPrice);

        if (exitCheck.shouldExit) {
          console.log(`   🔔 ${exitCheck.reason.toUpperCase()}: ${exitCheck.detail}`);

          const result = await executor.executeSell(
            position.tokenAddress,
            exitCheck.exitPercent,
            paperMode
          );

          if (result.success && exitCheck.exitPercent === 100) {
            const pnlMultiplier = (currentPrice - position.entryPrice) / position.entryPrice;
            state.closePosition(position.tokenAddress, currentPrice, position.solSpent * (1 + pnlMultiplier));
          }
        }
      }
    } catch (err) {
      console.error(`   Error monitoring ${position.tokenSymbol}:`, err.message);
    }

    await new Promise(r => setTimeout(r, 500));
  }
}

// Start the monitor
function startMonitor() {
  validateConfig();

  // Ensure data directory exists for cache files
  const dataDir = './data';
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  console.log('🚀 Starting Solana Memecoin Trader...');
  console.log(`   Mode: ${paperMode ? 'PAPER' : 'LIVE'}`);
  console.log(`   Scan interval: ${config.screening.intervalMinutes} minutes`);
  console.log(`   Max positions: ${config.risk.maxConcurrentPositions}`);
  console.log(`   Max position size: ${config.risk.maxPositionSize} SOL`);
  console.log(`   Stop loss: ${config.risk.stopLossPercent}%`);
  console.log(`   Take profit levels: ${config.risk.takeProfitLevels.map(t => `${t.percent}%`).join(', ')}`);

  // Display active signal sources
  console.log('\n📡 Signal Sources Active:');
  console.log('   ✓ DexScreener market screening');
  console.log('   ✓ Social sentiment & viral detection');
  console.log('   ✓ Volume spike detection');
  console.log('   ✓ New launches scanner (<4h old tokens)');

  const whaleWallets = whaleTracker.loadWhaleWallets();
  if (whaleWallets.length > 0) {
    console.log(`   ✓ Whale tracking (${whaleWallets.length} wallets)`);
  } else {
    console.log('   ○ Whale tracking (no wallets configured)');
  }

  // Run initial scan
  console.log('\n📡 Running initial scan...');
  runScanCycle();

  // Schedule regular scans
  const scanCron = `*/${config.screening.intervalMinutes} * * * *`;
  console.log(`\n⏰ Scheduling scans: ${scanCron}`);

  cron.schedule(scanCron, () => {
    runScanCycle();
  });

  // Monitor positions every minute
  cron.schedule('* * * * *', () => {
    monitorPositions();
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down...');
    printStatus();

    const positions = state.getPositions();
    if (positions.length > 0) {
      console.log('\n⚠️  You have open positions:');
      positions.forEach(p => {
        console.log(`   - ${p.tokenSymbol}: ${p.amount} tokens (${p.solSpent} SOL)`);
      });
      console.log('\nPositions will remain open. Manage them manually if needed.');
    }

    process.exit(0);
  });

  console.log('\n✅ Monitor started. Press Ctrl+C to stop.\n');
}
