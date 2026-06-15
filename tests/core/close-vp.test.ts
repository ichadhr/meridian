import { describe, it, expect } from "vitest";
import { closeVpPosition } from "../../core/index.js";

describe("closeVpPosition", () => {
  it("returns error when VP not found", async () => {
    const result = await closeVpPosition("vp_definitely_does_not_exist_xyz", "smoke test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("VP not found");
  });

  it("returns error for empty vpId", async () => {
    const result = await closeVpPosition("", "smoke test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("VP not found");
  });

  it("returns error for null vpId", async () => {
    const result = await closeVpPosition(null as any, "smoke test");
    expect(result.success).toBe(false);
  });
});
