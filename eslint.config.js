import tsParser from "@typescript-eslint/parser";

// Gate enforcement: only barrel files (index.*) are importable from outside their folder.
// Pattern: each provider/core/interfaces/llm subdir is restricted except its barrel.
const barrelGatePatterns = [
  // Provider barrels — catch both root-level and nested-directory imports
  ...["solana", "jupiter", "meteora", "hivemind", "okx"].flatMap((dir) => [
    {
      group: [
        `./providers/${dir}/*`,
        `!./providers/${dir}/index*`,
      ],
      message: `Import from providers/${dir}/index.js barrel`,
    },
    {
      group: [
        `../providers/${dir}/*`,
        `!../providers/${dir}/index*`,
      ],
      message: `Import from providers/${dir}/index.js barrel`,
    },
    {
      group: [
        `../../providers/${dir}/*`,
        `!../../providers/${dir}/index*`,
      ],
      message: `Import from providers/${dir}/index.js barrel`,
    },
  ]),

  // Core files — only known files, avoids false positive on root-level state.ts
  ...["briefing", "decision-log", "signal-tracker", "token-blacklist"].map((name) => ({
    group: [`./core/${name}.js`, `./core/${name}.ts`],
    message: "Import from core/index.js barrel",
  })),

  // Interfaces barrels
  ...["telegram", "discord"].map((dir) => ({
    group: [
      `./interfaces/${dir}/*`,
      `!./interfaces/${dir}/index*`,
    ],
    message: `Import from interfaces/${dir}/index.js barrel`,
  })),
  {
    group: ["./interfaces/*", "!./interfaces/index*"],
    message: "Import from interfaces/index.js barrel",
  },

  // LLM barrels
  {
    group: ["./llm/*", "!./llm/index*"],
    message: "Import from llm/index.js barrel",
  },
  {
    group: ["./llm/tools/*", "!./llm/tools/index*"],
    message: "Import from llm/tools/index.js barrel",
  },
];

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "no-restricted-imports": ["error", { patterns: barrelGatePatterns }],
    },
  },
];
