/**
 * llm/index.ts — LLM Gate
 *
 * All outside code imports from here. Never import llm/ sub-files directly.
 */

export { agentLoop } from "./agent.js";
export type { AgentLoopOptions, AgentLoopResult } from "./agent.js";
export { buildSystemPrompt } from "./prompt.js";
export { tools, executeTool } from "./tools/index.js";
export { studyTopLPers } from "./tools/study.js";
export type { ToolDefinition } from "./tools/index.js";
