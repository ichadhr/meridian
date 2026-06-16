import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SafetyVerdict } from "../../providers/okx/index.js";

vi.mock("../../providers/okx/index.js", () => ({
  scanTokens: vi.fn(),
}));

import { runSafetyPreStep } from "../../core/screen.js";
import { scanTokens } from "../../providers/okx/index.js";
import { config } from "../../config/index.js";

const mockScanTokens = vi.mocked(scanTokens);

// ── Helpers ──────────────────────────────────────────────────────

interface Pool {
  pool?: string;
  base?: { mint?: string };
  base_mint?: string;
  name?: string;
  [key: string]: any;
}

function candidate(overrides: Record<string, any> = {}): any {
  return {
    pool: { pool: "pool-1", name: "Pool 1", base: { mint: "mint1111111111111111111111111111111111111" } },
    sw: null,
    swFailed: false,
    n: null,
    nFailed: false,
    ti: {},
    mem: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<SafetyVerdict> = {}): SafetyVerdict {
  return {
    mint: "mint1111111111111111111111111111111111111",
    riskLevel: "LOW",
    summary: "no risk labels triggered",
    buyTaxes: null,
    sellTaxes: null,
    triggeredLabels: [],
    ...overrides,
  };
}

const unknownMint = "mint2222222222222222222222222222222222222";

// ── Tests ────────────────────────────────────────────────────────

describe("runSafetyPreStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: OKX scan returns LOW for all mints
    mockScanTokens.mockResolvedValue([
      verdict(),
      verdict({ mint: unknownMint }),
    ]);
  });

  // ── Empty / edge cases ─────────────────────────────────────────

  it("returns empty result when no candidates", async () => {
    const result = await runSafetyPreStep([]);
    expect(result.safePassing).toEqual([]);
    expect(result.summary).toBe("");
    expect(result.scanFailed).toBe(false);
    expect(result.verdictMap.size).toBe(0);
  });

  it("returns 'skipped' summary when candidates have no mint addresses", async () => {
    const c = candidate({ pool: { pool: "pool-1", name: "Pool 1" } }); // no base.mint
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(1);
    expect(result.safePassing[0]).toBe(c);
    expect(result.summary).toContain("skipped");
    expect(result.scanFailed).toBe(false);
  });

  it("passes through candidates without a mint individually", async () => {
    const c1 = candidate({ pool: { pool: "p1", name: "P1" } });            // no mint
    const c2 = candidate({ pool: { pool: "p2", name: "P2", base: { mint: "minta" } } });
    // Only one mint returned (minta)
    mockScanTokens.mockResolvedValue([verdict({ mint: "minta", riskLevel: "LOW" })]);
    const result = await runSafetyPreStep([c1, c2]);
    expect(result.safePassing).toHaveLength(2);               // both pass through
    expect(result.safePassing[0]).toBe(c1);
    expect(result.safePassing[1]).toBe(c2);
  });

  it("blocks mintless candidates when required=true", async () => {
    const origRequired = config.safetyScan.required;
    config.safetyScan.required = true as any;
    const c = candidate({ pool: { pool: "p1", name: "P1" } }); // no mint
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(0);
    expect(result.summary).toContain("no mint");
    config.safetyScan.required = origRequired;
  });

  // ── Scan failure ────────────────────────────────────────────────

  it("fail-closed when scanTokens throws and required=true", async () => {
    const origRequired = config.safetyScan.required;
    config.safetyScan.required = true as any;
    mockScanTokens.mockRejectedValue(new Error("binary not found"));
    const c = candidate();
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toEqual([]);
    expect(result.scanFailed).toBe(true);
    expect(result.summary).toContain("binary not found");
    config.safetyScan.required = origRequired;
  });

  it("passes-through when scanTokens throws and required=false", async () => {
    const origRequired = config.safetyScan.required;
    config.safetyScan.required = false as any;
    mockScanTokens.mockRejectedValue(new Error("binary timeout"));
    const c = candidate();
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(1);
    expect(result.safePassing[0]).toBe(c);
    expect(result.scanFailed).toBe(true);
    expect(result.summary).toContain("passing through");
    config.safetyScan.required = origRequired;
  });

  // ── Risk-level filtering ───────────────────────────────────────

  it("keeps LOW candidates", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "LOW" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(1);
    expect(result.safePassing[0]).toBe(c);
  });

  it("blocks CRITICAL candidates", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "CRITICAL" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(0);
  });

  it("blocks HIGH candidates", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "HIGH" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(0);
  });

  it("blocks SCAN_FAILED candidates", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "SCAN_FAILED", summary: "mint missing from response" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(0);
  });

  it("keeps MEDIUM candidates when dropMediumRisk is false (default)", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "MEDIUM" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(1);
  });

  it("blocks MEDIUM candidates when dropMediumRisk is true", async () => {
    const orig = config.safetyScan.dropMediumRisk;
    config.safetyScan.dropMediumRisk = true as any;
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "MEDIUM" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(0);
    config.safetyScan.dropMediumRisk = orig;  // restore
  });

  // ── Mixed batch ─────────────────────────────────────────────────

  it("filters mixed batch correctly — keeps LOW, blocks CRITICAL/HIGH", async () => {
    const cLow  = candidate({ pool: { pool: "p-low",  name: "Low",  base: { mint: "mintLOW"  } } });
    const cHigh = candidate({ pool: { pool: "p-high", name: "High", base: { mint: "mintHIGH" } } });
    const cCrit = candidate({ pool: { pool: "p-crit", name: "Crit", base: { mint: "mintCRIT" } } });

    mockScanTokens.mockResolvedValue([
      verdict({ mint: "mintLOW",  riskLevel: "LOW" }),
      verdict({ mint: "mintHIGH", riskLevel: "HIGH" }),
      verdict({ mint: "mintCRIT", riskLevel: "CRITICAL" }),
    ]);

    const result = await runSafetyPreStep([cLow, cHigh, cCrit]);
    expect(result.safePassing).toHaveLength(1);
    expect(result.safePassing[0]).toBe(cLow);
  });

  // ── Verbose candidates (candidate.pool has base_mint directly) ──

  it("extracts mint from pool.base_mint as fallback", async () => {
    const c = candidate({ pool: { base: undefined, base_mint: unknownMint, pool: "p1", name: "P1" } });
    mockScanTokens.mockResolvedValue([verdict({ mint: unknownMint, riskLevel: "LOW" })]);
    const result = await runSafetyPreStep([c]);
    expect(result.safePassing).toHaveLength(1);
  });

  // ── VerdictMap ─────────────────────────────────────────────────

  it("populates verdictMap with per-mint results", async () => {
    const c = candidate();
    mockScanTokens.mockResolvedValue([verdict({ riskLevel: "LOW", buyTaxes: 5, sellTaxes: 5 })]);
    const result = await runSafetyPreStep([c]);
    const v = result.verdictMap.get("mint1111111111111111111111111111111111111");
    expect(v).toBeDefined();
    expect(v!.riskLevel).toBe("LOW");
    expect(v!.buyTaxes).toBe(5);
  });

  // ── Summary format ──────────────────────────────────────────────

  it("builds summary with verdict lines and blocked count", async () => {
    const cLow  = candidate({ pool: { pool: "p-low",  name: "Low",  base: { mint: "mintLOW"  } } });
    const cHigh = candidate({ pool: { pool: "p-high", name: "High", base: { mint: "mintHIGH" } } });

    mockScanTokens.mockResolvedValue([
      verdict({ mint: "mintLOW",  riskLevel: "LOW",   summary: "no risk" }),
      verdict({ mint: "mintHIGH", riskLevel: "HIGH",  summary: "dumping" }),
    ]);

    const result = await runSafetyPreStep([cLow, cHigh]);
    expect(result.summary).toContain("OKX safety scan");
    expect(result.summary).toContain("mintLOW");
    expect(result.summary).toContain("LOW");
    expect(result.summary).toContain("mintHIGH");
    expect(result.summary).toContain("HIGH");
    expect(result.summary).toContain("Blocked: 1/2");
  });
});
