import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock LLM module to avoid OpenAI client initialization
vi.mock("../../llm/index.js", () => ({
  agentLoop: vi.fn(),
}));

import { getLoneCandidateSkipReason } from "../../core/index.js";
import { config } from "../../config/index.js";

function candidate(overrides: Record<string, any> = {}) {
  return {
    pool: { name: "TEST-SOL", gmgn_smart_wallets: 0, ...overrides.pool },
    sw: overrides.sw ?? null,
    n: overrides.n ?? null,
    ti: overrides.ti ?? null,
    mem: null,
  };
}

describe("getLoneCandidateSkipReason", () => {
  const original = {
    minTokenFeesSol: config.screening.minTokenFeesSol,
    maxTop10Pct: config.screening.maxTop10Pct,
    maxBotHoldersPct: config.screening.maxBotHoldersPct,
  };

  beforeEach(() => {
    config.screening.minTokenFeesSol = 30;
    config.screening.maxTop10Pct = 60;
    config.screening.maxBotHoldersPct = 25;
  });

  afterEach(() => {
    config.screening.minTokenFeesSol = original.minTokenFeesSol;
    config.screening.maxTop10Pct = original.maxTop10Pct;
    config.screening.maxBotHoldersPct = original.maxBotHoldersPct;
  });

  it("returns error when pool is missing", () => {
    expect(getLoneCandidateSkipReason({} as any)).toBe("missing candidate data");
  });

  it("skips wash trading", () => {
    const c = candidate({ pool: { is_wash: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("wash trading was flagged");
  });

  it("skips rugpull with no smart wallets", () => {
    const c = candidate({ pool: { is_rugpull: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("rugpull risk was flagged and no smart wallets offset it");
  });

  it("allows rugpull when smart wallets present", () => {
    const c = candidate({
      pool: { is_rugpull: true },
      sw: { in_pool: [{ name: "whale1" }] },
    });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });

  it("skips PVP with no smart wallets", () => {
    const c = candidate({ pool: { is_pvp: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("PVP symbol conflict and no smart-wallet confirmation");
  });

  it("skips low token fees", () => {
    const c = candidate({ ti: { global_fees_sol: 10 } });
    expect(getLoneCandidateSkipReason(c)).toContain("token fees");
  });

  it("skips high top10 concentration", () => {
    const c = candidate({ ti: { audit: { top_holders_pct: 80 } } });
    expect(getLoneCandidateSkipReason(c)).toContain("top10 concentration");
  });

  it("skips high bot holders", () => {
    const c = candidate({ ti: { audit: { bot_holders_pct: 30 } } });
    expect(getLoneCandidateSkipReason(c)).toContain("bot holders");
  });

  it("skips when no narrative and no smart wallets", () => {
    const c = candidate();
    expect(getLoneCandidateSkipReason(c)).toBe("only candidate has no narrative and no smart-wallet confirmation");
  });

  it("passes when smart wallets present", () => {
    const c = candidate({ sw: { in_pool: [{ name: "whale1" }] } });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });

  it("passes when narrative present", () => {
    const c = candidate({ n: { narrative: "meme coin" } });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });
});
