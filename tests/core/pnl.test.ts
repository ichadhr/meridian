import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../../config/index.js";
import { getPnlConnection, computePositions } from "../../providers/solana/index.js";
import { Connection, PublicKey } from "@solana/web3.js";

// Mock only getAllLbPairPositionsByUser on default DLMM class export
vi.mock("@meteora-ag/dlmm", async (importOriginal) => {
  const actual = await importOriginal() as any;
  actual.default.getAllLbPairPositionsByUser = vi.fn();
  return actual;
});

describe("RPC PnL Engine", () => {
  const validWalletAddress = PublicKey.default.toString();

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("getPnlConnection returns a Connection instance with configured RPC url", () => {
    config.pnl.rpcUrl = "https://mock-rpc-url.com";
    const conn = getPnlConnection();
    expect(conn).toBeInstanceOf(Connection);
    expect(conn.rpcEndpoint).toBe("https://mock-rpc-url.com");
  });

  it("computePositions returns empty result when no positions are found on-chain", async () => {
    const DLMM = (await import("@meteora-ag/dlmm")).default as any;
    vi.mocked(DLMM.getAllLbPairPositionsByUser).mockResolvedValue(new Map());

    const result = await computePositions(validWalletAddress);
    expect(result).toEqual({
      wallet: validWalletAddress,
      total_positions: 0,
      positions: [],
      source: "rpc",
    });
  });
});
