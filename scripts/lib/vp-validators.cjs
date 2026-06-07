#!/usr/bin/env node
// Shared validation library for vp-archive records.
// Provides math (internal consistency) and Meteora (external cross-check) passes.
//
// Usage:
//   const { loadArchive, filterVpIso, runMathValidation, runMeteoraValidation } = require('./lib/vp-validators');
//
// Exits are NOT handled by this lib — callers (entry-point scripts) print and exit.

const fs = require('fs');
const path = require('path');

const ARCHIVES_DIR = path.join(__dirname, '..', '..', 'archives');
const TOL_PCT = 0.5;          // 0.5% tolerance for USD/SOL calcs
const TOL_MIN = 0.5;          // 0.5 min tolerance for time calcs
const TOL_PCT_TIGHT = 0.05;   // 0.05% for percent fields
const METEORA_BASE = 'https://dlmm.datapi.meteora.ag';

function loadArchive() {
  const files = fs.readdirSync(ARCHIVES_DIR)
    .filter((f) => /^vp-archive-\d{4}-\d{2}\.jsonl$/.test(f));
  const records = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(ARCHIVES_DIR, file), 'utf8').trim();
    if (!content) continue;
    for (const line of content.split('\n')) {
      records.push(JSON.parse(line));
    }
  }
  return records;
}

function filterVpIso(records) {
  return records.filter((r) => /^vp-\d{8}T\d{6}Z$/.test(r.id));
}

function _pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  if (a === 0 || b === 0) return Infinity;
  return Math.abs((a - b) / a) * 100;
}

function runMathValidation(records) {
  const issues = [];
  function check(id, field, severity, msg, actual, expected) {
    issues.push({ id, field, severity, msg, actual, expected });
  }

  for (const r of records) {
    const id = r.id;

    // T1: initial_value_usd ≈ amount_sol × sol_price_at_deploy
    const expectedInitUsd = r.amount_sol * r.sol_price_at_deploy;
    const initUsdDiff = _pctDiff(r.initial_value_usd, expectedInitUsd);
    if (initUsdDiff > TOL_PCT) {
      check(id, 'initial_value_usd', 'CRITICAL',
        `initial_value_usd (${r.initial_value_usd.toFixed(4)}) ≠ amount_sol × sol_price_at_deploy (${expectedInitUsd.toFixed(4)}), diff ${initUsdDiff.toFixed(2)}%`,
        r.initial_value_usd, expectedInitUsd);
    }

    // T2: minutes_held ≈ (closed_at - deployed_at) / 60000
    const actualMin = (new Date(r.closed_at) - new Date(r.deployed_at)) / 60000;
    const minDiff = Math.abs(actualMin - r.minutes_held);
    if (minDiff > TOL_MIN) {
      check(id, 'minutes_held', 'WARN',
        `minutes_held (${r.minutes_held}) ≠ (closed_at - deployed_at) / 60000 (${actualMin.toFixed(1)}), diff ${minDiff.toFixed(1)} min`,
        r.minutes_held, actualMin);
    }

    // T3: close_pnl_pct ≈ close_pnl_usd / initial_value_usd × 100
    const expectedPnlPct = (r.close_pnl_usd / r.initial_value_usd) * 100;
    const pnlPctDiff = _pctDiff(r.close_pnl_pct, expectedPnlPct);
    if (pnlPctDiff > TOL_PCT_TIGHT) {
      check(id, 'close_pnl_pct', 'CRITICAL',
        `close_pnl_pct (${r.close_pnl_pct.toFixed(4)}) ≠ close_pnl_usd / initial_value_usd × 100 (${expectedPnlPct.toFixed(4)}), diff ${pnlPctDiff.toFixed(3)}%`,
        r.close_pnl_pct, expectedPnlPct);
    }

    // T4: close_pnl_sol_pct ≈ close_pnl_sol / amount_sol × 100
    const expectedPnlSolPct = (r.close_pnl_sol / r.amount_sol) * 100;
    const pnlSolPctDiff = _pctDiff(r.close_pnl_sol_pct, expectedPnlSolPct);
    if (pnlSolPctDiff > TOL_PCT_TIGHT) {
      check(id, 'close_pnl_sol_pct', 'CRITICAL',
        `close_pnl_sol_pct (${r.close_pnl_sol_pct.toFixed(4)}) ≠ close_pnl_sol / amount_sol × 100 (${expectedPnlSolPct.toFixed(4)}), diff ${pnlSolPctDiff.toFixed(3)}%`,
        r.close_pnl_sol_pct, expectedPnlSolPct);
    }

    // T5: close_cost_sol vs |IL| + fees
    const expectedCostSol = Math.abs(r.close_il_sol) + r.close_fees_sol;
    const costSolDiff = _pctDiff(r.close_cost_sol, expectedCostSol);
    if (costSolDiff > TOL_PCT) {
      check(id, 'close_cost_sol', 'INFO',
        `close_cost_sol (${r.close_cost_sol.toFixed(6)}) vs |IL| + fees (${expectedCostSol.toFixed(6)}), diff ${costSolDiff.toFixed(2)}%`,
        r.close_cost_sol, expectedCostSol);
    }

    // T6: close_cost_usd ≈ |close_il_usd| + close_fees_usd
    const expectedCostUsd = Math.abs(r.close_il_usd) + r.close_fees_usd;
    const costUsdDiff = _pctDiff(r.close_cost_usd, expectedCostUsd);
    if (costUsdDiff > TOL_PCT) {
      check(id, 'close_cost_usd', 'INFO',
        `close_cost_usd (${r.close_cost_usd.toFixed(4)}) vs |IL_usd| + fees_usd (${expectedCostUsd.toFixed(4)}), diff ${costUsdDiff.toFixed(2)}%`,
        r.close_cost_usd, expectedCostUsd);
    }

    // T7: bin_step in valid set
    if (![80, 100, 125].includes(r.bin_step)) {
      check(id, 'bin_step', 'WARN',
        `bin_step (${r.bin_step}) not in {80, 100, 125}`,
        r.bin_step, 'one of [80, 100, 125]');
    }

    // T8: lower_bin < upper_bin
    if (r.lower_bin >= r.upper_bin) {
      check(id, 'bin_range', 'CRITICAL',
        `lower_bin (${r.lower_bin}) >= upper_bin (${r.upper_bin})`,
        r.lower_bin, '< ' + r.upper_bin);
    }

    // T9: active_bin_at_deploy in range
    if (r.active_bin_at_deploy < r.lower_bin || r.active_bin_at_deploy > r.upper_bin) {
      check(id, 'active_bin', 'WARN',
        `active_bin_at_deploy (${r.active_bin_at_deploy}) outside [${r.lower_bin}, ${r.upper_bin}]`,
        r.active_bin_at_deploy, `[${r.lower_bin}, ${r.upper_bin}]`);
    }

    // T10: close_fees_usd/close_fees_sol should track SOL price (within 50%)
    const solPriceDeploy = r.sol_price_at_deploy;
    const solPriceImpliedClose = r.amount_sol > 0 && r.close_fees_sol !== 0
      ? r.close_fees_usd / r.close_fees_sol
      : null;
    if (solPriceImpliedClose !== null) {
      const solPriceDrift = _pctDiff(solPriceImpliedClose, solPriceDeploy);
      if (solPriceDrift > 50) {
        check(id, 'fees_usd_sol_ratio', 'INFO',
          `close_fees_usd/close_fees_sol = ${solPriceImpliedClose.toFixed(2)} (vs deploy ${solPriceDeploy.toFixed(2)}), drift ${solPriceDrift.toFixed(1)}%`,
          r.close_fees_usd, `should match deploy SOL price`);
      }
    }

    // T11: total_fees_earned_usd ≈ close_fees_usd (or null is acceptable, with WARN)
    if (r.total_fees_earned_usd == null) {
      check(id, 'total_fees_earned_usd', 'WARN',
        `total_fees_earned_usd is null`,
        null, r.close_fees_usd);
    } else {
      const feesDiff = _pctDiff(r.total_fees_earned_usd, r.close_fees_usd);
      if (feesDiff > TOL_PCT) {
        check(id, 'total_fees_earned_usd', 'INFO',
          `total_fees_earned_usd (${r.total_fees_earned_usd.toFixed(4)}) ≠ close_fees_usd (${r.close_fees_usd.toFixed(4)}), diff ${feesDiff.toFixed(2)}%`,
          r.total_fees_earned_usd, r.close_fees_usd);
      }
    }

    // T12: range width sanity — typical bin range should be 35-200 bins
    const range = r.upper_bin - r.lower_bin;
    if (range < 35) {
      check(id, 'bin_range_width', 'WARN',
        `bin range width (${range}) below minimum 35`,
        range, '>= 35');
    } else if (range > 200) {
      check(id, 'bin_range_width', 'WARN',
        `bin range width (${range}) unusually large`,
        range, '<= 200');
    }

    // T13: USD/SOL final value consistency
    const finalValueUsd = r.initial_value_usd + r.close_pnl_usd;
    const finalValueSol = r.amount_sol + r.close_pnl_sol;
    if (finalValueSol > 0 && finalValueUsd > 0) {
      const impliedCloseSolPrice = finalValueUsd / finalValueSol;
      const drift = _pctDiff(impliedCloseSolPrice, solPriceDeploy);
      if (drift > 30) {
        check(id, 'sol_price_implied', 'INFO',
          `implied close SOL price (${impliedCloseSolPrice.toFixed(2)}) drifts ${drift.toFixed(1)}% from deploy price (${solPriceDeploy.toFixed(2)})`,
          impliedCloseSolPrice, solPriceDeploy);
      }
    } else {
      check(id, 'final_values', 'WARN',
        `non-positive final values: final_usd=${finalValueUsd.toFixed(4)}, final_sol=${finalValueSol.toFixed(6)}`,
        { finalValueUsd, finalValueSol }, 'both > 0');
    }
  }

  const bySeverity = { CRITICAL: 0, WARN: 0, INFO: 0 };
  const byField = {};
  const recordsWithIssues = new Set();
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    byField[issue.field] = (byField[issue.field] || 0) + 1;
    recordsWithIssues.add(issue.id);
  }

  const wins = records.filter((r) => r.close_pnl_usd > 0);
  const losses = records.filter((r) => r.close_pnl_usd < 0);
  const totalPnlUsd = records.reduce((s, r) => s + r.close_pnl_usd, 0);
  const totalFeesUsd = records.reduce((s, r) => s + r.close_fees_usd, 0);
  const totalIlUsd = records.reduce((s, r) => s + r.close_il_usd, 0);
  const totalPnlSol = records.reduce((s, r) => s + r.close_pnl_sol, 0);
  const avgHoldMin = records.reduce((s, r) => s + r.minutes_held, 0) / records.length;
  const stats = {
    wins: wins.length,
    losses: losses.length,
    totalPnlUsd,
    totalFeesUsd,
    totalIlUsd,
    totalPnlSol,
    avgHoldMin,
  };

  return { issues, summary: bySeverity, byField, recordsWithIssues, stats };
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function runMeteoraValidation(records) {
  const byPool = {};
  for (const r of records) {
    if (!byPool[r.pool]) byPool[r.pool] = [];
    byPool[r.pool].push(r);
  }

  const issues = [];
  const poolResults = [];
  let totalChecked = 0;

  for (const [poolAddr, poolRecords] of Object.entries(byPool)) {
    let pool;
    try {
      pool = await fetchJson(`${METEORA_BASE}/pools/${poolAddr}`);
    } catch (e) {
      issues.push({ id: poolRecords[0].id, severity: 'FAIL', msg: `Pool not found: ${e.message}` });
      poolResults.push({
        poolAddr, name: poolRecords[0].pool_name,
        error: e.message, recordCount: poolRecords.length,
      });
      continue;
    }
    const poolBinStep = pool.pool_config?.bin_step;

    const minTs = Math.floor(Math.min(...poolRecords.map((r) => new Date(r.deployed_at).getTime())) / 1000);
    const maxTs = Math.ceil(Math.max(...poolRecords.map((r) => new Date(r.closed_at).getTime())) / 1000);

    const CHUNK_HOURS = 3;
    const chunks = [];
    for (let t = minTs; t < maxTs; t += CHUNK_HOURS * 3600) {
      chunks.push({ start: t, end: Math.min(t + CHUNK_HOURS * 3600, maxTs) });
    }

    const allCandles = [];
    for (const { start, end } of chunks) {
      try {
        const data = await fetchJson(`${METEORA_BASE}/pools/${poolAddr}/ohlcv?timeframe=5m&start_time=${start}&end_time=${end}`);
        if (data.data) allCandles.push(...data.data);
      } catch (e) {
        try {
          const data = await fetchJson(`${METEORA_BASE}/pools/${poolAddr}/ohlcv?timeframe=1h&start_time=${start}&end_time=${end}`);
          if (data.data) allCandles.push(...data.data);
        } catch (e2) {
          // skip chunk
        }
      }
    }

    if (allCandles.length === 0) {
      issues.push({ id: poolRecords[0].id, severity: 'FAIL', msg: 'No OHLCV data available' });
      poolResults.push({
        poolAddr, name: pool.name, binStep: poolBinStep,
        candleCount: 0, chunkCount: chunks.length, recordCount: poolRecords.length,
        poolIssues: poolRecords.length,
      });
      continue;
    }

    let poolIssues = 0;
    for (const r of poolRecords) {
      totalChecked++;
      const id = r.id;
      const deployTs = new Date(r.deployed_at).getTime() / 1000;
      const closeTs = new Date(r.closed_at).getTime() / 1000;
      const recordIssues = [];

      // Check 1: time coverage
      const firstTs = allCandles[0].timestamp;
      const lastTs = allCandles[allCandles.length - 1].timestamp + 300;
      if (deployTs < firstTs - 60) recordIssues.push(`deploy ${(firstTs - deployTs).toFixed(0)}s before OHLCV`);
      if (closeTs > lastTs + 60) recordIssues.push(`close ${(closeTs - lastTs).toFixed(0)}s after OHLCV`);

      // Check 2: pool had volume in the VP window
      const windowCandles = allCandles.filter((c) => c.timestamp >= deployTs - 300 && c.timestamp <= closeTs);
      if (windowCandles.length === 0) {
        recordIssues.push('no OHLCV candles in VP window');
      } else {
        const totalVol = windowCandles.reduce((s, c) => s + (c.volume || 0), 0);
        if (totalVol === 0) recordIssues.push('zero volume in VP window (pool was dead?)');
      }

      // Check 3: bin_step
      if (poolBinStep !== r.bin_step) recordIssues.push(`bin_step ${r.bin_step} ≠ pool ${poolBinStep}`);

      // Check 4: token price was non-zero and moving
      if (windowCandles.length > 0) {
        const prices = windowCandles.flatMap((c) => [c.open, c.high, c.low, c.close]).filter((v) => v > 0);
        if (prices.length === 0) {
          recordIssues.push('all prices zero in VP window');
        } else {
          const minP = Math.min(...prices);
          const maxP = Math.max(...prices);
          if (minP === maxP && windowCandles.length > 2) {
            recordIssues.push(`price completely flat across ${windowCandles.length} candles (suspicious)`);
          }
        }
      }

      if (recordIssues.length > 0) {
        poolIssues++;
        issues.push({ id, severity: 'WARN', msg: recordIssues.join('; ') });
      }
    }

    poolResults.push({
      poolAddr, name: pool.name, binStep: poolBinStep,
      candleCount: allCandles.length, chunkCount: chunks.length,
      recordCount: poolRecords.length, poolIssues,
    });
  }

  const summary = { FAIL: 0, WARN: 0 };
  for (const issue of issues) summary[issue.severity] = (summary[issue.severity] || 0) + 1;

  return { issues, summary, poolResults, totalChecked };
}

module.exports = {
  loadArchive,
  filterVpIso,
  runMathValidation,
  runMeteoraValidation,
  // exposed for testing/advanced use
  _pctDiff,
  _tolerances: { TOL_PCT, TOL_MIN, TOL_PCT_TIGHT },
};
