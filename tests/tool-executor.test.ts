import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeTool } from "../llm/tools/executor.js";

describe("executeTool", () => {
  const originalDryRun = process.env.DRY_RUN;

  beforeEach(() => {
    process.env.DRY_RUN = "true";
  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
  });

  it("returns error on unknown tool", async () => {
    const result = await executeTool("nonexistent_tool", {});
    expect(result.error).toContain("Unknown tool");
  });

  it("strips model artifacts from tool names", async () => {
    // After stripping, dispatches to get_wallet_balance — which may fail
    // with wallet error, but NOT "Unknown tool"
    const result = await executeTool("get_wallet_balance<|channel|>commentary", {});
    expect(result.error).not.toContain("Unknown tool");
  });

  it("dispatches get_wallet_balance (wallet error = dispatch works)", async () => {
    // get_wallet_balance dispatches correctly but fails because no wallet
    const result = await executeTool("get_wallet_balance", {});
    // Error is about wallet, not about unknown tool — dispatch works
    expect(result.error).not.toContain("Unknown tool");
  });

  it("dispatches deploy_position (safety check blocks = dispatch works)", async () => {
    // deploy_position has safety checks — blocked is expected, not "Unknown tool"
    const result = await executeTool("deploy_position", {
      pool_address: "test-pool",
      amount_y: 1,
      strategy: "conservative",
      bins_below: 35,
      bins_above: 0,
    });
    // Should not be "Unknown tool" — blocked by safety check means dispatch works
    // Result may be { blocked: true, reason: "..." } or { error: "..." }
    expect(JSON.stringify(result)).not.toContain("Unknown tool");
  });
});
