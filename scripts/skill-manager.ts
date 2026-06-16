import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import readline from "readline";
import dotenv from "dotenv";
import {
  loadSkillsConfig,
  loadCredentials,
  getInstalledSkills,
  isSkillReady,
  getSkillsRoot,
} from "../llm/skill-loader.js";

const PROJECT_ROOT = process.cwd();
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function parseEnv(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

// ─── Add Skill ───────────────────────────────────────────────────────────────
// Wraps `npx skills add` for standard install, then configures Meridian.

export async function addSkill(repo: string, cycles?: string[]): Promise<void> {
  // 1. Standard install via npx skills add
  console.log(`\n📥 Installing skill via npx skills add...`);
  try {
    execSync(`npx skills add "${repo}"`, { cwd: PROJECT_ROOT, stdio: "inherit" });
  } catch (err: any) {
    console.error(`❌ npx skills add failed: ${err.message}`);
    console.log(`   Try manually: npx skills add ${repo}`);
    return;
  }

  // 2. Find the installed skill by scanning standard paths
  const allSkills = getInstalledSkills();
  // Extract skill name from repo (last segment without .git)
  const repoBaseName = repo.split("/").pop()?.replace(/\.git$/, "") || "unknown-skill";

  // Find the skill that matches repo name or was just installed
  let skillName = repoBaseName;
  let skillDir = "";
  for (const [name, skill] of allSkills) {
    if (name === repoBaseName || skill.dirPath.includes(repoBaseName)) {
      skillName = name;
      skillDir = skill.dirPath;
      break;
    }
  }

  if (!skillDir) {
    // Try direct path
    const candidates = [
      path.join(PROJECT_ROOT, ".agents", "skills", repoBaseName),
      path.join(PROJECT_ROOT, ".claude", "skills", repoBaseName),
      path.join(PROJECT_ROOT, "skills", repoBaseName),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        skillDir = c;
        break;
      }
    }
  }

  if (!skillDir) {
    console.error(`❌ Could not find installed skill at standard paths.`);
    console.log(`   Check: .agents/skills/${repoBaseName}/ or .claude/skills/${repoBaseName}/`);
    return;
  }

  console.log(`✅ Found skill at: ${path.relative(PROJECT_ROOT, skillDir)}`);

  // 3. Parse SKILL.md for credentials
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let requiredEnv: string[] = [];
  if (fs.existsSync(skillMdPath)) {
    const md = fs.readFileSync(skillMdPath, "utf8");
    const envVarPattern = /\b([A-Z][A-Z0-9_]*(?:_API_KEY|_SECRET_KEY|_PASSPHRASE|_TOKEN))\b/g;
    let m: RegExpExecArray | null;
    while ((m = envVarPattern.exec(md)) !== null) {
      if (!requiredEnv.includes(m[1])) requiredEnv.push(m[1]);
    }
  }

  // 4. Prompt for missing env vars
  dotenv.config({ override: true });
  const missingEnv: string[] = [];
  for (const envVar of requiredEnv) {
    if (!process.env[envVar] || process.env[envVar].trim() === "") {
      missingEnv.push(envVar);
    }
  }

  if (missingEnv.length > 0) {
    console.log(`\n🔑 Skill '${skillName}' requires environment configuration.`);
    for (const key of missingEnv) {
      const val = await ask(`  ${key}: `);
      if (val) {
        let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
        const envMap = parseEnv(envContent);
        envMap[key] = val;
        const newEnv = Object.entries(envMap).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        fs.writeFileSync(ENV_PATH, newEnv);
        process.env[key] = val;
        console.log(`  ✅ Added ${key} to .env`);
      }
    }
  }

  // 5. Update credentials.json
  const credPath = path.join(getSkillsRoot(), "credentials.json");
  const creds = fs.existsSync(credPath) ? JSON.parse(fs.readFileSync(credPath, "utf8")) : {};
  creds[skillName] = { required: requiredEnv };
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));

  // 6. Configure cycles
  const targetCycles = cycles && cycles.length > 0 ? cycles : ["general"];
  await useSkill(skillName, targetCycles);

  // 7. Record checksum for integrity verification
  const { recordSkillChecksum } = await import("../llm/skill-loader.js");
  recordSkillChecksum(skillName);

  console.log(`\n🚀 Skill '${skillName}' ready! Cycles: [${targetCycles.join(", ")}]`);
}

// ─── Use Skill ───────────────────────────────────────────────────────────────
// Assign skill to specific cycles.

export async function useSkill(name: string, cycles: string[]): Promise<void> {
  const configPath = path.join(getSkillsRoot(), "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

  config[name] = {
    cycles,
    enabled: true,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✅ Skill '${name}' assigned to cycles: [${cycles.join(", ")}]`);
}

// ─── List Skills ──────────────────────────────────────────────────────────────
// Scan standard paths, show installed skills + cycle mappings.

export function listSkills(): void {
  const allSkills = getInstalledSkills();

  if (allSkills.size === 0) {
    console.log("\nNo skills installed.");
    console.log("Install with: npx skills add <owner/repo>");
    return;
  }

  const config = loadSkillsConfig();
  const creds = loadCredentials();

  console.log("\n📦 Installed Skills:");
  console.log("═".repeat(50));

  for (const [name, skill] of allSkills) {
    const skillConfig = config[name];
    let mappedCycles: string[] = [];
    let enabled = true;

    if (skillConfig && typeof skillConfig === "object" && !Array.isArray(skillConfig)) {
      mappedCycles = skillConfig.cycles || [];
      enabled = skillConfig.enabled !== false;
    }

    const { ready, missing } = isSkillReady(name);

    let status = "🟢 Active";
    if (!enabled) status = "⏸️ Disabled";
    else if (!ready) status = `🔴 Missing: ${missing.join(", ")}`;

    console.log(`\n  ${name}`);
    console.log(`    Status:   ${status}`);
    console.log(`    Cycles:   [${mappedCycles.join(", ")}]`);
    if (skill.description) {
      console.log(`    Desc:     ${skill.description}`);
    }
  }
  console.log("");
}

// ─── Remove Skill ────────────────────────────────────────────────────────────
// Remove from config.json + credentials.json. Files stay (use npx skills remove).

export function removeSkill(name: string): void {
  // Remove from config.json
  const configPath = path.join(getSkillsRoot(), "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config[name]) {
        delete config[name];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    } catch {}
  }

  // Remove from credentials.json
  const credPath = path.join(getSkillsRoot(), "credentials.json");
  if (fs.existsSync(credPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, "utf8"));
      if (creds[name]) {
        delete creds[name];
        fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));
      }
    } catch {}
  }

  console.log(`✅ Skill '${name}' removed from config.`);
  console.log(`   To delete files: npx skills remove ${name}`);
}

// ─── Update Skill ────────────────────────────────────────────────────────────
// Re-clone and overwrite, preserving cycle config.

export async function updateSkill(name: string): Promise<void> {
  // Find the skill to get its source
  const skillDir = path.join(getSkillsRoot(), name);
  if (!fs.existsSync(skillDir)) {
    console.error(`❌ Skill '${name}' is not installed.`);
    return;
  }

  // Check if it has a .git directory (was installed by us)
  const gitDir = path.join(skillDir, ".git");
  if (!fs.existsSync(gitDir)) {
    console.error(`❌ Skill '${name}' was not installed via git. Update manually.`);
    return;
  }

  console.log(`📥 Updating skill '${name}'...`);
  try {
    execSync("git pull", { cwd: skillDir, stdio: "inherit" });
    // Re-record checksum after update
    const { recordSkillChecksum } = await import("../llm/skill-loader.js");
    recordSkillChecksum(name);
    console.log(`✅ Skill '${name}' updated.`);
  } catch (err: any) {
    console.error(`❌ Git pull failed: ${err.message}`);
  }
}
