/**
 * Generate a self-contained HTML calendar report from dry-run state + archive files.
 *
 * Usage:
 *   import { generateDryRunReport } from "./tools/generate-dry-run-report.js";
 *   const html = await generateDryRunReport();
 *   fs.writeFileSync("dry-run-report.html", html);
 */
import { log } from "../../utils/logger.js";
import { readArchive } from "../archive.js";
import { archiveVirtualPositions } from "./state.js";

/** A closed virtual-position record from the JSONL archive. */
export interface ClosedPosition {
  pair?: string;
  pool?: string;
  pool_name?: string;
  base_mint?: string;
  deployed_at?: string;
  closed_at?: string;
  close_reason?: string;
  close_pnl_usd?: number;
  close_pnl_pct?: number;
  close_pnl_sol?: number;
  close_pnl_sol_pct?: number;
  sol_price_at_deploy?: number;
  [key: string]: unknown;
}

/** Best/worst day stats per currency. */
interface DayStat {
  date: string | null;
  pnlUsd: number;
  pnlSol: number;
}

/** Return type for computeStats. */
interface Stats {
  totalPnlUsd: number;
  totalPnlSol: number;
  totalPositions: number;
  winRate: number;
  avgReturnUsd: number;
  bestDay: DayStat;
  worstDay: DayStat;
}

/** Currency-total pair produced by sumPnlByCurrency. */
interface CurrencyTotal {
  usd: number;
  sol: number;
}

/** Day data structure for JSON embedding in the browser-side script. */
interface DayData {
  totalUsd: number;
  totalSol: number;
  positions: string[];
}

/** Load all closed positions from the JSONL archive. */
async function loadAllClosedPositions(): Promise<ClosedPosition[]> {
  // Reconcile first: move any closed VPs still in dry-run-state.json to the
  // archive, and dedupe the current-month archive. Both are idempotent.
  // This guarantees a single source of truth (archive) and no duplicates.
  try {
    archiveVirtualPositions();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("dry_run_report", `Reconcile sweep failed: ${msg}`);
  }

  const all: ClosedPosition[] = [];
  try {
    const vpRecords = await readArchive({ source: "paper", hours: 720, limit: 5000 });
    for (const r of vpRecords) {
      (r as Record<string, unknown>)._from_archive = "archives";
      all.push(r as ClosedPosition);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("dry_run_report", `Failed to read VP archives: ${msg}`);
  }
  return all;
}

/** Group positions by UTC date (YYYY-MM-DD) from closed_at. */
function groupByDay(positions: ClosedPosition[]): Map<string, ClosedPosition[]> {
  const days = new Map<string, ClosedPosition[]>();
  for (const vp of positions) {
    const date = (vp.closed_at || "").slice(0, 10); // "2026-06-15"
    if (!date) continue;
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(vp);
  }
  return days;
}

/** Build a summary stats object from all daily groups. */
function computeStats(days: Map<string, ClosedPosition[]>): Stats {
  let totalPnlUsd = 0;
  let totalPnlSol = 0;
  let wins = 0;
  let losses = 0;
  // Best/worst day ranked by USD (most familiar), but both currencies are returned.
  // Best/worst day ranked by USD: USD is the more familiar concrete number for
  // most users, and it's the only currency guaranteed for legacy USD-only positions.
  // Both currencies are returned so the display can show them side-by-side.
  let bestDay: DayStat = { date: null, pnlUsd: -Infinity, pnlSol: 0 };
  let worstDay: DayStat = { date: null, pnlUsd: Infinity, pnlSol: 0 };

  for (const [date, positions] of days) {
    const { usd, sol } = sumPnlByCurrency(positions);
    totalPnlUsd += usd;
    totalPnlSol += sol;
    for (const p of positions) {
      // Win/loss uses primary currency (SOL sign for SOL positions, USD otherwise).
      const pnl = isSolPosition(p) ? (p.close_pnl_sol || 0) : (p.close_pnl_usd || 0);
      if (pnl >= 0) wins++;
      else losses++;
    }
    if (usd > bestDay.pnlUsd) bestDay = { date, pnlUsd: usd, pnlSol: sol };
    if (usd < worstDay.pnlUsd) worstDay = { date, pnlUsd: usd, pnlSol: sol };
  }

  const total = wins + losses;
  return {
    totalPnlUsd,
    totalPnlSol,
    totalPositions: total,
    winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    // Avg return: USD as the default (most positions are USD, and SOL is shown separately)
    avgReturnUsd: total > 0 ? totalPnlUsd / total : 0,
    bestDay,
    worstDay,
  };
}

/** Build HTML for a single position list item. */
function positionHtml(vp: ClosedPosition): string {
  // Color tracks the primary currency: SOL sign for SOL positions, USD for USD.
  const primaryPnl = isSolPosition(vp) ? (vp.close_pnl_sol || 0) : (vp.close_pnl_usd || 0);
  const cls = primaryPnl >= 0 ? "positive" : "negative";
  const reason = (vp.close_reason || "").replace(/_/g, " ");
  const pair = vp.pair || vp.pool?.slice(0, 8) || "?";

  // Duration
  let duration = "?";
  if (vp.deployed_at && vp.closed_at) {
    const ms = new Date(vp.closed_at).getTime() - new Date(vp.deployed_at).getTime();
    if (ms > 0) {
      const h = Math.floor(ms / 3600000);
      const d = Math.floor(h / 24);
      duration = d >= 1 ? `${d}d ${h % 24}h` : `${h}h`;
    }
  }

  // PnL percentage (use close_pnl_sol_pct for SOL positions, close_pnl_pct for USD)
  const pnlPct = isSolPosition(vp) ? vp.close_pnl_sol_pct : vp.close_pnl_pct;
  const pctStr = pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${Math.abs(pnlPct).toFixed(2)}%)` : "";

  return `<div class="pos-item">
    <div>
      <div class="pos-name">${escapeHtml(pair)} <span class="pos-reason">${escapeHtml(reason)}</span></div>
      <div class="pos-meta">${duration} hold${pctStr}</div>
    </div>
    <div class="pos-pnl ${cls}">${formatPnl(vp)}</div>
  </div>`;
}

function escapeHtml(s: unknown): string {
  if (typeof s !== "string") return String(s ?? "");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A position is SOL-denominated if it has a SOL price captured at deploy time. */
function isSolPosition(vp: ClosedPosition): boolean {
  return (vp?.sol_price_at_deploy ?? 0) > 0;
}

// Module-level helpers (DRY: used by formatPnl, formatCurrencyTotal, buildMonths)
const fmtSign = (n: number): string => n >= 0 ? "+" : "-";
const fmtAbs = (n: number): string => Math.abs(n).toFixed(2);

/** Format a position's PnL for display, honoring its primary currency. */
function formatPnl(vp: ClosedPosition): string {
  if (isSolPosition(vp)) {
    const sol = vp.close_pnl_sol || 0;
    const usd = vp.close_pnl_usd || 0;
    return `${fmtSign(sol)}${fmtAbs(sol)} SOL <span class="pnl-usd">(${fmtSign(usd)}$${fmtAbs(usd)})</span>`;
  }
  const usd = vp.close_pnl_usd || 0;
  return `${fmtSign(usd)}$${fmtAbs(usd)}`;
}

/** Sum PnL across an array of positions, separating by currency. */
function sumPnlByCurrency(positions: ClosedPosition[]): CurrencyTotal {
  let usd = 0;
  let sol = 0;
  for (const p of positions) {
    usd += p.close_pnl_usd || 0;
    if (isSolPosition(p)) sol += p.close_pnl_sol || 0;
  }
  return { usd, sol };
}

/** Format a {usd, sol} totals object for headers/modals/calendar cells. */
function formatCurrencyTotal({ usd, sol }: CurrencyTotal): string {
  const parts = [`${fmtSign(usd)}$${fmtAbs(usd)}`];
  if (sol !== 0) parts.push(`${fmtSign(sol)}${fmtAbs(sol)} SOL`);
  return parts.join(" / ");
}

/** Generate the full self-contained HTML report. */
export async function generateDryRunReport(): Promise<string> {
  const positions = await loadAllClosedPositions();
  if (positions.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dry Run Report</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#888;padding:40px;text-align:center;margin-top:80px}h2{color:#fff}</style></head><body><h2>No closed positions yet</h2><p>Dry run has not closed any positions. Deploy first, then check back.</p></body></html>`;
  }

  const days = groupByDay(positions);
  const stats = computeStats(days);

  // Sort days chronologically
  const sortedDates = [...days.keys()].sort();

  // Build calendar months
  const months = buildMonths(sortedDates, days);

  const bestStr = stats.bestDay.date ? formatCurrencyTotal({ usd: stats.bestDay.pnlUsd, sol: stats.bestDay.pnlSol }) : "—";
  const worstStr = stats.worstDay.date ? formatCurrencyTotal({ usd: stats.worstDay.pnlUsd, sol: stats.worstDay.pnlSol }) : "—";
  const totalCls = stats.totalPnlUsd >= 0 ? "positive" : "negative";
  const avgCls = stats.avgReturnUsd >= 0 ? "positive" : "negative";
  const bestCls = stats.bestDay.pnlUsd >= 0 ? "positive" : "negative";
  const worstCls = stats.worstDay.pnlUsd >= 0 ? "positive" : "negative";
  const statsHtml = `
    <div class="stat"><div class="stat-lbl">Total PnL</div><div class="stat-val ${totalCls}" style="font-size:16px">${formatCurrencyTotal({ usd: stats.totalPnlUsd, sol: stats.totalPnlSol })}</div></div>
    <div class="stat"><div class="stat-lbl">Win Rate</div><div class="stat-val neutral">${stats.winRate}%</div></div>
    <div class="stat"><div class="stat-lbl">Avg Return</div><div class="stat-val ${avgCls}" style="font-size:16px">${formatCurrencyTotal({ usd: stats.avgReturnUsd, sol: 0 })}</div></div>
    <div class="stat">
      <div class="stat-lbl">Best / Worst</div>
      <div class="best-worst">
        <div class="bw-row"><span class="bw-label">Best</span><span class="bw-val ${bestCls}">${bestStr}</span></div>
        <div class="bw-row"><span class="bw-label">Worst</span><span class="bw-val ${worstCls}">${worstStr}</span></div>
      </div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dry Run PnL Calendar</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;padding:40px}
  .dash{max-width:900px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
  .hdr h1{font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px}
  .hdr .sub{color:#666;font-size:13px;margin-top:2px}
  .nav{display:flex;gap:8px}
  .nav button{background:#1a1a24;border:1px solid #2a2a35;color:#999;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}
  .nav button:hover{background:#252530;color:#fff}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
  .stat{background:#12121a;border:1px solid #1e1e2a;border-radius:12px;padding:18px;transition:border-color .15s,transform .15s}
  .stat:hover{border-color:#2a2a35;transform:translateY(-1px)}
  .stat-lbl{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.6px;font-weight:600}
  .stat-val{font-size:24px;font-weight:700;margin-top:8px;line-height:1.15;letter-spacing:-0.3px}
  .best-worst{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .bw-row{display:flex;flex-direction:column;gap:2px}
  .bw-label{font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;font-weight:600}
  .bw-val{font-size:15px;font-weight:700;letter-spacing:-0.2px}
.bw-val.positive{color:#4ade80}
.bw-val.negative{color:#f87171}
  .stat-val.positive{color:#4ade80}
  .stat-val.negative{color:#f87171}
  .stat-val.neutral{color:#e0e0e0}
  .stat-val .positive{color:#4ade80}
  .stat-val .negative{color:#f87171}
  .month{margin-bottom:32px}
  .month-title{font-size:14px;font-weight:600;color:#777;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.3px}
  .cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}
  .dh{text-align:center;font-size:10px;color:#444;text-transform:uppercase;padding:4px 0;letter-spacing:0.5px}
  .day{background:#12121a;border:1px solid #1e1e2a;border-radius:8px;aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all .12s;position:relative;min-height:72px;min-width:72px;padding:5px}
  .day:hover{border-color:#3a3a4a;transform:translateY(-1px)}
  .day .dn{font-size:10px;color:#555;position:absolute;top:5px;left:7px;font-weight:500}
  .day .pnl{font-size:13px;font-weight:600}
  .day .pnl.pos{color:#4ade80}
  .day .pnl.neg{color:#f87171}
  .day .ct{font-size:9px;color:#555;margin-top:2px}
  .day.empty{background:0 0;border:none;cursor:default}
  .day.empty:hover{transform:none}
  .day.iv{background:#1a2e1a;border-color:#2a5e2a}
  .day.hv{background:#162216;border-color:#224422}
  .day.mv{background:#121c12;border-color:#1d331d}
  .day.lv{background:#0f180f;border-color:#1a2e1a}
  .day.ln{background:#1a0f0f;border-color:#3a1a1a}
  .day.mn{background:#221212;border-color:#442222}
  .day.hn{background:#2e1414;border-color:#5e2222}
  .legend{display:flex;gap:16px;margin-top:16px;justify-content:center}
  .legend-item{display:flex;align-items:center;gap:5px;font-size:11px;color:#666}
  .swatch{width:12px;height:12px;border-radius:3px;border:1px solid #2a2a35}
  .swatch.g{background:#1a2e1a}
  .swatch.r{background:#2e1414}
  .swatch.n{background:#12121a}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);align-items:center;justify-content:center;z-index:100}
  .modal-overlay.active{display:flex}
  .modal{background:#12121a;border:1px solid #2a2a35;border-radius:12px;width:90%;max-width:520px;max-height:80vh;overflow-y:auto;padding:24px}
  .modal h2{font-size:15px;color:#fff;margin-bottom:2px}
  .modal .md{font-size:12px;color:#666;margin-bottom:16px}
  .mc{background:0 0;float:right;border:none;color:#666;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:4px}
  .mc:hover{background:#1e1e2a;color:#fff}
  .pos-item{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e1e2a}
  .pos-item:last-child{border-bottom:none}
  .pos-name{font-size:13px;font-weight:500;color:#e0e0e0}
  .pos-meta{font-size:11px;color:#666;margin-top:2px}
  .pos-reason{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;background:#1e1e2a;color:#888;margin-left:6px}
  .pos-pnl{font-size:13px;font-weight:600}
  .pos-pnl.positive{color:#4ade80}
  .pos-pnl.negative{color:#f87171}
  .f{font-size:11px;color:#555;text-align:center;margin-top:24px}
  @media(max-width:900px){.dash{max-width:100%}.summary{grid-template-columns:repeat(2,1fr)}.day{min-height:60px}}
  @media(max-width:480px){body{padding:14px}.summary{grid-template-columns:1fr 1fr;gap:8px}.stat{padding:12px}.stat-val{font-size:18px}.bw-val{font-size:13px}.cal{gap:2px}.day{min-height:0;min-width:0;padding:2px}.day .pnl{font-size:10px}.day .ct{font-size:7px}.day .dn{font-size:8px;top:3px;left:4px}.dh{font-size:8px;padding:2px 0}.hdr{flex-direction:column;align-items:flex-start;gap:10px}.hdr h1{font-size:17px}.nav button{padding:5px 10px;font-size:12px}.pos-item{padding:8px 0}.pos-name{font-size:12px}.pos-meta{font-size:10px}.modal{padding:16px}.modal h2{font-size:14px}.pos-reason{display:block;margin-left:0;width:fit-content;margin-top:3px}.pos-pnl{display:flex;flex-direction:column;align-items:flex-end;gap:1px}.pnl-usd{font-size:11px;opacity:.7}}
</style>
</head>
<body>
<div class="dash">
  <div class="hdr">
    <div>
      <h1>📅 Dry Run PnL Calendar</h1>
      <div class="sub">${positions.length} positions tracked</div>
    </div>
    <div class="nav">
      <button onclick="panMonth(-1)">← Prev</button>
      <button onclick="panMonth(1)">Next →</button>
    </div>
  </div>

  <div class="summary">${statsHtml}</div>

  <div id="months-container">${months}</div>

  <div class="legend">
    <div class="legend-item"><div class="swatch g"></div>Profitable</div>
    <div class="legend-item"><div class="swatch r"></div>Losing</div>
    <div class="legend-item"><div class="swatch n"></div>No closes</div>
  </div>
  <div class="f">Generated ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC</div>
</div>

<div class="modal-overlay" id="modal">
  <div class="modal">
    <button class="mc" onclick="closeModal()">✕</button>
    <h2 id="mt"></h2>
    <div class="md" id="md"></div>
    <div id="mc"></div>
  </div>
</div>

<script>
const DAYS = ${JSON.stringify(buildDayData(sortedDates, days))};

// Shared formatting helpers (browser-side, no Node.js access here)
const fmtSign = (n) => n >= 0 ? '+' : '-';
const fmtAbs = (n) => Math.abs(n).toFixed(2);

let monthIdx = findCurrentMonth();

function findCurrentMonth() {
  const today = new Date().toISOString().slice(0, 7);
  const months = document.querySelectorAll('.month');
  for (let i = 0; i < months.length; i++) {
    if (months[i].dataset.month >= today) return i;
  }
  return months.length - 1;
}

function showMonth(i) {
  const months = document.querySelectorAll('.month');
  if (i < 0 || i >= months.length) return;
  monthIdx = i;
  months.forEach((m, idx) => m.style.display = idx === i ? 'block' : 'none');
}

function panMonth(d) {
  showMonth(monthIdx + d);
}

function openDay(dateStr) {
  const day = DAYS[dateStr];
  if (!day) return;
  document.getElementById('modal').classList.add('active');
  document.getElementById('mt').textContent = formatDate(dateStr);
  // Day totals are stored as {usd, sol} to keep currencies separate
  const usdPart = fmtSign(day.totalUsd) + '$' + fmtAbs(day.totalUsd);
  let totalStr = usdPart;
  if (day.totalSol !== 0) {
    totalStr += ' / ' + fmtSign(day.totalSol) + fmtAbs(day.totalSol) + ' SOL';
  }
  document.getElementById('md').textContent = 'Total PnL: ' + totalStr + ' (' + day.positions.length + ' position' + (day.positions.length !== 1 ? 's' : '') + ')';
  document.getElementById('mc').innerHTML = day.positions.join('');
}

function formatDate(s) {
  const d = new Date(s + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function closeModal() { document.getElementById('modal').classList.remove('active'); }
document.getElementById('modal').addEventListener('click', function(e) { if (e.target === this) closeModal(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

showMonth(monthIdx);
</script>
</body>
</html>`;
}

/** Build day data JSON for the JS side. */
function buildDayData(sortedDates: string[], days: Map<string, ClosedPosition[]>): Record<string, DayData> {
  const data: Record<string, DayData> = {};
  for (const date of sortedDates) {
    const positions = days.get(date) || [];
    const { usd, sol } = sumPnlByCurrency(positions);
    const htmls = positions.map(p => positionHtml(p));
    data[date] = { totalUsd: usd, totalSol: sol, positions: htmls };
  }
  return data;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Build HTML for all months. */
function buildMonths(sortedDates: string[], days: Map<string, ClosedPosition[]>): string {
  if (sortedDates.length === 0) return "";

  // Build month segments
  const monthGroups = new Map<string, string[]>();
  for (const dateStr of sortedDates) {
    const monthKey = dateStr.slice(0, 7); // "2026-06"
    if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
    monthGroups.get(monthKey)!.push(dateStr);
  }

  // Safety limit: render at most 24 months to prevent gigantic output from corrupted data
  const monthsToRender = [...monthGroups.entries()].slice(0, 24);
  if (monthsToRender.length < monthGroups.size) {
    log("dry_run_report", `Truncated ${monthGroups.size - monthsToRender.length} month(s) — limit is 24 months`);
  }

  let html = "";
  for (const [monthKey, dates] of monthsToRender) {
    const dateSetLocal = new Set(dates);
    const [y, m] = monthKey.split("-").map(Number);
    const firstDay = new Date(Date.UTC(y, m - 1, 1));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getDate();
    const startDow = (firstDay.getUTCDay() + 6) % 7; // 0=Mon

    // Month label
    const monthName = firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

    html += `<div class="month" data-month="${monthKey}">`;
    html += `<div class="month-title">${monthName}</div>`;
    html += `<div class="cal">`;

    // Day headers
    for (const dn of DAY_NAMES) {
      html += `<div class="dh">${dn}</div>`;
    }

    // Empty cells before first day
    for (let i = 0; i < startDow; i++) {
      html += `<div class="day empty"></div>`;
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${monthKey}-${String(d).padStart(2, "0")}`;
      if (dateSetLocal.has(dateStr)) {
        const dayPositions = days.get(dateStr) || [];
        const { usd: dayPnl, sol: daySol } = sumPnlByCurrency(dayPositions);
        const absPnl = Math.abs(dayPnl);

        // Intensity class — based on USD (the more familiar concrete number)
        let intense = "";
        if (dayPnl > 0) {
          if (absPnl >= 20) intense = "iv";
          else if (absPnl >= 10) intense = "hv";
          else if (absPnl >= 5) intense = "mv";
          else intense = "lv";
        } else if (dayPnl < 0) {
          if (absPnl >= 15) intense = "hn";
          else if (absPnl >= 7) intense = "mn";
          else intense = "ln";
        }

        const cls = dayPnl >= 0 ? "pos" : "neg";
        const signUsd = fmtSign(dayPnl);
        const signSol = fmtSign(daySol);
        const absSol = fmtAbs(daySol);
        const safeDate = dateStr.replace(/'/g, "\\'");
        // Subline: SOL total (if any) + position count. Count is always shown so
        // users can see at a glance how many positions closed that day.
        const subline = daySol !== 0
          ? `${signSol}${absSol} SOL · ${dayPositions.length} pos`
          : `${dayPositions.length} pos`;
        html += `<div class="day ${intense}" onclick="openDay('${safeDate}')">
          <span class="dn">${d}</span>
          <span class="pnl ${cls}">${signUsd}$${Math.abs(dayPnl).toFixed(2)}</span>
          <span class="ct">${subline}</span>
        </div>`;
      } else {
        html += `<div class="day"><span class="dn">${d}</span></div>`;
      }
    }

    html += `</div></div>`;
  }

  return html;
}
