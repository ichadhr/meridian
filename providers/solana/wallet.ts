/**
 * Shared Solana primitives — connection, wallet keypair, address normalization.
 * Used by Jupiter swap, DLMM operations, gas estimation, etc.
 */
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

let _connection: Connection | null = null;
let _wallet: Keypair | null = null;

export function getConnection(): Connection {
  if (!_connection) _connection = new Connection(process.env.RPC_URL!, "confirmed");
  return _connection;
}

export function getWallet(): Keypair {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** Normalize any SOL-like address to the correct wrapped SOL mint. */
export function normalizeMint(mint: string): string {
  if (!mint) return mint;
  if (
    mint === "SOL" ||
    mint === "native" ||
    /^So1+$/.test(mint) ||
    (mint.length >= 32 &&
      mint.length <= 44 &&
      mint.startsWith("So1") &&
      mint !== WRAPPED_SOL)
  ) {
    return WRAPPED_SOL;
  }
  return mint;
}
