import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    sequence: { concurrent: false },
    exclude: ["dist/**", "node_modules/**"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/{core,llm,interfaces,screening}/**/*.test.ts", "tests/*.test.ts"],
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.test.ts"],
        },
      },
    ],
  },
});
