/**
 * Test: Secure Env Encryption and Decryption (secure-env.ts)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  envryptEncrypt,
  envryptDecrypt,
  loadEnv,
  encryptEnvRaw,
} from "../utils/secure-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_ENV = path.join(__dirname, ".env.temp");
const TEMP_RAW = path.join(__dirname, ".env.raw.temp");
const TEMP_KEY = path.join(__dirname, ".envrypt.temp");

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`${msg} expected=${expected} actual=${actual}`);
  }
}

function cleanup(): void {
  if (fs.existsSync(TEMP_ENV)) fs.unlinkSync(TEMP_ENV);
  if (fs.existsSync(TEMP_RAW)) fs.unlinkSync(TEMP_RAW);
  if (fs.existsSync(TEMP_KEY)) fs.unlinkSync(TEMP_KEY);
}

async function suite(): Promise<void> {
  cleanup();

  try {
    // ── Test 1: Basic encrypt & decrypt matching ───────────────────
    await test("secure-env: encrypt and decrypt matches original value", () => {
      const original = "my-super-secret-private-key-123456";
      const key = "envrypt-passphrase";
      const encrypted = envryptEncrypt(original, key);
      const decrypted = envryptDecrypt(encrypted, key);

      assertEq(decrypted, original);
      assertEq(encrypted !== original, true, "encrypted value should be obfuscated");
    });

    // ── Test 2: encryptEnvRaw encryption selection ──────────────────
    await test("secure-env: encryptEnvRaw encrypts sensitive keys and leaves others plain", () => {
      fs.writeFileSync(TEMP_KEY, "test-key-123456");
      fs.writeFileSync(
        TEMP_RAW,
        "PORT=8080\nWALLET_PRIVATE_KEY=secret_wallet_key_here\nDATABASE_URL=postgres://...\n",
      );

      encryptEnvRaw({
        rawPath: TEMP_RAW,
        outPath: TEMP_ENV,
        keyPath: TEMP_KEY,
      });

      const encryptedContent = fs.readFileSync(TEMP_ENV, "utf8");

      assertEq(encryptedContent.includes("PORT=8080"), true, "PORT should be unencrypted");
      assertEq(encryptedContent.includes("WALLET_PRIVATE_KEY="), true, "WALLET_PRIVATE_KEY should exist");
      assertEq(encryptedContent.includes("secret_wallet_key_here"), false, "sensitive value should be encrypted");
      assertEq(encryptedContent.includes("# encrypted"), true, "encrypted marker should exist");
    });

    // ── Test 3: loadEnv decrypted environment variables ─────────────
    await test("secure-env: loadEnv decrypts environment variables into process.env", () => {
      fs.writeFileSync(TEMP_KEY, "test-key-123456");
      // Clean target process.env keys first
      delete process.env.WALLET_PRIVATE_KEY;
      delete process.env.PORT;

      loadEnv({
        envPath: TEMP_ENV,
        keyPath: TEMP_KEY,
        override: true,
      });

      assertEq(process.env.PORT, "8080");
      assertEq(process.env.WALLET_PRIVATE_KEY, "secret_wallet_key_here");
    });

  } finally {
    cleanup();
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

suite().catch((err) => {
  console.error(err);
  process.exit(1);
});
