/**
 * llm/tools/index.ts — Tool System Gate
 *
 * The ONLY file imported by agent.ts. Merges all tool schemas into the
 * single `tools` array the LLM receives, and routes executeTool() to
 * the correct group handler.
 *
 * During migration, group imports will be wired incrementally as tool files
 * move from tools/ into llm/tools/ group files.
 */

// --- Group imports (wire as tool files migrate) ---
// import * as screening  from "./screening.js";
// import * as deployment from "./deployment.js";
// import * as management from "./management.js";
// import * as wallet     from "./cmd/wallet.js";
// import * as token      from "./cmd/token.js";
// import * as smartWallets from "./cmd/smart-wallets.js";
// import * as lessons    from "./cmd/lessons.js";
// import * as strategy   from "./cmd/strategy.js";
// import * as memory     from "./cmd/memory.js";
// import * as blacklist  from "./cmd/blacklist.js";

// --- Types ---

/** OpenAI-format tool definition — matches what the LLM API expects */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolGroup {
  definitions: ToolDefinition[];
  handle: (name: string, args: unknown) => Promise<unknown> | undefined;
}

// --- Groups (wire as tool files migrate) ---
const groups: ToolGroup[] = [
  // TODO: uncomment as tool files migrate to llm/tools/
  // screening, deployment, management, wallet, token, smartWallets,
  // lessons, strategy, memory, blacklist
];

/**
 * All tool definitions merged into a single flat array for the LLM.
 */
export const tools: ToolDefinition[] = groups.flatMap((g) => g.definitions);

/**
 * Route a tool call to the correct group handler.
 * Iterates groups; first handler that returns a non-undefined result wins.
 */
export async function executeTool(name: string, args: unknown): Promise<unknown> {
  for (const group of groups) {
    const result = await group.handle(name, args);
    if (result !== undefined) return result;
  }
  throw new Error(`Unknown tool: ${name}`);
}
