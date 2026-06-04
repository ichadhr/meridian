#!/usr/bin/env node
/**
 * Measure real gas cost of DLMM deploy + close on mainnet.
 * - Builds deploy tx + close tx using same SDK flow as dlmm.js
 * - Gets CU via SDK defaults (or simulation)
 * - Computes SOL cost from CU + priority fee + base fee
 * - Adds rent costs (recoverable on close — see analysis)
 */
import "dotenv/config";
import * as Meteora from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import bs58 from "bs58";

const RPC = process.env.RPC_URL;
const PK = process.env.WALLET_PRIVATE_KEY;
if (!RPC || !PK) { console.error("RPC_URL / WALLET_PRIVATE_KEY required"); process.exit(1); }

const conn = new Connection(RPC, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PK));
console.log("Wallet:", wallet.publicKey.toBase58());

// Find one DLMM pool
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
let dlmm, poolUsed;
try {
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM, {
    dataSlice: { offset: 0, length: 8 },
    filters: [{ dataSize: 904 }],
  });
  for (const a of accs.slice(0, 3)) {
    try {
      dlmm = await Meteora.default.create(conn, a.pubkey);
      await dlmm.refetchStates();
      poolUsed = a.pubkey.toBase58();
      break;
    } catch (e) { /* try next */ }
  }
} catch (e) { console.log("scan err:", e.message.slice(0, 200)); }
if (!dlmm) { console.error("No pool loaded"); process.exit(1); }
console.log("Pool:", poolUsed, "binStep:", dlmm.lbPair.binStep, "activeId:", dlmm.lbPair.activeId);

// Recent priority fee (microLamports per CU)
let priorityFee = 0;
try {
  const pf = await conn.getRecentPrioritizationFees();
  if (pf.length) {
    pf.sort((a, b) => b.prioritizationFee - a.prioritizationFee);
    // Use p75 (more realistic than median for actual inclusion)
    const p75 = pf[Math.floor(pf.length * 0.25)]; // 75th percentile
    priorityFee = p75.prioritizationFee;
    console.log("Priority fee p75:", priorityFee, "microLamports/CU");
    console.log("  median:", pf[Math.floor(pf.length / 2)].prioritizationFee);
    console.log("  max:", pf[0].prioritizationFee);
  }
} catch (e) {}

// === BUILD DEPLOY TX ===
const activeBin = await dlmm.getActiveBin();
const minBinId = activeBin.binId - 30;
const maxBinId = activeBin.binId + 30;
const solLamports = 50_000_000; // 0.05 SOL

let deployTx;
try {
  deployTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: Keypair.generate().publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(0),
    totalYAmount: new BN(solLamports),
    strategy: { minBinId, maxBinId, strategyType: 1, parameteres: [0, 0, 0, 0] },
  });
  deployTx.feePayer = wallet.publicKey;
  console.log("Deploy tx ix count:", deployTx.instructions.length);
} catch (e) {
  console.error("Build deploy failed:", e.message);
  process.exit(1);
}

// === ESTIMATE CU ===
// Simulation fails for a fake position keypair (AccountNotFound).
// Use SDK's documented defaults — these are the exact values the SDK uses internally.
const SDK_DEFAULTS = {
  initPosition: 30_000,         // DEFAULT_INIT_POSITION_CU
  initBinArray: 350_000,         // DEFAULT_INIT_BIN_ARRAY_CU
  addLiquidity: 1_000_000,       // DEFAULT_ADD_LIQUIDITY_CU
  closePosition: 300_000,        // matches tools/gas-estimator.js CLOSE_POSITION_CU
};
// deploy: init position + (maybe) init bin array + add liquidity
const deployCU = SDK_DEFAULTS.initPosition + SDK_DEFAULTS.initBinArray + SDK_DEFAULTS.addLiquidity;
const closeCU = SDK_DEFAULTS.closePosition;
console.log("Deploy CU (SDK defaults):", deployCU.toLocaleString());
console.log("Close CU (SDK defaults):", closeCU.toLocaleString());

// === COSTS ===
const baseFeeSig = 5000; // lamports
const baseFeePerTx = baseFeeSig; // 1 sig per tx
const priorityFeePerCU = priorityFee; // microLamports
const MICRO = 1_000_000;

const deployTxCost = (deployCU * priorityFeePerCU) / MICRO + baseFeePerTx; // lamports
const closeTxCost = (closeCU * priorityFeePerCU) / MICRO + baseFeePerTx; // lamports
const totalTxCost = (deployTxCost + closeTxCost) / LAMPORTS_PER_SOL;

console.log("\n=== RESULTS ===");
console.log("Priority fee per tx:", deployCU * priorityFeePerCU / MICRO, "lamports");
console.log("Deploy tx fee:", deployTxCost / LAMPORTS_PER_SOL, "SOL");
console.log("Close tx fee:", closeTxCost / LAMPORTS_PER_SOL, "SOL");
console.log("Total tx fees:", totalTxCost, "SOL");

// Rent
const posRent = Meteora.POSITION_FEE;
const binArrRent = Meteora.BIN_ARRAY_FEE;
const ataRent = Meteora.TOKEN_ACCOUNT_FEE;
const bitmapRent = Meteora.BIN_ARRAY_BITMAP_FEE;
const totalRent = posRent + binArrRent + 2 * ataRent + bitmapRent;
console.log("Rent (pos + binArr + 2 ATAs + bitmap):", totalRent, "SOL");
console.log("  Position:", posRent, "  Bin array:", binArrRent, "  2 ATAs:", 2 * ataRent, "  Bitmap:", bitmapRent);

// Net gas (tx fees) is the "real" unrecoverable cost
// Rent is locked at deploy, returned at close — so NET = tx fees only
// But if position was open long enough to be worth it, rent is real opportunity cost
console.log("\n=== RECOMMENDED vpGasCostSol ===");
console.log("Unrecoverable tx fees only:", totalTxCost.toFixed(6), "SOL");
console.log("Tx fees + rent (opportunity cost, worst case):", (totalTxCost + totalRent).toFixed(6), "SOL");
console.log("Tx fees + half rent (50% closed positions before recovery):", (totalTxCost + totalRent / 2).toFixed(6), "SOL");
