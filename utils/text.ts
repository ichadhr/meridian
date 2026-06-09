/**
 * Text utility functions — shared by live cycle modules.
 */

/** Strip <think>...</think> reasoning blocks that some models leak into output */
export function stripThink(text: string | null | undefined): string {
  if (!text) return text || "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/** Sanitize untrusted text for safe injection into LLM prompts */
export function sanitizeUntrustedPromptText(text: any, maxLen: number = 500): string | null {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}
