import { describe, it, expect, afterEach } from "vitest";
import { _positionsCacheTtlForTesting, invalidatePositionsCache } from "../../providers/meteora/index.js";

describe("DRY_RUN cache TTL", () => {
  const origEnv = process.env.DRY_RUN;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = origEnv;
    invalidatePositionsCache();
  });

  it("returns 5min TTL in live mode (DRY_RUN unset)", () => {
    delete process.env.DRY_RUN;
    expect(_positionsCacheTtlForTesting()).toBe(300_000);
  });

  it("returns 5min TTL when DRY_RUN=false", () => {
    process.env.DRY_RUN = "false";
    expect(_positionsCacheTtlForTesting()).toBe(300_000);
  });

  it("returns 10s TTL in DRY_RUN mode", () => {
    process.env.DRY_RUN = "true";
    expect(_positionsCacheTtlForTesting()).toBe(10_000);
  });

  it("DRY_RUN TTL is shorter than live TTL", () => {
    process.env.DRY_RUN = "true";
    const dryRunTtl = _positionsCacheTtlForTesting();
    delete process.env.DRY_RUN;
    const liveTtl = _positionsCacheTtlForTesting();
    expect(dryRunTtl).toBeLessThan(liveTtl);
  });

  it("TTL switches back after DRY_RUN is unset", () => {
    process.env.DRY_RUN = "true";
    expect(_positionsCacheTtlForTesting()).toBe(10_000);
    delete process.env.DRY_RUN;
    expect(_positionsCacheTtlForTesting()).toBe(300_000);
  });

  it("invalidatePositionsCache is callable and idempotent", () => {
    invalidatePositionsCache();
    invalidatePositionsCache();
  });
});
