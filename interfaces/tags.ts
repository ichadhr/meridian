/**
 * interfaces/tags.ts — Message tags (shared across all platforms)
 *
 * Used by Telegram, Discord, Slack, etc. to tag paper-trading messages.
 * Import from this file, NOT from platform-specific modules.
 */

const IS_DRY_RUN = process.env.DRY_RUN === "true";

/** Prefix a message with (DRY RUN) when in paper-trading mode. */
export function dryRunTag(text: string): string {
  return IS_DRY_RUN ? `(DRY RUN) ${text}` : text;
}

/** Append (DRY RUN) to a title when in paper-trading mode. */
export function dryRunTitle(title: string): string {
  return IS_DRY_RUN ? `${title} (DRY RUN)` : title;
}
