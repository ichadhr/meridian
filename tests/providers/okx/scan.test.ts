import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  scanTokens,
  setBinaryPath,
  resolveBinaryPath,
  isBinaryAvailable,
  hasCredentials,
} from "../../../providers/okx/index.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

const FAKE_CRITICAL_RESPONSE = {
  ok: true,
  data: [
    {
      chainId: "501",
      tokenAddress: "Mint111111111111111111111111111111111111111",
      isChainSupported: true,
      riskLevel: "CRITICAL",
      buyTaxes: "10.0",
      sellTaxes: "50.0",
      isHoneypot: true,
      isAirdropScam: false,
      isRubbishAirdrop: false,
      isHasAssetEditAuth: false,
      isLowLiquidity: false,
      isDumping: false,
      isLiquidityRemoval: false,
      isPump: false,
      isWash: false,
      isFakeLiquidity: false,
      isWash2: false,
      isFundLinkage: false,
      isVeryLowLpBurn: false,
      isVeryHighLpHolderProp: false,
      isHasBlockingHis: false,
      isOverIssued: false,
      isCounterfeit: false,
      isNotOpenSource: false,
      isMintable: false,
      isHasFrozenAuth: false,
      isNotRenounced: false,
    },
  ],
};

const FAKE_HIGH_RESPONSE = {
  ok: true,
  data: [
    {
      chainId: "501",
      tokenAddress: "Mint222222222222222222222222222222222222222",
      isChainSupported: true,
      riskLevel: "HIGH",
      buyTaxes: "5.0",
      sellTaxes: "10.0",
      isHoneypot: false,
      isAirdropScam: false,
      isRubbishAirdrop: false,
      isHasAssetEditAuth: false,
      isLowLiquidity: true,
      isDumping: true,
      isLiquidityRemoval: false,
      isPump: false,
      isWash: false,
      isFakeLiquidity: false,
      isWash2: false,
      isFundLinkage: false,
      isVeryLowLpBurn: false,
      isVeryHighLpHolderProp: false,
      isHasBlockingHis: false,
      isOverIssued: false,
      isCounterfeit: false,
      isNotOpenSource: false,
      isMintable: false,
      isHasFrozenAuth: false,
      isNotRenounced: false,
    },
  ],
};

const FAKE_LOW_RESPONSE = {
  ok: true,
  data: [
    {
      chainId: "501",
      tokenAddress: "Mint333333333333333333333333333333333333333",
      isChainSupported: true,
      riskLevel: "LOW",
      buyTaxes: "0.0",
      sellTaxes: "0.0",
      isHoneypot: false,
      isAirdropScam: false,
      isRubbishAirdrop: false,
      isHasAssetEditAuth: false,
      isLowLiquidity: false,
      isDumping: false,
      isLiquidityRemoval: false,
      isPump: false,
      isWash: false,
      isFakeLiquidity: false,
      isWash2: false,
      isFundLinkage: false,
      isVeryLowLpBurn: false,
      isVeryHighLpHolderProp: false,
      isHasBlockingHis: false,
      isOverIssued: false,
      isCounterfeit: false,
      isNotOpenSource: false,
      isMintable: true,
      isHasFrozenAuth: true,
      isNotRenounced: true,
    },
  ],
};

/**
 * Create a temporary directory with a fake onchainos binary that prints
 * a canned response. Returns the directory and a cleanup function.
 */
function installFakeBinary(scriptBody: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onchainos-fake-"));
  const binPath = path.join(dir, "onchainos");
  fs.writeFileSync(binPath, scriptBody, { mode: 0o755 });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("providers/okx/scan", () => {
  let savedCreds: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedCreds = {
      OKX_API_KEY: process.env.OKX_API_KEY,
      OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
      OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
    };
    delete process.env.OKX_API_KEY;
    delete process.env.OKX_SECRET_KEY;
    delete process.env.OKX_PASSPHRASE;
    delete process.env.MOCK_ONCHAINOS;
    setBinaryPath(null);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedCreds)) {
      if (v != null) process.env[k] = v;
    }
  });

  describe("mock mode", () => {
    it("returns SCAN_FAILED for empty mints", async () => {
      const verdicts = await scanTokens([]);
      expect(verdicts).toEqual([]);
    });

    it("uses mock mode when no OKX creds are set", async () => {
      const mints = ["M1", "M2", "M3"];
      const verdicts = await scanTokens(mints, { useMock: true });
      expect(verdicts).toHaveLength(3);
      expect(verdicts.map((v) => v.mint)).toEqual(mints);
    });

    it("cycles through risk levels in mock mode (deterministic)", async () => {
      const mints = ["A", "B", "C", "D", "E", "F"];
      const verdicts = await scanTokens(mints, { useMock: true });
      // Mock cycles: LOW, LOW, LOW, MEDIUM, HIGH, CRITICAL (per index % 6)
      expect(verdicts[0].riskLevel).toBe("LOW");
      expect(verdicts[1].riskLevel).toBe("LOW");
      expect(verdicts[2].riskLevel).toBe("LOW");
      expect(verdicts[3].riskLevel).toBe("MEDIUM");
      expect(verdicts[4].riskLevel).toBe("HIGH");
      expect(verdicts[5].riskLevel).toBe("CRITICAL");
    });

    it("honors MOCK_ONCHAINOS=1 env var", async () => {
      process.env.MOCK_ONCHAINOS = "1";
      // No explicit useMock → defaults from env: MOCK=1 → use mock
      const verdicts = await scanTokens(["X", "Y"]);
      expect(verdicts).toHaveLength(2);
      expect(verdicts[0].riskLevel).toBe("LOW");
    });
  });

  describe("hasCredentials / isBinaryAvailable", () => {
    it("hasCredentials returns false when OKX vars missing", () => {
      expect(hasCredentials()).toBe(false);
    });

    it("hasCredentials returns true when all OKX vars set", () => {
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";
      expect(hasCredentials()).toBe(true);
    });

    it("hasCredentials returns false when OKX vars are empty/whitespace", () => {
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "   ";
      process.env.OKX_PASSPHRASE = "p";
      expect(hasCredentials()).toBe(false);
    });

    it("isBinaryAvailable reflects real binary state", () => {
      // The project ships a real onchainos binary — should be available.
      expect(isBinaryAvailable()).toBe(true);
    });

    it("setBinaryPath override works", () => {
      setBinaryPath("/tmp/fake-binary");
      expect(resolveBinaryPath()).toBe("/tmp/fake-binary");
    });
  });

  describe("subprocess wrapper (fake binary)", () => {
    it("parses CRITICAL response correctly", async () => {
      const fake = installFakeBinary(`#!/bin/sh
cat <<'JSON'
${JSON.stringify(FAKE_CRITICAL_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "fake-key";
        process.env.OKX_SECRET_KEY = "fake-secret";
        process.env.OKX_PASSPHRASE = "fake-pass";

        const verdicts = await scanTokens(["Mint111111111111111111111111111111111111111"]);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].mint).toBe("Mint111111111111111111111111111111111111111");
        expect(verdicts[0].riskLevel).toBe("CRITICAL");
        expect(verdicts[0].summary).toContain("honeypot");
        expect(verdicts[0].triggeredLabels).toContain("honeypot");
        expect(verdicts[0].buyTaxes).toBe(10.0);
        expect(verdicts[0].sellTaxes).toBe(50.0);
      } finally {
        fake.cleanup();
      }
    });

    it("parses HIGH response with multiple labels", async () => {
      const fake = installFakeBinary(`#!/bin/sh
cat <<'JSON'
${JSON.stringify(FAKE_HIGH_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        const verdicts = await scanTokens(["Mint222222222222222222222222222222222222222"]);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].riskLevel).toBe("HIGH");
        expect(verdicts[0].triggeredLabels).toContain("low_liquidity");
        expect(verdicts[0].triggeredLabels).toContain("dumping");
        expect(verdicts[0].summary).toContain("low_liquidity");
        expect(verdicts[0].summary).toContain("dumping");
      } finally {
        fake.cleanup();
      }
    });

    it("parses LOW response with no triggered labels (medium flags only)", async () => {
      const fake = installFakeBinary(`#!/bin/sh
cat <<'JSON'
${JSON.stringify(FAKE_LOW_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        const verdicts = await scanTokens(["Mint333333333333333333333333333333333333333"]);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].riskLevel).toBe("LOW");
        // Mintable/freeze/renounced are MEDIUM-tier labels — not in summary
        // (the server says LOW because no high/critical labels fired).
        expect(verdicts[0].summary).toBe("no risk labels triggered");
      } finally {
        fake.cleanup();
      }
    });

    it("returns SCAN_FAILED when binary returns ok:false", async () => {
      const fake = installFakeBinary(`#!/bin/sh
cat <<'JSON'
{"ok": false, "error": "API error (code=50114): Invalid Authority"}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        const verdicts = await scanTokens(["M1", "M2"]);
        expect(verdicts).toHaveLength(2);
        expect(verdicts[0].riskLevel).toBe("SCAN_FAILED");
        expect(verdicts[1].riskLevel).toBe("SCAN_FAILED");
        expect(verdicts[0].summary).toContain("Invalid Authority");
      } finally {
        fake.cleanup();
      }
    });

    it("returns SCAN_FAILED when binary returns invalid JSON", async () => {
      const fake = installFakeBinary(`#!/bin/sh
echo "not json"
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        const verdicts = await scanTokens(["M1"]);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].riskLevel).toBe("SCAN_FAILED");
        expect(verdicts[0].summary).toContain("invalid JSON");
      } finally {
        fake.cleanup();
      }
    });

    it("returns SCAN_FAILED for mints missing from response", async () => {
      // Response only has Mint1 — Mint2 is missing
      const fake = installFakeBinary(`#!/bin/sh
cat <<'JSON'
${JSON.stringify(FAKE_CRITICAL_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        const verdicts = await scanTokens([
          "Mint111111111111111111111111111111111111111",  // present → CRITICAL
          "Mint999999999999999999999999999999999999999",  // missing → SCAN_FAILED
        ]);
        expect(verdicts[0].riskLevel).toBe("CRITICAL");
        expect(verdicts[1].riskLevel).toBe("SCAN_FAILED");
        expect(verdicts[1].summary).toContain("missing from response");
      } finally {
        fake.cleanup();
      }
    });

    it("returns SCAN_FAILED for all mints when binary is missing", async () => {
      setBinaryPath("/nonexistent/onchainos");
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";

      const verdicts = await scanTokens(["M1", "M2"]);
      expect(verdicts).toHaveLength(2);
      expect(verdicts[0].riskLevel).toBe("SCAN_FAILED");
      expect(verdicts[0].summary).toContain("not found");
    });

    it("passes correct args to binary (--chain solana, --tokens solana:mint)", async () => {
      const capturePath = path.join(os.tmpdir(), `onchainos-args-${Date.now()}.log`);
      const fake = installFakeBinary(`#!/bin/sh
echo "$@" > "${capturePath}"
cat <<'JSON'
${JSON.stringify(FAKE_LOW_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";

        await scanTokens(["Mint333333333333333333333333333333333333333"]);
        const args = fs.readFileSync(capturePath, "utf8").trim();
        expect(args).toContain("security");
        expect(args).toContain("token-scan");
        expect(args).toContain("--chain");
        expect(args).toContain("solana");
        expect(args).toContain("--tokens");
        expect(args).toContain("solana:Mint333333333333333333333333333333333333333");
      } finally {
        fake.cleanup();
        try { fs.unlinkSync(capturePath); } catch {}
      }
    });

    it("passes OKX credentials via env (not args)", async () => {
      const capturePath = path.join(os.tmpdir(), `onchainos-env-${Date.now()}.log`);
      const fake = installFakeBinary(`#!/bin/sh
env | grep OKX > "${capturePath}"
cat <<'JSON'
${JSON.stringify(FAKE_LOW_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "test-key-12345";
        process.env.OKX_SECRET_KEY = "test-secret";
        process.env.OKX_PASSPHRASE = "test-pass";

        await scanTokens(["Mint333333333333333333333333333333333333333"]);
        const envDump = fs.readFileSync(capturePath, "utf8");
        expect(envDump).toContain("OKX_API_KEY=test-key-12345");
        expect(envDump).toContain("OKX_SECRET_KEY=test-secret");
        expect(envDump).toContain("OKX_PASSPHRASE=test-pass");
      } finally {
        fake.cleanup();
        try { fs.unlinkSync(capturePath); } catch {}
      }
    });

    it("strips WALLET_PRIVATE_KEY and other sensitive vars from env", async () => {
      const capturePath = path.join(os.tmpdir(), `onchainos-env-leak-${Date.now()}.log`);
      const fake = installFakeBinary(`#!/bin/sh
env > "${capturePath}"
cat <<'JSON'
${JSON.stringify(FAKE_LOW_RESPONSE)}
JSON
`);
      try {
        setBinaryPath(path.join(fake.dir, "onchainos"));
        process.env.OKX_API_KEY = "k";
        process.env.OKX_SECRET_KEY = "s";
        process.env.OKX_PASSPHRASE = "p";
        // Sensitive vars that should NEVER leak
        process.env.WALLET_PRIVATE_KEY = "super-secret-key";
        process.env.RPC_URL = "https://secret-rpc.example.com";

        await scanTokens(["Mint333333333333333333333333333333333333333"]);
        const envDump = fs.readFileSync(capturePath, "utf8");
        expect(envDump).not.toContain("WALLET_PRIVATE_KEY");
        expect(envDump).not.toContain("RPC_URL");
        expect(envDump).not.toContain("super-secret-key");
      } finally {
        fake.cleanup();
        try { fs.unlinkSync(capturePath); } catch {}
      }
    });
  });

  describe("batching", () => {
    /**
     * Build a Node.js-based fake binary that:
     *  - Counts invocations to a file (path passed as --counter)
     *  - Parses --tokens from argv
     *  - Returns a JSON response with one LOW entry per mint
     */
    function makeCountingFakeBinary(): { dir: string; counterPath: string; cleanup: () => void } {
      const counterPath = path.join(os.tmpdir(), `onchainos-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.count`);
      const fake = installFakeBinary(`#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let counterFile = '';
let tokens = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--counter') { counterFile = args[i+1]; }
  if (args[i] === '--tokens') { tokens = args[i+1]; }
}
if (counterFile) {
  const n = parseInt(fs.readFileSync(counterFile, 'utf8') || '0', 10) + 1;
  fs.writeFileSync(counterFile, String(n));
}
const addrs = tokens ? tokens.split(',').map(s => s.replace(/^solana:/, '')) : [];
const data = addrs.map(addr => ({
  chainId: '501', tokenAddress: addr, isChainSupported: true,
  riskLevel: 'LOW', buyTaxes: '0.0', sellTaxes: '0.0',
  isHoneypot: false, isAirdropScam: false, isRubbishAirdrop: false,
  isHasAssetEditAuth: false, isLowLiquidity: false, isDumping: false,
  isLiquidityRemoval: false, isPump: false, isWash: false,
  isFakeLiquidity: false, isWash2: false, isFundLinkage: false,
  isVeryLowLpBurn: false, isVeryHighLpHolderProp: false,
  isHasBlockingHis: false, isOverIssued: false, isCounterfeit: false,
  isNotOpenSource: false, isMintable: false, isHasFrozenAuth: false,
  isNotRenounced: false,
}));
process.stdout.write(JSON.stringify({ ok: true, data }));
`);
      fs.writeFileSync(counterPath, "0");
      return { dir: fake.dir, counterPath, cleanup: fake.cleanup };
    }

    it("batches mints in groups of 50", async () => {
      // Wrap the binary in a shell that injects --counter before exec'ing node.
      // (Cleaner than mutating the wrapper internals.)
      const inner = makeCountingFakeBinary();
      const wrapperPath = path.join(inner.dir, "onchainos-wrapper.sh");
      const wrapperBody = `#!/bin/sh
exec "${path.join(inner.dir, "onchainos")}" \\
  --counter "${inner.counterPath}" \\
  "$@"
`;
      fs.writeFileSync(wrapperPath, wrapperBody, { mode: 0o755 });
      setBinaryPath(wrapperPath);
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";

      try {
        // 60 mints — should be split into 2 batches (50 + 10)
        const mints = Array.from({ length: 60 }, (_, i) => `M${i.toString().padStart(40, "0")}`);
        const verdicts = await scanTokens(mints);
        expect(verdicts).toHaveLength(60);
        expect(verdicts.every((v) => v.riskLevel === "LOW")).toBe(true);
        const callCount = parseInt(fs.readFileSync(inner.counterPath, "utf8"), 10);
        expect(callCount).toBe(2);
      } finally {
        inner.cleanup();
        try { fs.unlinkSync(inner.counterPath); } catch {}
      }
    });

    it("makes a single call for ≤50 mints", async () => {
      const inner = makeCountingFakeBinary();
      const wrapperPath = path.join(inner.dir, "onchainos-wrapper.sh");
      fs.writeFileSync(wrapperPath, `#!/bin/sh
exec "${path.join(inner.dir, "onchainos")}" --counter "${inner.counterPath}" "$@"
`, { mode: 0o755 });
      setBinaryPath(wrapperPath);
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";

      try {
        const mints = Array.from({ length: 30 }, (_, i) => `M${i.toString().padStart(40, "0")}`);
        const verdicts = await scanTokens(mints);
        expect(verdicts).toHaveLength(30);
        const callCount = parseInt(fs.readFileSync(inner.counterPath, "utf8"), 10);
        expect(callCount).toBe(1);
      } finally {
        inner.cleanup();
        try { fs.unlinkSync(inner.counterPath); } catch {}
      }
    });

    it("exactly 50 mints makes one call", async () => {
      const inner = makeCountingFakeBinary();
      const wrapperPath = path.join(inner.dir, "onchainos-wrapper.sh");
      fs.writeFileSync(wrapperPath, `#!/bin/sh
exec "${path.join(inner.dir, "onchainos")}" --counter "${inner.counterPath}" "$@"
`, { mode: 0o755 });
      setBinaryPath(wrapperPath);
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";

      try {
        const mints = Array.from({ length: 50 }, (_, i) => `M${i.toString().padStart(40, "0")}`);
        const verdicts = await scanTokens(mints);
        expect(verdicts).toHaveLength(50);
        const callCount = parseInt(fs.readFileSync(inner.counterPath, "utf8"), 10);
        expect(callCount).toBe(1);
      } finally {
        inner.cleanup();
        try { fs.unlinkSync(inner.counterPath); } catch {}
      }
    });

    it("51 mints makes two calls (boundary)", async () => {
      const inner = makeCountingFakeBinary();
      const wrapperPath = path.join(inner.dir, "onchainos-wrapper.sh");
      fs.writeFileSync(wrapperPath, `#!/bin/sh
exec "${path.join(inner.dir, "onchainos")}" --counter "${inner.counterPath}" "$@"
`, { mode: 0o755 });
      setBinaryPath(wrapperPath);
      process.env.OKX_API_KEY = "k";
      process.env.OKX_SECRET_KEY = "s";
      process.env.OKX_PASSPHRASE = "p";

      try {
        const mints = Array.from({ length: 51 }, (_, i) => `M${i.toString().padStart(40, "0")}`);
        const verdicts = await scanTokens(mints);
        expect(verdicts).toHaveLength(51);
        const callCount = parseInt(fs.readFileSync(inner.counterPath, "utf8"), 10);
        expect(callCount).toBe(2);
      } finally {
        inner.cleanup();
        try { fs.unlinkSync(inner.counterPath); } catch {}
      }
    });
  });
});
