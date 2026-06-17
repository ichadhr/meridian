// providers/meteora/tx.ts
// Transaction reliability, SDK loader, and DLMM transaction utilities.
// Extracted from dlmm.ts to keep the file focused on position lifecycle.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { log } from "../../utils/logger.js";
import { samplePriorityFee } from "../solana/gas-estimator.js";
import { getConnection } from "../solana/wallet.js";
import { getDLMM, getDlmmProgramId } from "./dlmm.js";

// ─── Transaction reliability infrastructure ──────────────────
const PRIORITY_FEE_FALLBACK_MICRO_LAMPORTS = 50_000;
const PRIORITY_FEE_TIMEOUT_MS = 5000;

const RETRYABLE = [
  "429", "Too Many Requests", "timeout", "ETIMEDOUT",
  "ECONNRESET", "ECONNREFUSED",
];

const _txWithPriorityFee = new WeakSet<Transaction | VersionedTransaction>();

async function getPriorityFeeMicroLamports(connection: Connection): Promise<number> {
  try {
    const sampled = await Promise.race([
      samplePriorityFee(connection),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("priority_fee_timeout")), PRIORITY_FEE_TIMEOUT_MS)
      ),
    ]);
    if (sampled > 0) return sampled;
  } catch (_: any) { /* fall through to fallback */ }
  return PRIORITY_FEE_FALLBACK_MICRO_LAMPORTS;
}

function addPriorityFee(tx: Transaction, microLamports: number): Transaction {
  if (!_txWithPriorityFee.has(tx)) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
    );
    _txWithPriorityFee.add(tx);
  }
  return tx;
}

async function withRetry<T>(fn: () => Promise<T>, { maxRetries = 5, label = "tx" } = {}): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      const retryable = RETRYABLE.some(r => msg.includes(r));
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      log("tx_retry", `${label} attempt ${attempt}/${maxRetries} failed (${msg.slice(0, 80)}), retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

async function sendTxWithRetry(connection: Connection, tx: Transaction, signers: Keypair[], label = "tx"): Promise<string> {
  if (process.env.DRY_RUN === "true") return "dry-run-signature";
  const microLamports = await getPriorityFeeMicroLamports(connection);
  addPriorityFee(tx, microLamports);
  return withRetry(
    () => sendAndConfirmTransaction(connection, tx, signers, { maxRetries: 0 }),
    { label }
  );
}

async function sendTxBatch(connection: Connection, txs: Transaction[], signersFn: Keypair[] | ((i: number) => Keypair[]), label = "batch"): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const signers = typeof signersFn === "function" ? signersFn(i) : signersFn;
    const hash = await sendTxWithRetry(connection, tx, signers, `${label}[${i + 1}/${txs.length}]`);
    hashes.push(hash);
    if (txs.length > 1 && i < txs.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return hashes;
}

function formatSolFee(value: unknown): string {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

export async function assertRangeDoesNotRequireBinArrayInitialization(
  pool: any,
  minBinId: number,
  maxBinId: number
): Promise<void> {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account: any, index: number) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry: any) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index: any) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs: string[]): void {
  const offenders: string[] = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized: string): string[] {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean) as string[];
  } catch (_: any) {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean) as string[];
  }
}

export {
  getPriorityFeeMicroLamports,
  addPriorityFee,
  withRetry,
  sendTxWithRetry,
  sendTxBatch,
  formatSolFee,
  assertNoInitializeBinArrayInstructions,
  getDlmmInstructionDiscriminators,
};
