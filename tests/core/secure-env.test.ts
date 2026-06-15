import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  envryptEncrypt,
  envryptDecrypt,
  loadEnv,
  encryptEnvRaw,
} from "../../utils/secure-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_ENV = path.join(__dirname, ".env.temp");
const TEMP_RAW = path.join(__dirname, ".env.raw.temp");
const TEMP_KEY = path.join(__dirname, ".envrypt.temp");

function cleanup(): void {
  if (fs.existsSync(TEMP_ENV)) fs.unlinkSync(TEMP_ENV);
  if (fs.existsSync(TEMP_RAW)) fs.unlinkSync(TEMP_RAW);
  if (fs.existsSync(TEMP_KEY)) fs.unlinkSync(TEMP_KEY);
}

beforeAll(cleanup);
afterAll(cleanup);

describe("Secure Env", () => {
  it("encrypt and decrypt matches original value", () => {
    const original = "my-super-secret-private-key-123456";
    const key = "envrypt-passphrase";
    const encrypted = envryptEncrypt(original, key);
    const decrypted = envryptDecrypt(encrypted, key);

    expect(decrypted).toBe(original);
    expect(encrypted).not.toBe(original);
  });

  it("encryptEnvRaw encrypts sensitive keys and leaves others plain", () => {
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

    expect(encryptedContent).toContain("PORT=8080");
    expect(encryptedContent).toContain("WALLET_PRIVATE_KEY=");
    expect(encryptedContent).not.toContain("secret_wallet_key_here");
    expect(encryptedContent).toContain("# encrypted");
  });

  it("loadEnv decrypts environment variables into process.env", () => {
    fs.writeFileSync(TEMP_KEY, "test-key-123456");
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.PORT;

    loadEnv({
      envPath: TEMP_ENV,
      keyPath: TEMP_KEY,
      override: true,
    });

    expect(process.env.PORT).toBe("8080");
    expect(process.env.WALLET_PRIVATE_KEY).toBe("secret_wallet_key_here");
  });
});
