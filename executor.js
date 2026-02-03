// executor.js — Trade execution via Jupiter API directly (no MCP needed)
// Claude Code is called ONLY for decisions, not for executing trades
const { execSync } = require("child_process");
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const axios = require("axios");
const fs = require("fs");
const config = require("./config");

// --- Solana setup ---

const connection = new Connection(config.rpcUrl, "confirmed");

function getWallet() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("WALLET_PRIVATE_KEY not set in .env");
  const decoded = bs58.default.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

// --- Jupiter API (direct, no MCP) ---

const JUPITER_API = "https://quote-api.jup.ag/v6";

async function getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps = 500) {
  try {
    const res = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps,
        onlyDirectRoutes: false,
      },
    });
    return res.data;
  } catch (err) {
    console.error("  Jupiter quote error:", err.response?.data || err.message);
    return null;
  }
}

async function buildJupiterSwap(quoteResponse, walletPublicKey) {
  try {
    const res = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse,
      userPublicKey: walletPublicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    });
    return res.data;
  } catch (err) {
    console.error("  Jupiter swap build error:", err.response?.data || err.message);
    return null;
  }
}

async function executeSwap(swapResponse, wallet) {
  try {
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([wallet]);

    // Send the transaction
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
    });

    // Confirm
    const confirmation = await connection.confirmTransaction(txid, "confirmed");

    if (confirmation.value.err) {
      console.error("  Transaction failed:", confirmation.value.err);
      return { success: false, error: JSON.stringify(confirmation.value.err) };
    }

    return { success: true, txHash: txid };
  } catch (err) {
    console.error("  Swap execution error:", err.message);
    return { success: false, error: err.message };
  }
}

// --- Get wallet SOL balance ---

async function getSOLBalance() {
  try {
    const wallet = getWallet();
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / 1e9; // Convert lamports to SOL
  } catch (err) {
    console.error("  Balance check error:", err.message);
    return 0;
  }
}

// --- Get token balance ---

async function getTokenBalance(tokenAddress) {
  try {
    const wallet = getWallet();
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new (require("@solana/web3.js").PublicKey)(tokenAddress),
    });

    if (accounts.value.length === 0) {
      return { amount: 0, rawAmount: "0", decimals: 0 };
    }

    const tokenAccount = accounts.value[0].account.data.parsed.info.tokenAmount;
    return {
      amount: tokenAccount.uiAmount,
      rawAmount: tokenAccount.amount,
      decimals: tokenAccount.decimals,
    };
  } catch (err) {
    console.error("  Token balance error:", err.message);
    return { amount: 0, rawAmount: "0", decimals: 0 };
  }
}

// --- Call Claude Code for a decision ---

function callClaudeForDecision(prompt, paperMode = false) {
  console.log("  🧠 Calling Claude Code for decision...");

  const tempFile = "/tmp/claude-prompt.txt";
  fs.writeFileSync(tempFile, prompt);

  try {
    const result = execSync(
      `cat ${tempFile} | claude --print`,
      {
        timeout: 120000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      }
    );

    // Log the decision
    const logDir = require("path").dirname(config.paths.claudeLog);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    fs.appendFileSync(
      config.paths.claudeLog,
      `\n${"=".repeat(60)}\n${new Date().toISOString()}\n${result}\n`
    );

    return parseClaudeResponse(result);
  } catch (err) {
    console.error("  ❌ Claude Code call failed:", err.message);
    return { action: "SKIP", reason: "Claude Code call failed" };
  }
}

function parseClaudeResponse(response) {
  try {
    // Try to find JSON in code block
    const jsonMatch = response.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    // Try to find raw JSON object
    const jsonStart = response.indexOf("{");
    const jsonEnd = response.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      return JSON.parse(response.substring(jsonStart, jsonEnd + 1));
    }

    return { action: "SKIP", reason: "Could not parse Claude response" };
  } catch (err) {
    return { action: "SKIP", reason: `Parse error: ${err.message}` };
  }
}

// --- Execute a buy ---

async function executeBuy(tokenAddress, amountSol, paperMode = false) {
  if (paperMode) {
    console.log(`  📝 [PAPER] Would buy ${amountSol} SOL of ${tokenAddress}`);
    return { success: true, paper: true, txHash: "paper-" + Date.now() };
  }

  console.log(`  💰 Executing buy: ${amountSol} SOL → ${tokenAddress}`);

  try {
    const wallet = getWallet();
    const amountLamports = Math.floor(amountSol * 1e9);

    // Step 1: Get quote (SOL → Token)
    console.log("  📊 Getting Jupiter quote...");
    const quote = await getJupiterQuote(
      config.tokens.SOL,
      tokenAddress,
      amountLamports
    );

    if (!quote) {
      return { success: false, error: "Could not get quote" };
    }

    console.log(`  📊 Quote received: ~${quote.outAmount} tokens`);

    // Step 2: Build swap transaction
    console.log("  🔨 Building swap transaction...");
    const swapData = await buildJupiterSwap(quote, wallet.publicKey);

    if (!swapData) {
      return { success: false, error: "Could not build swap" };
    }

    // Step 3: Sign and send
    console.log("  ✍️  Signing and sending...");
    const result = await executeSwap(swapData, wallet);

    if (result.success) {
      console.log(`  ✅ Buy successful! TX: ${result.txHash}`);
    }

    return result;
  } catch (err) {
    console.error("  ❌ Buy execution failed:", err.message);
    return { success: false, error: err.message };
  }
}

// --- Execute a sell ---

async function executeSell(tokenAddress, percentToSell, paperMode = false) {
  if (paperMode) {
    console.log(`  📝 [PAPER] Would sell ${percentToSell}% of ${tokenAddress}`);
    return { success: true, paper: true, txHash: "paper-" + Date.now() };
  }

  console.log(`  💰 Executing sell: ${percentToSell}% of ${tokenAddress} → SOL`);

  try {
    const wallet = getWallet();

    // Get current token balance
    const balance = await getTokenBalance(tokenAddress);

    if (!balance.rawAmount || balance.rawAmount === "0") {
      return { success: false, error: "No token balance found" };
    }

    // Calculate amount to sell
    const sellAmount = Math.floor(
      (BigInt(balance.rawAmount) * BigInt(percentToSell)) / BigInt(100)
    ).toString();

    if (sellAmount === "0") {
      return { success: false, error: "Sell amount too small" };
    }

    console.log(`  📊 Selling ${sellAmount} raw tokens (${percentToSell}% of ${balance.rawAmount})`);

    // Step 1: Get quote (Token → SOL)
    const quote = await getJupiterQuote(
      tokenAddress,
      config.tokens.SOL,
      parseInt(sellAmount)
    );

    if (!quote) {
      return { success: false, error: "Could not get sell quote" };
    }

    // Step 2: Build swap
    const swapData = await buildJupiterSwap(quote, wallet.publicKey);

    if (!swapData) {
      return { success: false, error: "Could not build sell swap" };
    }

    // Step 3: Execute
    const result = await executeSwap(swapData, wallet);

    if (result.success) {
      console.log(`  ✅ Sell successful! TX: ${result.txHash}`);
    }

    return result;
  } catch (err) {
    console.error("  ❌ Sell execution failed:", err.message);
    return { success: false, error: err.message };
  }
}

// --- Mechanical exit checks (no Claude needed) ---

function checkMechanicalExits(position, currentPrice) {
  const pnlPercent =
    ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  // 1. Stop loss
  if (pnlPercent <= config.risk.stopLossPercent) {
    return {
      shouldExit: true,
      exitPercent: 100,
      reason: "stop_loss",
      detail: `P&L ${pnlPercent.toFixed(1)}% hit stop loss of ${config.risk.stopLossPercent}%`,
    };
  }

  // 2. Take profit levels
  for (const tp of config.risk.takeProfitLevels) {
    if (
      pnlPercent >= tp.percent &&
      !position.takeProfitHit?.includes(tp.percent)
    ) {
      return {
        shouldExit: true,
        exitPercent: tp.sellPercent,
        reason: "take_profit",
        detail: `P&L ${pnlPercent.toFixed(1)}% hit TP level ${tp.percent}%`,
        tpLevel: tp.percent,
      };
    }
  }

  // 3. Trailing stop (activated after first take profit)
  if (position.takeProfitHit?.length > 0 && position.highestPrice) {
    const drawdownFromHigh =
      ((currentPrice - position.highestPrice) / position.highestPrice) * 100;

    if (drawdownFromHigh <= -config.risk.trailingStopPercent) {
      return {
        shouldExit: true,
        exitPercent: 100,
        reason: "trailing_stop",
        detail: `Dropped ${Math.abs(drawdownFromHigh).toFixed(1)}% from high of ${position.highestPrice}`,
      };
    }
  }

  // 4. Dead token timeout
  if (position.entryTime) {
    const hoursHeld =
      (Date.now() - new Date(position.entryTime).getTime()) / 3600000;
    const priceMovement = Math.abs(pnlPercent);

    if (
      hoursHeld >= config.risk.deadTokenTimeoutHours &&
      priceMovement < 10
    ) {
      return {
        shouldExit: true,
        exitPercent: 100,
        reason: "dead_token",
        detail: `Held ${hoursHeld.toFixed(1)}h with only ${priceMovement.toFixed(1)}% movement`,
      };
    }
  }

  return { shouldExit: false };
}

module.exports = {
  callClaudeForDecision,
  executeBuy,
  executeSell,
  checkMechanicalExits,
  getSOLBalance,
  getTokenBalance,
};
