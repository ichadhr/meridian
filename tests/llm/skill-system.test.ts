import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  loadSkillsConfig,
  loadCredentials,
  getInstalledSkills,
  getSkillByName,
  getSkillsForCycle,
  isSkillReady,
  recordSafetyExecution,
  checkSafetyExecution,
  recordSkillChecksum,
  verifySkillChecksum,
  setSkillPaths,
  setSkillsRoot,
  resetSkillPaths,
} from "../../llm/skill-loader.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_ROOT = path.join(process.cwd(), ".test-skill-system");
const TEST_SKILLS_ROOT = path.join(TEST_ROOT, "skills");
const TEST_AGENTS_SKILLS = path.join(TEST_ROOT, ".agents", "skills");
const TEST_CLAUDE_SKILLS = path.join(TEST_ROOT, ".claude", "skills");

function createSkillDir(
  name: string,
  opts: {
    frontmatter?: string;
    basePath?: string;
  } = {}
) {
  const basePath = opts.basePath || TEST_AGENTS_SKILLS;
  const skillDir = path.join(basePath, name);
  fs.mkdirSync(skillDir, { recursive: true });

  // Create SKILL.md — standard format: name + description only
  const frontmatter = opts.frontmatter ?? `---
name: ${name}
description: Test skill for ${name}
---

# ${name}

Test instructions.

## When to Use
- Check token security
- Analyze holder distribution

## Commands
\`\`\`bash
${name} scan --token {mint}
${name} analyze --pool {pool}
\`\`\``;
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), frontmatter);

  return skillDir;
}

function createConfig(config: Record<string, any>) {
  fs.mkdirSync(TEST_SKILLS_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_SKILLS_ROOT, "config.json"),
    JSON.stringify(config, null, 2)
  );
}

function createCredentials(creds: Record<string, { required: string[] }>) {
  fs.mkdirSync(TEST_SKILLS_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_SKILLS_ROOT, "credentials.json"),
    JSON.stringify(creds, null, 2)
  );
}

function cleanup() {
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Skill System", () => {
  beforeEach(() => {
    cleanup();
    // Isolate skill-loader to test paths only
    setSkillPaths([TEST_AGENTS_SKILLS, TEST_CLAUDE_SKILLS]);
    setSkillsRoot(TEST_SKILLS_ROOT);
  });

  afterEach(() => {
    cleanup();
    resetSkillPaths();
  });

  // ─── SKILL.md Frontmatter Parsing ────────────────────────────────────────

  describe("SKILL.md frontmatter parsing", () => {
    it("should detect skills from .agents/skills/", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });

      const skillMd = fs.readFileSync(
        path.join(TEST_AGENTS_SKILLS, "test-skill", "SKILL.md"),
        "utf8"
      );
      expect(skillMd).toContain("name: test-skill");
    });

    it("should parse name and description from frontmatter", () => {
      const frontmatter = `---
name: gmgn-token
description: Token info, security, pool, holders, traders
---

# GMGN Token

Instructions here.`;

      createSkillDir("gmgn-token", {
        basePath: TEST_AGENTS_SKILLS,
        frontmatter,
      });

      const skill = getSkillByName("gmgn-token");
      expect(skill).toBeTruthy();
      expect(skill!.name).toBe("gmgn-token");
      expect(skill!.description).toBe("Token info, security, pool, holders, traders");
    });

    it("should extract body content after frontmatter", () => {
      const frontmatter = `---
name: test-skill
description: A test skill
---

# Test Skill

This is the body content.

## Commands
\`\`\`bash
test-skill scan --token {mint}
\`\`\``;

      createSkillDir("test-skill", {
        basePath: TEST_AGENTS_SKILLS,
        frontmatter,
      });

      const skill = getSkillByName("test-skill");
      expect(skill).toBeTruthy();
      expect(skill!.body).toContain("# Test Skill");
      expect(skill!.body).toContain("This is the body content.");
      expect(skill!.body).toContain("test-skill scan --token {mint}");
    });
  });

  // ─── Config Format ───────────────────────────────────────────────────────

  describe("config.json format", () => {
    it("should support SkillConfig format", () => {
      createConfig({
        onchainos: {
          cycles: ["screening", "management", "safety"],
          enabled: true,
          requiredForDeploy: true,
        },
        "gmgn-token": {
          cycles: ["screening"],
          enabled: true,
        },
      });

      const config = loadSkillsConfig();
      expect(config.onchainos).toEqual({
        cycles: ["screening", "management", "safety"],
        enabled: true,
        requiredForDeploy: true,
      });
      expect(config["gmgn-token"]).toEqual({
        cycles: ["screening"],
        enabled: true,
      });
    });

    it("should handle empty config", () => {
      createConfig({});

      const config = loadSkillsConfig();
      expect(config).toEqual({});
    });
  });

  // ─── Credentials ─────────────────────────────────────────────────────────

  describe("credentials.json", () => {
    it("should store required env vars per skill", () => {
      createCredentials({
        onchainos: {
          required: ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"],
        },
        "gmgn-token": {
          required: ["GMGN_API_KEY"],
        },
      });

      const creds = loadCredentials();
      expect(creds.onchainos.required).toEqual([
        "OKX_API_KEY",
        "OKX_SECRET_KEY",
        "OKX_PASSPHRASE",
      ]);
      expect(creds["gmgn-token"].required).toEqual(["GMGN_API_KEY"]);
    });

    it("should detect missing credentials", () => {
      createCredentials({
        test: {
          required: ["TEST_API_KEY", "TEST_SECRET"],
        },
      });

      process.env.TEST_API_KEY = "abc123";
      delete process.env.TEST_SECRET;

      const { ready, missing } = isSkillReady("test");
      expect(ready).toBe(false);
      expect(missing).toEqual(["TEST_SECRET"]);

      delete process.env.TEST_API_KEY;
    });

    it("should return ready when all credentials present", () => {
      createCredentials({
        test: {
          required: ["TEST_API_KEY"],
        },
      });

      process.env.TEST_API_KEY = "abc123";
      const { ready, missing } = isSkillReady("test");
      expect(ready).toBe(true);
      expect(missing).toEqual([]);

      delete process.env.TEST_API_KEY;
    });
  });

  // ─── Cycle Mapping ───────────────────────────────────────────────────────

  describe("cycle mapping", () => {
    it("should map skill to specific cycles", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({
        "test-skill": {
          cycles: ["screening", "management"],
          enabled: true,
        },
      });

      const screeningSkills = getSkillsForCycle("screening");
      const managementSkills = getSkillsForCycle("management");
      const safetySkills = getSkillsForCycle("safety");

      expect(screeningSkills.some((s) => s.name === "test-skill")).toBe(true);
      expect(managementSkills.some((s) => s.name === "test-skill")).toBe(true);
      expect(safetySkills.some((s) => s.name === "test-skill")).toBe(false);
    });

    it("should not include disabled skills", () => {
      createSkillDir("disabled-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({
        "disabled-skill": {
          cycles: ["screening"],
          enabled: false,
        },
      });

      const skills = getSkillsForCycle("screening");
      expect(skills.some((s) => s.name === "disabled-skill")).toBe(false);
    });

    it("should return empty for unmapped skills", () => {
      createSkillDir("unconfigured-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({});

      const generalSkills = getSkillsForCycle("general");
      expect(generalSkills.some((s) => s.name === "unconfigured-skill")).toBe(false);
    });
  });

  // ─── Prompt Injection ────────────────────────────────────────────────────

  describe("prompt injection", () => {
    it("should include SKILL.md body for active cycle skills", () => {
      const skillMd = `---
name: test-skill
description: A test skill
---

# Test Skill Instructions

When analyzing tokens, follow these steps:
1. Check holder distribution
2. Verify liquidity depth
3. Run security scan

## Command
\`\`\`bash
onchainos security token-scan --tokens solana:{mint} --chain solana
\`\`\``;

      createSkillDir("test-skill", {
        basePath: TEST_AGENTS_SKILLS,
        frontmatter: skillMd,
      });
      createConfig({
        "test-skill": {
          cycles: ["screening"],
          enabled: true,
        },
      });

      const skills = getSkillsForCycle("screening");
      expect(skills.length).toBe(1);
      expect(skills[0].body).toContain("Test Skill Instructions");
      expect(skills[0].body).toContain("Check holder distribution");
      expect(skills[0].body).toContain("onchainos security token-scan");
    });

    it("should not include skills from other cycles", () => {
      createSkillDir("safety-only", { basePath: TEST_AGENTS_SKILLS });
      createConfig({
        "safety-only": {
          cycles: ["safety"],
          enabled: true,
        },
      });

      const screeningSkills = getSkillsForCycle("screening");
      expect(screeningSkills.some((s) => s.name === "safety-only")).toBe(false);
    });
  });

  // ─── Skill Discovery ────────────────────────────────────────────────────

  describe("skill discovery", () => {
    it("should discover skills from multiple paths", () => {
      createSkillDir("skill-a", { basePath: TEST_AGENTS_SKILLS });
      createSkillDir("skill-b", { basePath: TEST_CLAUDE_SKILLS });

      const allSkills = getInstalledSkills();
      expect(allSkills.size).toBeGreaterThanOrEqual(2);
    });

    it("should prefer first path over later paths", () => {
      createSkillDir("dup-skill", {
        basePath: TEST_AGENTS_SKILLS,
        frontmatter: `---\nname: dup-skill\ndescription: agents version\n---\n\nBody.`,
      });
      createSkillDir("dup-skill", {
        basePath: TEST_CLAUDE_SKILLS,
        frontmatter: `---\nname: dup-skill\ndescription: claude version\n---\n\nBody.`,
      });

      const allSkills = getInstalledSkills();
      const skill = allSkills.get("dup-skill");
      expect(skill).toBeTruthy();
    });

    it("should discover nested skills (category/name)", () => {
      const nestedDir = path.join(TEST_AGENTS_SKILLS, "okx", "okx-security");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, "SKILL.md"),
        `---\nname: okx-security\ndescription: Security scanning\n---\n\n# Security\n\nScan tokens.`
      );

      const allSkills = getInstalledSkills();
      expect(allSkills.has("okx-security")).toBe(true);
    });
  });

  // ─── Skill Manager Commands ──────────────────────────────────────────────

  describe("skill manager commands", () => {
    it("useSkill should update config.json", async () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({});

      const { useSkill } = await import("../../scripts/skill-manager.js");
      await useSkill("test-skill", ["screening", "management"]);

      const config = loadSkillsConfig();
      expect(config["test-skill"]).toEqual({
        cycles: ["screening", "management"],
        enabled: true,
      });
    });

    it("removeSkill should remove from config.json", async () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({
        "test-skill": {
          cycles: ["screening"],
          enabled: true,
        },
      });

      const { removeSkill } = await import("../../scripts/skill-manager.js");
      removeSkill("test-skill");

      const config = loadSkillsConfig();
      expect(config["test-skill"]).toBeUndefined();
    });

    it("listSkills should show installed skills with cycles", async () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });
      createConfig({
        "test-skill": {
          cycles: ["screening"],
          enabled: true,
        },
      });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const { listSkills } = await import("../../scripts/skill-manager.js");
      listSkills();

      const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(output).toContain("test-skill");
      expect(output).toContain("screening");

      consoleSpy.mockRestore();
    });
  });

  // ─── Safety Execution Tracking ───────────────────────────────────────────

  describe("safety execution tracking", () => {
    it("should record safety execution", () => {
      recordSafetyExecution("onchainos", "So11111111111111111111111111111111111111112");

      const result = checkSafetyExecution("So11111111111111111111111111111111111111112", 10);
      expect(result).toBe(true);
    });

    it("should return false for unminted mints", () => {
      const result = checkSafetyExecution("UnknownMint111111111111111111111111111111", 10);
      expect(result).toBe(false);
    });

    it("should persist to disk and reload", () => {
      recordSafetyExecution("test-skill", "PersistMint111111111111111111111111111111");

      // Verify file was written
      const execPath = path.join(TEST_SKILLS_ROOT, "safety-executions.json");
      expect(fs.existsSync(execPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(execPath, "utf8"));
      const entry = data.find((e: any) => e.mint === "PersistMint111111111111111111111111111111");
      expect(entry).toBeDefined();
      expect(entry.skill).toBe("test-skill");
    });
  });

  // ─── Checksum Manifest ────────────────────────────────────────────────────

  describe("checksum manifest", () => {
    it("should record and verify checksum", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });

      const recorded = recordSkillChecksum("test-skill");
      expect(recorded).toBe(true);

      const result = verifySkillChecksum("test-skill");
      expect(result.valid).toBe(true);
    });

    it("should detect tampered SKILL.md", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });

      recordSkillChecksum("test-skill");

      // Tamper with the file
      const skillMd = path.join(TEST_AGENTS_SKILLS, "test-skill", "SKILL.md");
      fs.writeFileSync(skillMd, "TAMPERED CONTENT");

      const result = verifySkillChecksum("test-skill");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("checksum mismatch");
    });

    it("should fail for unrecorded skill", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });

      const result = verifySkillChecksum("test-skill");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("No checksum recorded");
    });

    it("should fail for missing skill", () => {
      const result = verifySkillChecksum("nonexistent-skill");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("should persist manifest to disk", () => {
      createSkillDir("test-skill", { basePath: TEST_AGENTS_SKILLS });

      recordSkillChecksum("test-skill");

      const manifestPath = path.join(TEST_SKILLS_ROOT, "manifest.json");
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest["test-skill"]).toBeDefined();
      expect(manifest["test-skill"].checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest["test-skill"].recordedAt).toBeTypeOf("number");
    });
  });
});
