// test/test-dry-run-cache.ts
// smoke test for DRY_RUN cache TTL.
//
// The TTL function is exported as _positionsCacheTtlForTesting from
// tools/dlmm.js. We don't mock time — we just verify the TTL constant
// changes based on DRY_RUN env. The integration behavior is straightforward:
// 5min = 300_000ms, 10s = 10_000ms. The exact number is the contract.

import { _positionsCacheTtlForTesting, invalidatePositionsCache } from "../providers/meteora/index.js";

const TTL = _positionsCacheTtlForTesting;
let pass = 0;
let fail = 0;
const failures: Array<{ name: string; error: string }> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e: any) {
    fail++;
    failures.push({ name, error: e.message });
    console.log(`❌ ${name}: ${e.message}`);
  }
}

// Save and restore DRY_RUN around tests. Note: `process.env.X = undefined`
// in Node actually sets X to the string "undefined", so we must use
// `delete` when the original was undefined.
function restoreDryRun(original: string | undefined): void {
  if (original === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = original;
}
const originalDryRun = process.env.DRY_RUN;

test("TTL in live mode (DRY_RUN unset) is 5 minutes", () => {
  delete process.env.DRY_RUN;
  const ttl = TTL();
  if (ttl !== 300_000) throw new Error(`expected 300_000, got ${ttl}`);
});

test("TTL in live mode (DRY_RUN=false) is 5 minutes", () => {
  process.env.DRY_RUN = "false";
  const ttl = TTL();
  if (ttl !== 300_000) throw new Error(`expected 300_000, got ${ttl}`);
});

test("TTL in DRY_RUN mode is 10 seconds", () => {
  process.env.DRY_RUN = "true";
  const ttl = TTL();
  if (ttl !== 10_000) throw new Error(`expected 10_000, got ${ttl}`);
});

test("DRY_RUN TTL is shorter than live TTL (intentional, prevents stale display)", () => {
  process.env.DRY_RUN = "true";
  const dryRunTtl = TTL();
  delete process.env.DRY_RUN;
  const liveTtl = TTL();
  if (!(dryRunTtl < liveTtl)) throw new Error(`expected dryRunTtl (${dryRunTtl}) < liveTtl (${liveTtl})`);
});

test("TTL switches back to live after DRY_RUN is unset", () => {
  process.env.DRY_RUN = "true";
  if (TTL() !== 10_000) throw new Error("expected 10_000 when DRY_RUN=true");
  delete process.env.DRY_RUN;
  if (TTL() !== 300_000) throw new Error("expected 300_000 when DRY_RUN unset");
});

test("invalidatePositionsCache is callable and doesn't throw", () => {
  // We can't easily verify the cache state without exporting internals,
  // but we can at least confirm the export exists and is idempotent.
  invalidatePositionsCache();
  invalidatePositionsCache();
  // If we got here without throwing, the function works.
});

test("env restore handles undefined correctly (regression for originalDryRun bug)", () => {
  const saved = process.env.DRY_RUN;
  // Force the undefined path
  delete process.env.DRY_RUN;
  restoreDryRun(undefined);
  if (process.env.DRY_RUN !== undefined) {
    throw new Error("restoreDryRun(undefined) did not delete env");
  }
  // Also verify defined-path restore
  process.env.DRY_RUN = "true";
  restoreDryRun("true");
  if (process.env.DRY_RUN !== "true") {
    throw new Error("restoreDryRun('true') did not restore env");
  }
  // Cleanup
  restoreDryRun(saved);
});

// Restore
restoreDryRun(originalDryRun);

console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(fail > 0 ? 1 : 0);
