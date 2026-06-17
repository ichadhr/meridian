// providers/lpagent/relay.ts
// LPAgent relay transaction signing, simulation, and validation.
// Extracted from providers/meteora/tx.ts to keep relay logic with its provider.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../../config/index.js";
import { log } from "../../utils/logger.js";
import { getConnection } from "../solana/wallet.js";

export function shouldUseLpAgentRelay(): boolean {
  return !!config?.api?.lpAgentRelayEnabled;
}

function signSerializedTransaction(serialized: string, wallet: Keypair): string {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch (_: any) {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64: string): Transaction | VersionedTransaction {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (_: any) {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx: Transaction | VersionedTransaction): string[] {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx: Transaction | VersionedTransaction): TransactionInstruction[] {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = (ix as any).accountKeyIndexes || (ix as any).accounts || [];
      const accounts = indexes
        .map((accountIndex: number) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean) as TransactionInstruction[];
}

function assertNoUnsafeSystemTransfer(
  tx: Transaction | VersionedTransaction,
  wallet: Keypair,
  allowedDestinations: string[] = []
): void {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));
  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    let type: string | null = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch (_: any) { continue; }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;
    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = (decoded as any).fromPubkey?.toString();
    const destination = (decoded as any).toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

export function signSerializedTransactions(serializedTxs: string[], wallet: Keypair): string[] {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

export async function signAndSimulateRelayTransactions(
  serializedTxs: string[],
  wallet: Keypair,
  {
    label,
    allowedDebitMints = [],
    allowedSystemTransferDestinations = [],
    maxSolLoss = 0.05,
    requiredStaticAccounts = [],
  }: {
    label?: string;
    allowedDebitMints?: string[];
    allowedSystemTransferDestinations?: string[];
    maxSolLoss?: number;
    requiredStaticAccounts?: string[];
  } = {}
): Promise<string[]> {
  const signed: string[] = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx as Transaction, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    } as any);
    const value = simulation.value as any;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map<string, bigint>();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`);
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }
    signed.push(signedBase64);
  }
  return signed;
}

export function normalizeExecutionSignatures(result: any): string[] {
  const signatures: string[] = [];
  const seen = new Set<string>();
  for (const value of ([] as any[])
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}
