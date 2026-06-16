/**
 * utils/errors.ts — Error helpers
 */

/** Wrap an unknown thrown value into a proper Error for safe `.message` access. */
export function toError(e: unknown, defaultMsg: string = "Unknown error"): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === "object" && "message" in e) return new Error(String((e as any).message));
  return new Error(String(e ?? defaultMsg));
}