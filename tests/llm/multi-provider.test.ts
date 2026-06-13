import { describe, it, expect } from "vitest";
import { parseModelConfig } from "../../config/index.js";

describe("parseModelConfig", () => {
  const DEFAULT_PROVIDER = "default";

  it("parses object format with provider and model", () => {
    const result = parseModelConfig(
      { provider: "anthropic", model: "claude-opus-4-5" },
      DEFAULT_PROVIDER,
      "fallback-model"
    );
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallback: [],
    });
  });

  it("parses object format with fallback chain", () => {
    const result = parseModelConfig(
      {
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallback: [
          { provider: "openrouter", model: "healer-alpha" },
          { provider: "local", model: "backup" },
        ],
      },
      DEFAULT_PROVIDER,
      "fallback-model"
    );
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallback: [
        { provider: "openrouter", model: "healer-alpha" },
        { provider: "local", model: "backup" },
      ],
    });
  });

  it("parses legacy string format 'provider/model'", () => {
    const result = parseModelConfig("openrouter/healer-alpha", DEFAULT_PROVIDER, "fallback");
    expect(result).toEqual({
      provider: "openrouter",
      model: "healer-alpha",
      fallback: [],
    });
  });

  it("parses bare model name with default provider", () => {
    const result = parseModelConfig("healer-alpha", DEFAULT_PROVIDER, "fallback");
    expect(result).toEqual({
      provider: "default",
      model: "healer-alpha",
      fallback: [],
    });
  });

  it("returns defaults for null input", () => {
    const result = parseModelConfig(null, "openrouter", "default-model");
    expect(result).toEqual({
      provider: "openrouter",
      model: "default-model",
      fallback: [],
    });
  });

  it("returns defaults for undefined input", () => {
    const result = parseModelConfig(undefined, "openrouter", "default-model");
    expect(result).toEqual({
      provider: "openrouter",
      model: "default-model",
      fallback: [],
    });
  });

  it("returns defaults for empty string", () => {
    const result = parseModelConfig("", "openrouter", "default-model");
    expect(result).toEqual({
      provider: "openrouter",
      model: "default-model",
      fallback: [],
    });
  });

  it("filters invalid fallback entries", () => {
    const result = parseModelConfig(
      {
        provider: "anthropic",
        model: "claude",
        fallback: [
          { provider: "openrouter", model: "healer" },
          "invalid-string-entry",
          { provider: "local" },  // missing model
          null,
        ],
      },
      DEFAULT_PROVIDER,
      "fallback"
    );
    expect(result.fallback).toEqual([
      { provider: "openrouter", model: "healer" },
    ]);
  });

  it("object with missing provider uses default", () => {
    const result = parseModelConfig({ model: "claude" }, "openrouter", "fallback");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("claude");
  });

  it("object with missing model uses default", () => {
    const result = parseModelConfig({ provider: "anthropic" }, "openrouter", "fallback");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("fallback");
  });

  it("handles whitespace in string format", () => {
    const result = parseModelConfig("  openrouter/healer-alpha  ", DEFAULT_PROVIDER, "fallback");
    expect(result).toEqual({
      provider: "openrouter",
      model: "healer-alpha",
      fallback: [],
    });
  });

  it("handles empty fallback array", () => {
    const result = parseModelConfig(
      { provider: "anthropic", model: "claude", fallback: [] },
      DEFAULT_PROVIDER,
      "fallback"
    );
    expect(result.fallback).toEqual([]);
  });

  it("handles non-array fallback gracefully", () => {
    const result = parseModelConfig(
      { provider: "anthropic", model: "claude", fallback: "not-an-array" },
      DEFAULT_PROVIDER,
      "fallback"
    );
    expect(result.fallback).toEqual([]);
  });
});
