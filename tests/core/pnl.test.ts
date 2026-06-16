import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../../config/index.js";
import { getPnlConnection, _resetPnlConnectionForTesting, computePositions, getJupiterPrices } from "../../providers/solana/index.js";
import { Connection, PublicKey } from "@solana/web3.js";

// Mock only getAllLbPairPositionsByUser on default DLMM class export
vi.mock("@meteora-ag/dlmm", async (importOriginal) => {
  const actual = await importOriginal() as any;
  actual.default.getAllLbPairPositionsByUser = vi.fn();
  return actual;
});

// Mock Jupiter API — keep other exports (getTokenInfo etc.) via importOriginal
vi.mock("../../providers/jupiter/index.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, fetchSolPrice: vi.fn() };
});

const SOL_MINT = config.tokens.SOL;
const TOKEN_A = "TokenAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TOKEN_B = "TokenBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TOKEN_C = "TokenCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

// getJupiterPrices mocks
const { fetchSolPrice } = await import("../../providers/jupiter/index.js");

describe("getJupiterPrices", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetchSolPrice).mockResolvedValue(123.45);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns empty object for empty mints list", async () => {
    await expect(getJupiterPrices([])).resolves.toEqual({});
  });

  it("returns SOL price from fetchSolPrice when only SOL is requested", async () => {
    const result = await getJupiterPrices([SOL_MINT]);
    expect(fetchSolPrice).toHaveBeenCalledOnce();
    expect(result[SOL_MINT]).toBe(123.45);
  });

  it("returns token prices alongside SOL from price/v3 endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ [TOKEN_A]: { usdPrice: 1.5 }, [TOKEN_B]: { usdPrice: 0.25 } }),
    } as Response);

    const result = await getJupiterPrices([SOL_MINT, TOKEN_A, TOKEN_B]);
    expect(result[SOL_MINT]).toBe(123.45);
    expect(result[TOKEN_A]).toBe(1.5);
    expect(result[TOKEN_B]).toBe(0.25);
  });

  it("returns null for mint missing in response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ [TOKEN_A]: { usdPrice: 1.5 } }),
    } as Response);

    const result = await getJupiterPrices([SOL_MINT, TOKEN_A, TOKEN_B]);
    expect(result[TOKEN_A]).toBe(1.5);
    expect(result[TOKEN_B]).toBeNull();
  });

  it("returns null for invalid usdPrice values", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        [TOKEN_A]: { usdPrice: "not-a-number" },
        [TOKEN_B]: { usdPrice: null },
        [TOKEN_C]: {},
      }),
    } as Response);

    const result = await getJupiterPrices([SOL_MINT, TOKEN_A, TOKEN_B, TOKEN_C]);
    expect(result[TOKEN_A]).toBeNull();
    expect(result[TOKEN_B]).toBeNull();
    expect(result[TOKEN_C]).toBeNull();
  });

  it("returns SOL-only results on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

    const result = await getJupiterPrices([SOL_MINT, TOKEN_A]);
    expect(result[SOL_MINT]).toBe(123.45);
    expect(result[TOKEN_A]).toBeNull();
  });

  it("returns SOL-only results on fetch exception", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network error"));

    const result = await getJupiterPrices([SOL_MINT, TOKEN_A]);
    expect(result[SOL_MINT]).toBe(123.45);
    expect(result[TOKEN_A]).toBeNull();
  });

  it("chunks requests when >100 mints", async () => {
    const manyMints = Array.from({ length: 250 }, (_, i) => `mint${i}`);
    let callCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      callCount++;
      return { ok: true, json: async () => ({}) } as Response;
    });

    await getJupiterPrices([SOL_MINT, ...manyMints]);
    expect(callCount).toBe(3); // 250 mints = 3 chunks of 100+100+50
  });

  it("filters out null, undefined, and empty mints", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ [TOKEN_A]: { usdPrice: 1.0 } }),
    } as Response);

    const result = await getJupiterPrices([SOL_MINT, null, undefined, "", TOKEN_A]);
    const fetchUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(fetchUrl).not.toContain("null");
    expect(fetchUrl).not.toContain("undefined");
    expect(result[TOKEN_A]).toBe(1.0);
  });
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

  it("getPnlConnection throws on empty RPC URL", () => {
    const origUrl = config.pnl.rpcUrl;
    config.pnl.rpcUrl = "" as any;
    _resetPnlConnectionForTesting();
    expect(() => getPnlConnection()).toThrow(/rpcUrl/i);
    _resetPnlConnectionForTesting();
    config.pnl.rpcUrl = origUrl;
    // Reset state so subsequent tests get a fresh connection
    config.pnl.rpcUrl = "https://mock-rpc-url.com";
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
