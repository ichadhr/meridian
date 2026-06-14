import { describe, it, expect } from "vitest";
import { getLoneCandidateSkipReason } from "../core/index.js";

interface TestCandidate {
  pool: any;
  sw?: any;
  swFailed?: boolean;
  n?: any;
  nFailed?: boolean;
  ti?: any;
  mem?: any;
  [key: string]: any;
}

// Helper to build a minimal valid candidate for skip-reason tests
function candidate(overrides: Partial<TestCandidate> = {}): TestCandidate {
  return {
    pool: { name: "TEST" } as any,
    sw: null,
    swFailed: false,
    n: null,
    nFailed: false,
    ti: { global_fees_sol: 100, audit: {} } as any,
    mem: null,
    ...overrides,
  };
}

describe("getLoneCandidateSkipReason — tool failure guard", () => {
  it("skips when both narrative and smart_wallets are genuinely missing", () => {
    const c: any = candidate({ sw: null, n: null, swFailed: false, nFailed: false });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toContain("no narrative and no smart-wallet");
  });

  it("does NOT skip when narrative tool failed (nFailed=true)", () => {
    const c: any = candidate({ sw: null, n: null, swFailed: false, nFailed: true });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when smart_wallets tool failed (swFailed=true)", () => {
    const c: any = candidate({ sw: null, n: null, swFailed: true, nFailed: false });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when BOTH tools failed (nFailed=true, swFailed=true)", () => {
    const c: any = candidate({ sw: null, n: null, swFailed: true, nFailed: true });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when narrative failed but smart_wallets has data", () => {
    const c: any = candidate({
      sw: { in_pool: [{ name: "AlphaVault" }] } as any,
      n: null,
      swFailed: false,
      nFailed: true,
    });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when smart_wallets failed but narrative has data", () => {
    const c: any = candidate({
      sw: null,
      n: { narrative: "strong narrative" } as any,
      swFailed: true,
      nFailed: false,
    });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when both succeeded with data", () => {
    const c: any = candidate({
      sw: { in_pool: [{ name: "AlphaVault" }] } as any,
      n: { narrative: "strong narrative" } as any,
      swFailed: false,
      nFailed: false,
    });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toBeNull();
  });

  it("does NOT skip when one tool failed and other returned empty data", () => {
    // sw succeeded but found nothing, n failed
    const c1: any = candidate({ sw: null, n: null, swFailed: false, nFailed: true });
    expect(getLoneCandidateSkipReason(c1)).toBeNull();
    // n succeeded but found nothing, sw failed
    const c2: any = candidate({ sw: null, n: null, swFailed: true, nFailed: false });
    expect(getLoneCandidateSkipReason(c2)).toBeNull();
  });

  it("still skips on hard limits (low fees) even if tools failed", () => {
    const c: any = candidate({
      sw: null,
      n: null,
      swFailed: true,
      nFailed: true,
      ti: { global_fees_sol: 1, audit: {} } as any, // below minTokenFeesSol
    });
    const result = getLoneCandidateSkipReason(c);
    expect(result).toContain("token fees");
  });
});
