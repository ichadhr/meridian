import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeDeployAmount, config } from "../config/index.js";

describe("computeDeployAmount", () => {
  const original = {
    gasReserve: config.management.gasReserve,
    rentBuffer: config.management.rentBuffer,
    positionSizePct: config.management.positionSizePct,
    deployAmountSol: config.management.deployAmountSol,
    maxDeployAmount: config.risk.maxDeployAmount,
  };

  beforeEach(() => {
    // Use clean test values
    config.management.gasReserve = 0.2;
    config.management.rentBuffer = 0.15;
    config.management.positionSizePct = 0.35;
    config.management.deployAmountSol = 0.5;
    config.risk.maxDeployAmount = 50;
  });

  afterEach(() => {
    Object.assign(config.management, original);
    config.risk.maxDeployAmount = original.maxDeployAmount;
  });

  it("returns floor when wallet is below minimum", () => {
    // deployable = 1 - 0.2 - 0.15 = 0.65
    // dynamic = 0.65 * 0.35 = 0.2275
    // result = max(0.5, 0.2275) = 0.5 (floor)
    expect(computeDeployAmount(1)).toBe(0.5);
  });

  it("returns floor when wallet is zero", () => {
    expect(computeDeployAmount(0)).toBe(0.5);
  });

  it("scales with wallet balance in normal range", () => {
    // deployable = 5 - 0.2 - 0.15 = 4.65
    // dynamic = 4.65 * 0.35 = 1.6275
    // result = max(0.5, min(50, 1.6275)) = 1.63
    expect(computeDeployAmount(5)).toBe(1.63);
  });

  it("caps at maxDeployAmount", () => {
    // deployable = 200 - 0.2 - 0.15 = 199.65
    // dynamic = 199.65 * 0.35 = 69.8775
    // result = min(50, max(0.5, 69.8775)) = 50
    expect(computeDeployAmount(200)).toBe(50);
  });

  it("handles negative wallet balance", () => {
    // deployable = max(0, -5 - 0.2 - 0.15) = 0
    // dynamic = 0 * 0.35 = 0
    // result = max(0.5, 0) = 0.5 (floor)
    expect(computeDeployAmount(-5)).toBe(0.5);
  });

  it("returns exactly floor for wallet just above gas+rent", () => {
    // deployable = 0.36 - 0.2 - 0.15 = 0.01
    // dynamic = 0.01 * 0.35 = 0.0035
    // result = max(0.5, 0.0035) = 0.5 (floor)
    expect(computeDeployAmount(0.36)).toBe(0.5);
  });
});
