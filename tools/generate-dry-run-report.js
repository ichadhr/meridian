/**
 * Generate a self-contained HTML calendar report from dry-run state + archive files.
 *
 * Usage:
 *   import { generateDryRunReport } from "./tools/generate-dry-run-report.js";
 *   const html = await generateDryRunReport();
 *   fs.writeFileSync("dry-run-report.html", html);
 */
import fs from "fs";
import path from "path";
import { log } from "../logger.js";

const STATE_FILE = "./dry-run-state.json";

/** Load all closed positions from the main state file and all archive files. */
function loadAllClosedPositions() {
  const all = [];

  // Main state file
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      for (const vp of (state.virtual_positions || [])) {
        if (vp.status === "closed" && vp.closed_at) all.push(vp);
      }
    } catch (e) {
      log("dry_run_report", `Failed to read state file: ${e.message}`);
    }
  }

  // Archive files
  const cwd = process.cwd();
  try {
    const files = fs.readdirSync(cwd).filter(f => f.startsWith("dry-run-state-archive-") && f.endsWith(".json"));
    for (const file of files) {
      try {
        const archive = JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"));
        for (const vp of (archive.virtual_positions || [])) {
          if (vp.status === "closed" && vp.closed_at) {
            // Tag with archive source so we know it came from archive
            vp._from_archive = file;
            all.push(vp);
          }
        }
      } catch (e) {
        log("dry_run_report", `Failed to read archive ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    log("dry_run_report", `Failed to list archive files: ${e.message}`);
  }

  return all;
}

/** Group positions by UTC date (YYYY-MM-DD) from closed_at. */
function groupByDay(positions) {
  const days = new Map();
  for (const vp of positions) {
    const date = (vp.closed_at || "").slice(0, 10); // "2026-06-15"
    if (!date) continue;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(vp);
  }
  return days;
}

/** Build a summary stats object from all daily groups. */
function computeStats(days) {
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let bestDay = { date: null, pnl: -Infinity };
  let worstDay = { date: null, pnl: Infinity };

  for (const [date, positions] of days) {
    const dayPnl = positions.reduce((s, p) => s + (p.close_pnl_usd || 0), 0);
    totalPnl += dayPnl;
    for (const p of positions) {
      if ((p.close_pnl_usd || 0) >= 0) wins++;
      else losses++;
    }
    if (dayPnl > bestDay.pnl) bestDay = { date, pnl: dayPnl };
    if (dayPnl < worstDay.pnl) worstDay = { date, pnl: dayPnl };
  }

  const total = wins + losses;
  return {
    totalPnl,
    totalPositions: total,
    winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
    avgReturn: total > 0 ? totalPnl / total : 0,
    bestDay,
    worstDay,
  };
}

/** Build HTML for a single position list item. */
function positionHtml(vp) {
  const pnl = vp.close_pnl_usd || 0;
  const cls = pnl >= 0 ? "positive" : "negative";
  const sign = pnl >= 0 ? "+" : "-";
  const absPnl = Math.abs(pnl);
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

  // PnL percentage
  const pnlPct = vp.close_pnl_pct;
  const pctStr = pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${Math.abs(pnlPct).toFixed(2)}%)` : "";

  return `<div class="pos-item">
    <div>
      <div class="pos-name">${escapeHtml(pair)} <span class="pos-reason">${escapeHtml(reason)}</span></div>
      <div class="pos-meta">${duration} hold${pctStr}</div>
    </div>
    <div class="pos-pnl ${cls}">${sign}$${absPnl.toFixed(2)}</div>
  </div>`;
}

function escapeHtml(s) {
  if (typeof s !== "string") return String(s ?? "");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Generate the full self-contained HTML report. */
export function generateDryRunReport() {
  const positions = loadAllClosedPositions();
  if (positions.length === 0) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dry Run Report</title><style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#888;padding:40px;text-align:center;margin-top:80px}h2{color:#fff}</style></head><body><h2>No closed positions yet</h2><p>Dry run has not closed any positions. Deploy first, then check back.</p></body></html>`;
  }

  const days = groupByDay(positions);
  const stats = computeStats(days);

  // Sort days chronologically
  const sortedDates = [...days.keys()].sort();

  // Build calendar months
  const months = buildMonths(sortedDates, days);

  const bestSign = stats.bestDay.pnl >= 0 ? "+" : "-";
  const worstSign = stats.worstDay.pnl >= 0 ? "+" : "-";
  const bestStr = stats.bestDay.date ? `${bestSign}$${Math.abs(stats.bestDay.pnl).toFixed(2)}` : "—";
  const worstStr = stats.worstDay.date ? `${worstSign}$${Math.abs(stats.worstDay.pnl).toFixed(2)}` : "—";
  const totalSign = stats.totalPnl >= 0 ? "+" : "-";
  const avgSign = stats.avgReturn >= 0 ? "+" : "-";
  const bestCls = stats.bestDay.pnl >= 0 ? "positive" : "negative";
  const worstCls = stats.worstDay.pnl >= 0 ? "positive" : "negative";
  const statsHtml = `
    <div class="stat"><div class="stat-lbl">Total PnL</div><div class="stat-val ${stats.totalPnl >= 0 ? "positive" : "negative"}">${totalSign}$${Math.abs(stats.totalPnl).toFixed(2)}</div></div>
    <div class="stat"><div class="stat-lbl">Win Rate</div><div class="stat-val neutral">${stats.winRate}%</div></div>
    <div class="stat"><div class="stat-lbl">Avg Return</div><div class="stat-val ${stats.avgReturn >= 0 ? "positive" : "negative"}">${avgSign}$${Math.abs(stats.avgReturn).toFixed(2)}</div></div>
    <div class="stat"><div class="stat-lbl">Best / Worst</div><div class="stat-val" style="font-size:16px"><span class="${bestCls}">${bestStr}</span> / <span class="${worstCls}">${worstStr}</span></div></div>
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
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
  .stat{background:#12121a;border:1px solid #1e1e2a;border-radius:10px;padding:16px}
  .stat-lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px}
  .stat-val{font-size:22px;font-weight:600;margin-top:4px}
  .stat-val.positive{color:#4ade80}
  .stat-val.negative{color:#f87171}
  .stat-val.neutral{color:#e0e0e0}
  .stat-val .positive{color:#4ade80}
  .stat-val .negative{color:#f87171}
  .month{margin-bottom:32px}
  .month-title{font-size:14px;font-weight:600;color:#777;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.3px}
  .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
  .dh{text-align:center;font-size:10px;color:#444;text-transform:uppercase;padding:4px 0;letter-spacing:0.5px}
  .day{background:#12121a;border:1px solid #1e1e2a;border-radius:8px;aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all .12s;position:relative;min-height:68px;padding:4px}
  .day:hover{border-color:#3a3a4a;transform:translateY(-1px)}
  .day .dn{font-size:9px;color:#444;position:absolute;top:4px;left:7px}
  .day .pnl{font-size:12px;font-weight:600}
  .day .pnl.pos{color:#4ade80}
  .day .pnl.neg{color:#f87171}
  .day .ct{font-size:8px;color:#555;margin-top:1px}
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
  @media(max-width:600px){body{padding:16px}.summary{grid-template-columns:repeat(2,1fr)}.stat-val{font-size:18px}.day{min-height:52px}}
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
  const sign = day.total >= 0 ? '+' : '-';
  document.getElementById('md').textContent = 'Total PnL: ' + sign + '$' + Math.abs(day.total).toFixed(2) + ' (' + day.positions.length + ' position' + (day.positions.length !== 1 ? 's' : '') + ')';
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
function buildDayData(sortedDates, days) {
  const data = {};
  for (const date of sortedDates) {
    const positions = days.get(date) || [];
    const total = positions.reduce((s, p) => s + (p.close_pnl_usd || 0), 0);
    const htmls = positions.map(p => positionHtml(p));
    data[date] = { total, positions: htmls };
  }
  return data;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Build HTML for all months. */
function buildMonths(sortedDates, days) {
  if (sortedDates.length === 0) return "";

  // Build month segments
  const monthGroups = new Map();
  for (const dateStr of sortedDates) {
    const monthKey = dateStr.slice(0, 7); // "2026-06"
    if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
    monthGroups.get(monthKey).push(dateStr);
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
        const dayPnl = dayPositions.reduce((s, p) => s + (p.close_pnl_usd || 0), 0);
        const absPnl = Math.abs(dayPnl);

        // Intensity class
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
        const sign = dayPnl >= 0 ? "+" : "-";
        const safeDate = dateStr.replace(/'/g, "\\'");
        html += `<div class="day ${intense}" onclick="openDay('${safeDate}')">
          <span class="dn">${d}</span>
          <span class="pnl ${cls}">${sign}$${Math.abs(dayPnl).toFixed(2)}</span>
          <span class="ct">${dayPositions.length} pos</span>
        </div>`;
      } else {
        html += `<div class="day"><span class="dn">${d}</span></div>`;
      }
    }

    html += `</div></div>`;
  }

  return html;
}
