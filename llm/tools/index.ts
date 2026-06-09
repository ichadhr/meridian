/**
 * llm/tools/index.ts — Tool System Gate
 *
 * The ONLY file imported by agent.ts for tool schemas and execution.
 * Re-exports from definitions.ts and executor.ts.
 *
 * Future: split definitions.ts into group files (screening, deployment, etc.)
 */

export { tools, type ToolDefinition } from "./definitions.js";
export { executeTool, registerCronRestarter, registerScreeningTrigger } from "./executor.js";
