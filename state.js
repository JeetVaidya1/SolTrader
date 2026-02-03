// State management - positions, P&L, trade history
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Ensure data directory exists
const dataDir = path.dirname(config.paths.stateFile);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Default state structure
const defaultState = {
  positions: [],
  pnl: {
    total: 0,
    today: 0,
    realized: 0,
    unrealized: 0,
  },
  dailyStats: {
    date: new Date().toISOString().split('T')[0],
    trades: 0,
    wins: 0,
    losses: 0,
  },
  lastUpdate: null,
  isPaused: false,
  pauseReason: null,
};

// Read state from file
function readState() {
  try {
    if (fs.existsSync(config.paths.stateFile)) {
      const data = fs.readFileSync(config.paths.stateFile, 'utf8');
      const state = JSON.parse(data);

      // Reset daily stats if new day
      const today = new Date().toISOString().split('T')[0];
      if (state.dailyStats?.date !== today) {
        state.dailyStats = {
          date: today,
          trades: 0,
          wins: 0,
          losses: 0,
        };
        state.pnl.today = 0;
      }

      return state;
    }
  } catch (err) {
    console.error('Error reading state:', err.message);
  }
  return { ...defaultState };
}

// Write state to file
function writeState(state) {
  try {
    state.lastUpdate = new Date().toISOString();
    fs.writeFileSync(config.paths.stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing state:', err.message);
    return false;
  }
}

// Read trade history
function readTradeHistory() {
  try {
    if (fs.existsSync(config.paths.tradeHistoryFile)) {
      const data = fs.readFileSync(config.paths.tradeHistoryFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading trade history:', err.message);
  }
  return { trades: [] };
}

// Write trade history
function writeTradeHistory(history) {
  try {
    fs.writeFileSync(config.paths.tradeHistoryFile, JSON.stringify(history, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing trade history:', err.message);
    return false;
  }
}

// Read decisions
function readDecisions() {
  try {
    if (fs.existsSync(config.paths.decisionsFile)) {
      const data = fs.readFileSync(config.paths.decisionsFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading decisions:', err.message);
  }
  return { pending: [], executed: [] };
}

// Write decisions
function writeDecisions(decisions) {
  try {
    fs.writeFileSync(config.paths.decisionsFile, JSON.stringify(decisions, null, 2));
    return true;
  } catch (err) {
    console.error('Error writing decisions:', err.message);
    return false;
  }
}

// Add a new position
function addPosition(position) {
  const state = readState();

  const newPosition = {
    id: `pos_${Date.now()}`,
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    tokenName: position.tokenName,
    entryPrice: position.entryPrice,
    amount: position.amount,
    solSpent: position.solSpent,
    entryTime: new Date().toISOString(),
    currentPrice: position.entryPrice,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
  };

  state.positions.push(newPosition);
  writeState(state);

  return newPosition;
}

// Update position with current price
function updatePositionPrice(tokenAddress, currentPrice) {
  const state = readState();
  const position = state.positions.find(p => p.tokenAddress === tokenAddress);

  if (position) {
    position.currentPrice = currentPrice;
    const currentValue = position.amount * currentPrice;
    const entryValue = position.amount * position.entryPrice;
    position.unrealizedPnl = currentValue - entryValue;
    position.unrealizedPnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // Update total unrealized P&L
    state.pnl.unrealized = state.positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    writeState(state);
  }

  return position;
}

// Close a position
function closePosition(tokenAddress, exitPrice, solReceived) {
  const state = readState();
  const positionIndex = state.positions.findIndex(p => p.tokenAddress === tokenAddress);

  if (positionIndex === -1) {
    return null;
  }

  const position = state.positions[positionIndex];
  const pnl = solReceived - position.solSpent;
  const pnlPercent = ((solReceived - position.solSpent) / position.solSpent) * 100;

  // Create trade record
  const trade = {
    id: `trade_${Date.now()}`,
    positionId: position.id,
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    tokenName: position.tokenName,
    entryPrice: position.entryPrice,
    exitPrice: exitPrice,
    amount: position.amount,
    solSpent: position.solSpent,
    solReceived: solReceived,
    pnl: pnl,
    pnlPercent: pnlPercent,
    entryTime: position.entryTime,
    exitTime: new Date().toISOString(),
    holdDurationMs: Date.now() - new Date(position.entryTime).getTime(),
  };

  // Update trade history
  const history = readTradeHistory();
  history.trades.push(trade);
  writeTradeHistory(history);

  // Remove position and update state
  state.positions.splice(positionIndex, 1);
  state.pnl.realized += pnl;
  state.pnl.total += pnl;
  state.pnl.today += pnl;
  state.dailyStats.trades += 1;

  if (pnl > 0) {
    state.dailyStats.wins += 1;
  } else {
    state.dailyStats.losses += 1;
  }

  // Recalculate unrealized P&L
  state.pnl.unrealized = state.positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

  // Check if daily loss limit exceeded
  if (state.pnl.today < -config.risk.maxLossPerDay) {
    state.isPaused = true;
    state.pauseReason = `Daily loss limit exceeded: ${state.pnl.today.toFixed(4)} SOL`;
    console.warn(`⚠️ TRADING PAUSED: ${state.pauseReason}`);
  }

  writeState(state);

  return trade;
}

// Get position by token address
function getPosition(tokenAddress) {
  const state = readState();
  return state.positions.find(p => p.tokenAddress === tokenAddress);
}

// Get all positions
function getPositions() {
  const state = readState();
  return state.positions;
}

// Check if we can open a new position
function canOpenPosition() {
  const state = readState();

  if (state.isPaused) {
    return { allowed: false, reason: state.pauseReason };
  }

  if (state.positions.length >= config.risk.maxConcurrentPositions) {
    return { allowed: false, reason: `Max concurrent positions (${config.risk.maxConcurrentPositions}) reached` };
  }

  if (state.pnl.today < -config.risk.maxLossPerDay) {
    return { allowed: false, reason: `Daily loss limit exceeded` };
  }

  return { allowed: true };
}

// Add a pending decision
function addDecision(decision) {
  const decisions = readDecisions();

  const newDecision = {
    id: `dec_${Date.now()}`,
    ...decision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  };

  decisions.pending.push(newDecision);
  writeDecisions(decisions);

  return newDecision;
}

// Mark decision as executed
function executeDecision(decisionId, result) {
  const decisions = readDecisions();
  const decisionIndex = decisions.pending.findIndex(d => d.id === decisionId);

  if (decisionIndex === -1) {
    return null;
  }

  const decision = decisions.pending[decisionIndex];
  decision.status = 'executed';
  decision.executedAt = new Date().toISOString();
  decision.result = result;

  decisions.pending.splice(decisionIndex, 1);
  decisions.executed.push(decision);

  // Keep only last 100 executed decisions
  if (decisions.executed.length > 100) {
    decisions.executed = decisions.executed.slice(-100);
  }

  writeDecisions(decisions);

  return decision;
}

// Get summary for Claude
function getStateSummary() {
  const state = readState();
  const history = readTradeHistory();

  // Get last 10 trades
  const recentTrades = history.trades.slice(-10);

  // Calculate win rate
  const totalTrades = history.trades.length;
  const winningTrades = history.trades.filter(t => t.pnl > 0).length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  return {
    currentPositions: state.positions,
    positionCount: state.positions.length,
    maxPositions: config.risk.maxConcurrentPositions,
    pnl: state.pnl,
    dailyStats: state.dailyStats,
    recentTrades: recentTrades,
    overallWinRate: winRate.toFixed(1) + '%',
    totalTradesAllTime: totalTrades,
    isPaused: state.isPaused,
    pauseReason: state.pauseReason,
    riskLimits: config.risk,
  };
}

// Pause trading
function pauseTrading(reason) {
  const state = readState();
  state.isPaused = true;
  state.pauseReason = reason;
  writeState(state);
}

// Resume trading
function resumeTrading() {
  const state = readState();
  state.isPaused = false;
  state.pauseReason = null;
  writeState(state);
}

module.exports = {
  readState,
  writeState,
  readTradeHistory,
  readDecisions,
  addPosition,
  updatePositionPrice,
  closePosition,
  getPosition,
  getPositions,
  canOpenPosition,
  addDecision,
  executeDecision,
  getStateSummary,
  pauseTrading,
  resumeTrading,
};
