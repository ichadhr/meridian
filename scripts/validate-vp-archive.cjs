#!/usr/bin/env node
// validate-vp-archive.cjs
// Consolidated validation for vp-archive records.
// Runs two passes:
//   1. MATH: internal consistency (PnL, fees, IL, bin ranges, USD/SOL ratios)
//   2. METEORA: external cross-check (pool existence, OHLCV coverage, volume, price movement)
//
// Usage: node scripts/validate-vp-archive.cjs
// Exits 0 regardless of issues found (matches original script behavior).
//
// Replaces:
//   - scripts/validate-vp-archive-calculations.cjs (math pass)
//   - scripts/validate-vp-against-meteora-history.cjs (Meteora pass)

const {
  loadArchive,
  filterVpIso,
  runMathValidation,
  runMeteoraValidation,
} = require('./lib/vp-validators.cjs');

(async () => {
  const allRecords = loadArchive();
  const records = filterVpIso(allRecords);
  console.log(`Total records: ${allRecords.length}`);
  console.log(`  vp-ISO (new format): ${records.length}`);
  console.log('');

  // ===== MATH VALIDATION =====
  console.log(`=== MATH VALIDATION (${records.length} vp-ISO records) ===`);
  console.log('');

  const math = runMathValidation(records);
  const { issues: mathIssues, summary: mathSummary, byField, recordsWithIssues, stats } = math;

  console.log('Issues by severity:');
  console.log(`  CRITICAL: ${mathSummary.CRITICAL || 0}`);
  console.log(`  WARN:     ${mathSummary.WARN || 0}`);
  console.log(`  INFO:     ${mathSummary.INFO || 0}`);
  console.log(`  Records with at least one issue: ${recordsWithIssues.size} / ${records.length}`);
  console.log('');

  if (mathSummary.CRITICAL > 0 || mathSummary.WARN > 0) {
    console.log('Issues by field:');
    for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field}: ${count}`);
    }
    console.log('');

    console.log('=== ISSUES DETAIL ===');
    console.log('');
    for (const issue of mathIssues) {
      if (issue.severity === 'CRITICAL' || issue.severity === 'WARN') {
        console.log(`[${issue.severity}] ${issue.id} :: ${issue.field}`);
        console.log(`  ${issue.msg}`);
        console.log('');
      }
    }
  }

  console.log('=== INFO-LEVEL NOTES (cosmetic) ===');
  console.log('');
  for (const issue of mathIssues) {
    if (issue.severity === 'INFO') {
      console.log(`[INFO] ${issue.id} :: ${issue.field}: ${issue.msg}`);
    }
  }

  console.log('');
  console.log('=== STATISTICAL SUMMARY ===');
  console.log(`Wins: ${stats.wins}, Losses: ${stats.losses}, Win rate: ${((stats.wins / records.length) * 100).toFixed(1)}%`);
  console.log(`Total PnL: ${stats.totalPnlUsd.toFixed(2)} USD (${stats.totalPnlSol.toFixed(4)} SOL)`);
  console.log(`Total fees: ${stats.totalFeesUsd.toFixed(2)} USD`);
  console.log(`Total IL: ${stats.totalIlUsd.toFixed(2)} USD`);
  console.log(`Avg hold: ${stats.avgHoldMin.toFixed(1)} min`);
  console.log(`PnL = fees + IL? ${stats.totalPnlUsd.toFixed(4)} vs ${(stats.totalFeesUsd + stats.totalIlUsd).toFixed(4)}, diff ${(stats.totalPnlUsd - stats.totalFeesUsd - stats.totalIlUsd).toFixed(4)}`);

  // ===== METEORA VALIDATION =====
  console.log('');
  console.log('='.repeat(70));
  console.log('=== METEORA VALIDATION ===');
  console.log('='.repeat(70));
  console.log('');

  const meteora = await runMeteoraValidation(records);
  const { issues: meteoraIssues, poolResults, totalChecked } = meteora;

  for (const pr of poolResults) {
    console.log('='.repeat(70));
    console.log(`Pool: ${pr.poolAddr.slice(0, 20)}... (${pr.name}, ${pr.recordCount} records)`);
    console.log('='.repeat(70));
    if (pr.error) {
      console.log(`  [FAIL] Pool not found: ${pr.error}`);
    } else {
      console.log(`  Pool bin_step: ${pr.binStep}`);
      console.log(`  OHLCV candles fetched: ${pr.candleCount} across ${pr.chunkCount} chunk(s)`);
      if (pr.poolIssues === 0) {
        console.log(`  ✓ All ${pr.recordCount} records pass validation`);
      } else {
        console.log(`  ${pr.poolIssues}/${pr.recordCount} records had issues`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(70));
  console.log(`SUMMARY: ${totalChecked} records checked, ${meteoraIssues.length} had issues`);
  console.log('='.repeat(70));
})();
