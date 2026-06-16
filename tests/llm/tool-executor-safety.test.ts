import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fetch for fetchFreshPoolDetail
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock provider modules - must be before imports
vi.mock("../../providers/meteora/index.js", () => ({
  getMyPositions: vi.fn(),
  getActiveBin: vi.fn(),
  deployPosition: vi.fn(),
  getWalletPositions: vi.fn(),
  getPositionPnl: vi.fn(),
  claimFees: vi.fn(),
  closePosition: vi.fn(),
  searchPools: vi.fn(),
  invalidatePositionsCache: vi.fn(),
  discoverPools: vi.fn(),
  getPoolDetail: vi.fn(),
  getTopCandidates: vi.fn(),
}));

vi.mock("../../providers/solana/index.js", () => ({
  getWalletBalances: vi.fn(),
}));

vi.mock("../../providers/jupiter/index.js", () => ({
  swapToken: vi.fn(),
  getTokenInfo: vi.fn(),
  getTokenHolders: vi.fn(),
  getTokenNarrative: vi.fn(),
}));

vi.mock("../../core/vp/state.js", () => ({
  parseVirtualPositionAddress: vi.fn(),
}));

vi.mock("../../core/vp/manage.js", () => ({
  closeVpPosition: vi.fn(),
}));

vi.mock("../../core/lessons.js", () => ({
  addLesson: vi.fn(),
  clearAllLessons: vi.fn(),
  clearPerformance: vi.fn(),
  removeLessonsByKeyword: vi.fn(),
  getPerformanceHistory: vi.fn(),
  pinLesson: vi.fn(),
  unpinLesson: vi.fn(),
  listLessons: vi.fn(),
}));

vi.mock("../../core/state.js", () => ({
  setPositionInstruction: vi.fn(),
}));

vi.mock("../../core/pool-memory.js", () => ({
  getPoolMemory: vi.fn(),
  addPoolNote: vi.fn(),
}));

vi.mock("../../core/strategy-library.js", () => ({
  addStrategy: vi.fn(),
  listStrategies: vi.fn(),
  getStrategy: vi.fn(),
  setActiveStrategy: vi.fn(),
  removeStrategy: vi.fn(),
}));

vi.mock("../../core/token-blacklist.js", () => ({
  addToBlacklist: vi.fn(),
  isBlacklisted: vi.fn(() => false),
  removeFromBlacklist: vi.fn(),
  listBlacklist: vi.fn(),
  blockDev: vi.fn(),
  unblockDev: vi.fn(),
  listBlockedDevs: vi.fn(),
}));

vi.mock("../../core/smart-wallets.js", () => ({
  addSmartWallet: vi.fn(),
  removeSmartWallet: vi.fn(),
  listSmartWallets: vi.fn(),
  checkSmartWalletsOnPool: vi.fn(),
}));

vi.mock("../../core/decision-log.js", () => ({
  getRecentDecisions: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock("../../interfaces/index.js", () => ({
  notifyDeploy: vi.fn(),
  notifyClose: vi.fn(),
  notifySwap: vi.fn(),
}));

vi.mock("../../llm/tools/study.js", () => ({
  studyTopLPers: vi.fn(),
}));

// Import AFTER mocks
import { executeTool } from "../../llm/tools/executor.js";
import { getMyPositions } from "../../providers/meteora/index.js";
import { getWalletBalances } from "../../providers/solana/index.js";
import { config } from "../../config/index.js";

const mockGetMyPositions = vi.mocked(getMyPositions);
const mockGetWalletBalances = vi.mocked(getWalletBalances);

describe("executeTool safety checks", () => {
  const originalDryRun = process.env.DRY_RUN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DRY_RUN = "true";

    // Default mock responses
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ tvl: 50000, bin_step: 100, volatility: 2.5 }] }),
    });

    mockGetMyPositions.mockResolvedValue({
      total_positions: 0,
      positions: [],
    } as any);

    mockGetWalletBalances.mockResolvedValue({
      wallet: "test-wallet",
      sol: 10,
      sol_price: 100,
      sol_usd: 1000,
      usdc: 0,
      tokens: [],
      total_usd: 1000,
    } as any);

  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
  });

  describe("deploy_position", () => {
    it("rejects amount_x > 0 (single-side SOL only)", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_x: 1,
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("single-side SOL");
    });

    it("rejects bins_below below minimum", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 10,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("below minimum");
    });

    it("rejects bins_above != 0 for single-side SOL", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 5,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("bins_above=0");
    });

    it("rejects invalid volatility", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
        volatility: -1,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("invalid");
    });

    it("rejects zero volatility", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
        volatility: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("invalid");
    });

    it("rejects amount_y below minimum", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.05,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("below the minimum");
    });

    it("rejects amount_y above maximum", async () => {
      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 100,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("exceeds maximum");
    });

    it("rejects max positions reached", async () => {
      mockGetMyPositions.mockResolvedValue({
        total_positions: config.risk.maxPositions,
        positions: [],
      } as any);

      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Max positions");
    });

    it("rejects duplicate pool", async () => {
      mockGetMyPositions.mockResolvedValue({
        total_positions: 1,
        positions: [{ pool: "test-pool" }],
      } as any);

      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Already have an open position");
    });

    it("rejects duplicate base token", async () => {
      mockGetMyPositions.mockResolvedValue({
        total_positions: 1,
        positions: [{ pool: "other-pool", base_mint: "token-mint-123" }],
      } as any);

      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        base_mint: "token-mint-123",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Already holding base token");
    });

    it("rejects blacklisted mint", async () => {
      // Re-import with blacklist mock returning true
      const { isBlacklisted } = await import("../../core/token-blacklist.js");
      vi.mocked(isBlacklisted).mockReturnValueOnce(true as any);

      const result = await executeTool("deploy_position", {
        pool_address: "test-pool",
        base_mint: "known-rug-mint",
        amount_y: 0.5,
        bins_below: 35,
        bins_above: 0,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("blacklisted");
    });
  });

  describe("swap_token", () => {
    it("passes safety check", async () => {
      const result = await executeTool("swap_token", {
        input_mint: "token-a",
        output_mint: "SOL",
        amount: 100,
      });
      // Should not be blocked by safety check (may fail for other reasons)
      expect(result.blocked).toBeUndefined();
    });
  });

  describe("self_update", () => {
    it("blocks when ALLOW_SELF_UPDATE is not true", async () => {
      delete process.env.ALLOW_SELF_UPDATE;
      const result = await executeTool("self_update", {});
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("disabled by default");
    });
  });
});
