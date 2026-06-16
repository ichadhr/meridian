import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { log } from "../utils/logger.js";

const PROJECT_ROOT = process.cwd();
const SKILLS_ROOT = path.join(PROJECT_ROOT, "skills");

// Standard skill install paths (in order of priority)
// npx skills add installs to .agents/skills/ or .claude/skills/ by default
const DEFAULT_SKILL_PATHS = [
  path.join(PROJECT_ROOT, ".agents", "skills"),
  path.join(PROJECT_ROOT, ".claude", "skills"),
  path.join(PROJECT_ROOT, ".cursor", "skills"),
  path.join(PROJECT_ROOT, "skills"),
  // Global install paths
  path.join(process.env.HOME || "~", ".agents", "skills"),
  path.join(process.env.HOME || "~", ".claude", "skills"),
];

// Allow overriding for testing
let _skillPaths: string[] | null = null;
let _skillsRoot: string | null = null;

export function setSkillPaths(paths: string[]): void {
  _skillPaths = paths;
}

export function setSkillsRoot(root: string): void {
  _skillsRoot = root;
}

export function resetSkillPaths(): void {
  _skillPaths = null;
  _skillsRoot = null;
}

function getSkillPaths(): string[] {
  return _skillPaths || DEFAULT_SKILL_PATHS;
}

export function getSkillsRoot(): string {
  return _skillsRoot || SKILLS_ROOT;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  body: string;           // Full SKILL.md content (for prompt injection)
  dirPath: string;        // Directory containing SKILL.md
}

export interface SkillConfig {
  cycles: string[];
  enabled: boolean;
  requiredForDeploy?: boolean;  // Must run before deploy_position
}

// ─── Safety Execution Tracker ────────────────────────────────────────────────

interface SafetyExecution {
  timestamp: number;
  skill: string;
  mint: string;
}

const _safetyExecutions = new Map<string, SafetyExecution>();

function safetyKey(mint: string): string {
  return `safety:${mint}`;
}

// ─── Persisted Safety Tracker ────────────────────────────────────────────────

const SAFETY_EXEC_FILE = "safety-executions.json";

function getSafetyExecPath(): string {
  return path.join(getSkillsRoot(), SAFETY_EXEC_FILE);
}

/**
 * Load safety executions from disk
 */
function loadSafetyExecutionsFromDisk(): void {
  const execPath = getSafetyExecPath();
  if (!fs.existsSync(execPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(execPath, "utf8")) as SafetyExecution[];
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();
    for (const entry of data) {
      if (now - entry.timestamp < maxAgeMs) {
        _safetyExecutions.set(safetyKey(entry.mint), entry);
      }
    }
  } catch (err) {
    log("warn", `Failed to load safety executions: ${err}`);
  }
}

/**
 * Persist safety executions to disk
 */
function saveSafetyExecutionsToDisk(): void {
  const execPath = getSafetyExecPath();
  try {
    fs.mkdirSync(path.dirname(execPath), { recursive: true });
    const data = Array.from(_safetyExecutions.values());
    fs.writeFileSync(execPath, JSON.stringify(data, null, 2));
  } catch (err) {
    log("warn", `Failed to save safety executions: ${err}`);
  }
}

// Load on first access
let _safetyLoaded = false;
function ensureSafetyLoaded(): void {
  if (!_safetyLoaded) {
    loadSafetyExecutionsFromDisk();
    _safetyLoaded = true;
  }
}

/**
 * Record that a safety skill was executed for a mint (persisted to disk)
 */
export function recordSafetyExecution(skill: string, mint: string): void {
  ensureSafetyLoaded();
  _safetyExecutions.set(safetyKey(mint), {
    timestamp: Date.now(),
    skill,
    mint,
  });
  saveSafetyExecutionsToDisk();
}

/**
 * Check if required safety skills ran recently for a mint
 * Returns true if safe to proceed, false if safety check needed
 */
export function checkSafetyExecution(mint: string, ttlMinutes: number = 10): boolean {
  ensureSafetyLoaded();
  const execution = _safetyExecutions.get(safetyKey(mint));
  if (!execution) return false;

  const elapsed = Date.now() - execution.timestamp;
  const ttlMs = ttlMinutes * 60 * 1000;
  return elapsed < ttlMs;
}

// ─── Checksum Manifest ───────────────────────────────────────────────────────

const MANIFEST_FILE = "manifest.json";

interface SkillManifestEntry {
  checksum: string;   // SHA-256 of SKILL.md content
  recordedAt: number; // timestamp when checksum was recorded
}

function getManifestPath(): string {
  return path.join(getSkillsRoot(), MANIFEST_FILE);
}

function loadManifest(): Record<string, SkillManifestEntry> {
  const manifestPath = getManifestPath();
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest: Record<string, SkillManifestEntry>): void {
  try {
    fs.mkdirSync(path.dirname(getManifestPath()), { recursive: true });
    fs.writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
  } catch (err) {
    log("warn", `Failed to save skill manifest: ${err}`);
  }
}

/**
 * Compute SHA-256 checksum of a file
 */
function computeChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Record checksum for an installed skill's SKILL.md
 * Called after npx skills add to establish baseline integrity
 */
export function recordSkillChecksum(skillName: string): boolean {
  const skill = getSkillByName(skillName);
  if (!skill) return false;

  const skillMd = path.join(skill.dirPath, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;

  const checksum = computeChecksum(skillMd);
  const manifest = loadManifest();
  manifest[skillName] = { checksum, recordedAt: Date.now() };
  saveManifest(manifest);

  log("skill_integrity", `Recorded checksum for ${skillName}: ${checksum.slice(0, 12)}...`);
  return true;
}

/**
 * Verify skill SKILL.md hasn't been tampered with since last recording
 * Returns { valid: boolean, reason?: string }
 */
export function verifySkillChecksum(skillName: string): { valid: boolean; reason?: string } {
  const skill = getSkillByName(skillName);
  if (!skill) return { valid: false, reason: `Skill '${skillName}' not found` };

  const skillMd = path.join(skill.dirPath, "SKILL.md");
  if (!fs.existsSync(skillMd)) return { valid: false, reason: `SKILL.md missing for '${skillName}'` };

  const manifest = loadManifest();
  const entry = manifest[skillName];
  if (!entry) return { valid: false, reason: `No checksum recorded for '${skillName}'. Run recordSkillChecksum() first.` };

  const currentChecksum = computeChecksum(skillMd);
  if (currentChecksum !== entry.checksum) {
    return { valid: false, reason: `SKILL.md checksum mismatch for '${skillName}'. File may have been modified.` };
  }

  return { valid: true };
}

// ─── Frontmatter Parsing ─────────────────────────────────────────────────────

/**
 * Parse SKILL.md frontmatter — only name + description per standard
 */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const fm = match[1];
  let name = "";
  let description = "";

  const nameMatch = fm.match(/name:\s*"?([^"\n]+)"?/);
  if (nameMatch) name = nameMatch[1].trim();

  const descMatch = fm.match(/description:\s*"?([^"\n]+)"?/);
  if (descMatch) description = descMatch[1].trim();

  return { name, description };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover all SKILL.md files across standard install paths
 * Returns Map<skillName, skillDirPath>
 */
function discoverSkills(): Map<string, string> {
  const skills = new Map<string, string>();

  for (const basePath of getSkillPaths()) {
    if (!fs.existsSync(basePath)) continue;

    try {
      // Level 1: direct children (skills/<name>/SKILL.md)
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

        const skillDir = path.join(basePath, entry.name);
        const skillMd = path.join(skillDir, "SKILL.md");

        if (fs.existsSync(skillMd) && !skills.has(entry.name)) {
          skills.set(entry.name, skillDir);
          continue;
        }

        // Level 2: nested (skills/<category>/<name>/SKILL.md)
        try {
          const subEntries = fs.readdirSync(skillDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory() || subEntry.name.startsWith(".")) continue;

            const subSkillDir = path.join(skillDir, subEntry.name);
            const subSkillMd = path.join(subSkillDir, "SKILL.md");

            if (fs.existsSync(subSkillMd) && !skills.has(subEntry.name)) {
              skills.set(subEntry.name, subSkillDir);
            }
          }
        } catch {}
      }
    } catch (err) {
      log("error", `Failed to scan skill path ${basePath}: ${err}`);
    }
  }

  return skills;
}

/**
 * Get all installed skills with parsed metadata
 */
export function getInstalledSkills(): Map<string, SkillInfo> {
  const discovered = discoverSkills();
  const result = new Map<string, SkillInfo>();

  for (const [name, dirPath] of discovered) {
    const skillMd = path.join(dirPath, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;

    try {
      const content = fs.readFileSync(skillMd, "utf8");
      const { name: parsedName, description } = parseFrontmatter(content);

      // Use name from frontmatter if available, else directory name
      const skillName = parsedName || name;

      // Extract body (everything after frontmatter)
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : "";

      result.set(skillName, {
        name: skillName,
        description,
        body,
        dirPath,
      });
    } catch (err) {
      log("error", `Failed to load skill '${name}': ${err}`);
    }
  }

  return result;
}

/**
 * Get a specific skill by name
 */
export function getSkillByName(name: string): SkillInfo | null {
  const allSkills = getInstalledSkills();
  return allSkills.get(name) ?? null;
}

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Load skills config (cycle mapping)
 */
export function loadSkillsConfig(): Record<string, SkillConfig> {
  const configPath = path.join(getSkillsRoot(), "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    log("error", `Failed to parse skills/config.json: ${err}`);
    return {};
  }
}

/**
 * Load credentials for a skill
 */
export function loadCredentials(): Record<string, { required: string[] }> {
  const credPath = path.join(getSkillsRoot(), "credentials.json");
  if (!fs.existsSync(credPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(credPath, "utf8"));
  } catch (err) {
    log("error", `Failed to parse skills/credentials.json: ${err}`);
    return {};
  }
}

/**
 * Check if a skill has all required credentials
 */
export function isSkillReady(name: string): { ready: boolean; missing: string[] } {
  dotenv.config({ override: true });

  const creds = loadCredentials()[name];
  if (!creds || !creds.required) return { ready: true, missing: [] };

  const missing = creds.required.filter((envVar: string) => {
    const val = process.env[envVar];
    return !val || val.trim() === "";
  });

  return { ready: missing.length === 0, missing };
}

// ─── Cycle Resolution ────────────────────────────────────────────────────────

/**
 * Get skills for a specific cycle (screening, management, safety, general)
 */
export function getSkillsForCycle(cycle: string): SkillInfo[] {
  const config = loadSkillsConfig();
  const allSkills = getInstalledSkills();
  const result: SkillInfo[] = [];

  for (const [name, skill] of allSkills) {
    const skillConfig = config[name];
    if (!skillConfig) continue;

    const cycles = skillConfig.cycles || [];
    const enabled = skillConfig.enabled !== false;

    if (enabled && cycles.includes(cycle)) {
      result.push(skill);
    }
  }

  return result;
}

/**
 * Get skills required for deploy (safety gate)
 */
export function getRequiredDeploySkills(): SkillInfo[] {
  const config = loadSkillsConfig();
  const allSkills = getInstalledSkills();
  const result: SkillInfo[] = [];

  for (const [name, skill] of allSkills) {
    const skillConfig = config[name];
    if (!skillConfig) continue;

    if (skillConfig.requiredForDeploy && skillConfig.enabled !== false) {
      result.push(skill);
    }
  }

  return result;
}
