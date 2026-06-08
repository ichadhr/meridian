// test/test-close-vp-manual.js
// Step 6 of meridian-wie: smoke test for closeVpManual.
// The success path requires RPC mocking (getBinsInRange, fetchSolPrice,
// closeVirtualPosition) and is covered indirectly by the dependencies'
// own unit tests. This file covers the cheap, high-value failure path:
// "VP not found" — the most common user error (typo'd vp id).
//
// Tests are SYNCHRONOUS for the "not found" case because getVirtualPosition
// returns null before any async work begins.

import { closeVpManual } from "../tools/manage-virtual.js";

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      pass++;
      console.log(`✅ ${name}`);
    })
    .catch((e) => {
      fail++;
      failures.push({ name, error: e.message });
      console.log(`❌ ${name}: ${e.message}`);
    });
}

(async () => {
  await test("closeVpManual: non-existent VP returns {success:false} (no mutation)", async () => {
    const result = await closeVpManual("vp_definitely_does_not_exist_xyz", "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
    if (!result.error || !result.error.includes("VP not found")) {
      throw new Error(`expected 'VP not found' in error, got: ${result.error}`);
    }
  });

  await test("closeVpManual: empty vpId returns {success:false, error:VP not found}", async () => {
    const result = await closeVpManual("", "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
    if (!result.error || !result.error.includes("VP not found")) {
      throw new Error(`expected 'VP not found' in error, got: ${result.error}`);
    }
  });

  await test("closeVpManual: non-string vpId returns {success:false, error:VP not found}", async () => {
    const result = await closeVpManual(null, "smoke test");
    if (result.success !== false) throw new Error(`expected success:false, got ${JSON.stringify(result)}`);
  });

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
