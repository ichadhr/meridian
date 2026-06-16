import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../../config/index.js";
import { getGmgnTokenFees, hasGmgnApiKey } from "../../providers/gmgn/index.js";

describe("GMGN Provider", () => {
  const originalApiKey = config.gmgn.apiKey;
  const originalProcessKey = process.env.GMGN_API_KEY;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // Start with a clean slate for apiKey
    config.gmgn.apiKey = null;
    delete process.env.GMGN_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.gmgn.apiKey = originalApiKey;
    if (originalProcessKey !== undefined) {
      process.env.GMGN_API_KEY = originalProcessKey;
    } else {
      delete process.env.GMGN_API_KEY;
    }
  });

  describe("hasGmgnApiKey", () => {
    it("returns false when no API key is set", () => {
      expect(hasGmgnApiKey()).toBe(false);
    });

    it("returns true when config apiKey is set", () => {
      config.gmgn.apiKey = "config-key-123";
      expect(hasGmgnApiKey()).toBe(true);
    });

    it("returns true when process.env GMGN_API_KEY is set", () => {
      process.env.GMGN_API_KEY = "env-key-123";
      expect(hasGmgnApiKey()).toBe(true);
    });
  });

  describe("getGmgnTokenFees", () => {
    it("returns null immediately when no API key is present", async () => {
      const result = await getGmgnTokenFees("some-mint-address");
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("fetches and parses token fees successfully when key is present", async () => {
      config.gmgn.apiKey = "test-api-key";

      const mockResponse = {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            total_fee: "1.25",
            trade_fee: "0.05"
          }
        }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const result = await getGmgnTokenFees("some-mint-address");
      expect(result).toEqual({
        total_fee: 1.25,
        trade_fee: 0.05
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("returns null and logs when the API request fails", async () => {
      config.gmgn.apiKey = "test-api-key";

      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const result = await getGmgnTokenFees("some-mint-address");
      expect(result).toBeNull();
    });
  });
});
