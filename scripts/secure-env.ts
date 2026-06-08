#!/usr/bin/env node
import { encryptEnvRaw, envryptDecrypt } from "../utils/secure-env.js";

function usage(): void {
  console.log(`Usage:
  node scripts/secure-env.ts encrypt [rawPath] [outPath]
  node scripts/secure-env.ts decrypt KEY VALUE

Envrypt key is read from .envrypt, ENVRYPT_KEY, or ENVCRYPT_KEY.`);
}

const [command, first, second] = process.argv.slice(2);

try {
  if (command === "encrypt") {
    const result = encryptEnvRaw({
      rawPath: first || undefined,
      outPath: second || undefined,
    });
    console.log(`Encrypted ${result.rawPath} -> ${result.outPath}`);
  } else if (command === "decrypt") {
    if (!first || !second) {
      usage();
      process.exit(1);
    }
    console.log(envryptDecrypt(second, first));
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
