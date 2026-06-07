// core/decision-log.ts — Decision audit trail
import fs from "fs";
import { log } from "../utils/logger.js";
import type { Decision, DecisionEntry } from "../types/index.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;

function load(): { decisions: Decision[] } {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${(error as Error).message}`);
    return { decisions: [] };
  }
}

function save(data: { decisions: Decision[] }): void {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value: unknown, maxLen = 280): string | null {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry: DecisionEntry): Decision {
  const data = load();
  const decision: Decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name ?? entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter((r): r is string => r !== null).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter((r): r is string => r !== null).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10): Decision[] {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6): string {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
