import http from "http";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

// Load env FIRST so dlmm.getConnection() picks up RPC_URL.
import "../utils/secure-env.js";
import { getActiveBin } from "./dlmm.js";
import { log } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "dry-run-state.json");
const PORT = parseInt(process.env.SYNC_PORT || "8765", 10);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function setCors(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

interface VirtualPosition {
  status: string;
  snapshots?: Array<{ active_bin?: number; at?: string }>;
  active_bin_at_deploy?: number;
  deployed_at?: string;
  pool: string;
  pool_name?: string;
}

async function loadOpenVPs(): Promise<VirtualPosition[]> {
  const text = await readFile(STATE_FILE, "utf8");
  const state = JSON.parse(text);
  return (state.virtual_positions || []).filter((v: VirtualPosition) => v.status === "open");
}

interface SyncResult {
  pool: string;
  pool_name?: string;
  sim_active_bin: number | null;
  sim_snapshot_at: string | null;
  real_active_bin?: number;
  real_price?: number;
  ok: boolean;
  error?: string;
}

async function captureOne(vp: VirtualPosition): Promise<SyncResult> {
  const snaps = Array.isArray(vp.snapshots) ? vp.snapshots : [];
  const last = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const simActiveBin = last?.active_bin ?? vp.active_bin_at_deploy ?? null;
  const simSnapshotAt = last?.at ?? vp.deployed_at ?? null;

  try {
    const real = await getActiveBin({ pool_address: vp.pool });
    return {
      pool: vp.pool,
      pool_name: vp.pool_name,
      sim_active_bin: simActiveBin,
      sim_snapshot_at: simSnapshotAt,
      real_active_bin: real.binId,
      real_price: real.price,
      ok: true,
    };
  } catch (e: any) {
    return {
      pool: vp.pool,
      pool_name: vp.pool_name,
      sim_active_bin: simActiveBin,
      sim_snapshot_at: simSnapshotAt,
      ok: false,
      error: e?.message || String(e),
    };
  }
}

interface SyncResponse {
  captured_at: string;
  count: number;
  results: SyncResult[];
}

async function handleSync(): Promise<SyncResponse> {
  const vps = await loadOpenVPs();
  const results: SyncResult[] = [];
  for (const vp of vps) {
    results.push(await captureOne(vp));
  }
  return {
    captured_at: new Date().toISOString(),
    count: results.length,
    results,
  };
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    return json(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  if (req.url === "/sync" && req.method === "GET") {
    try {
      const result = await handleSync();
      log("sync_ok", `count=${result.count} captured_at=${result.captured_at}`);
      return json(res, 200, { ok: true, ...result });
    } catch (e: any) {
      log("sync_err", e?.message || String(e));
      return json(res, 500, { ok: false, error: e?.message || String(e) });
    }
  }

  return json(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[serve-sync] listening on http://localhost:${PORT}`);
  console.log(`  GET /sync   capture sim+real for all open VPs`);
  console.log(`  GET /health liveness check`);
  console.log(`  state file: ${STATE_FILE}`);
});
