/**
 * external/caller.ts — HTTP Transport Layer
 *
 * Shared HTTP client used by all provider subfolders.
 * Pure infrastructure: retry, backoff, timeout. No knowledge of providers or data shapes.
 */

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  retry?: number;
  timeout?: number;
}

/**
 * Low-level HTTP call with retry, exponential backoff, and timeout.
 * Used by all provider files for their HTTP requests.
 */
export async function call<T = unknown>(
  url: string,
  options: CallOptions = {},
): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    retry = 3,
    timeout = 15_000,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retry) {
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
