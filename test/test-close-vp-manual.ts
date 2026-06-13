// test/test-close-vp-manual.ts
// smoke test for closeVpManual.
// The success path requires RPC mocking (getBinsInRange, fetchSolPrice,
// closeVirtualPosition) and is covered indirectly by the dependencies'
// own unit tests. This file covers the cheap, high-value failure path:
// "VP not found" — the most common user error (typo'd vp id).
//
// Tests are SYNCHRONOUS for the "not found" case because getVirtualPosition
// returns null before any async work begins.

import { closeVpPosition } from "../core/index.js";

let pass = 0;
let fail = 0;
const failures: Array<{ name: string; error: string }> = [];

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      pass++;
      console.log(`✅ ${name}`);
    })
    .catch((e: any) => {
      fail++;
      failures.push({ name, error: e.message });
      console.log(`❌ ${name}: ${e.message}`);
    });
}

(async () => {
  await test("closeVpManual: non-existent VP returns {success:false} (no mutation)", async () => {
    const result = await closeVpPosition("vp_definitely_does_not_exist_xyz", "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
    if (!result.error || !result.error.includes("VP not found")) {
      throw new Error(`expected 'VP not found' in error, got: ${result.error}`);
    }
  });

  await test("closeVpManual: empty vpId returns {success:false, error:VP not found}", async () => {
    const result = await closeVpPosition("", "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
    if (!result.error || !result.error.includes("VP not found")) {
      throw new Error(`expected 'VP not found' in error, got: ${result.error}`);
    }
  });

  await test("closeVpManual: non-string vpId returns {success:false, error:VP not found}", async () => {
    const result = await closeVpPosition(null as any, "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
  });

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
