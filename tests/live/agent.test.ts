/**
 * Test the full agent loop in dry-run mode (no wallet needed for screening).
 * Run: DRY_RUN=true vitest run --project live tests/live/agent.test.ts
 */

import "dotenv/config";
import { describe, it, expect } from "vitest";
import { agentLoop } from "../../llm/index.js";

describe("Agent loop (DRY RUN)", () => {
  it("runs get_top_candidates and deploy_position", { timeout: 60_000 }, async () => {
    const result = await agentLoop(
      "Run get_top_candidates. Then deploy_position into the #1 candidate using 0.1 SOL. Report what was deployed.",
      5
    );
    expect(result).toBeDefined();
  });
});
