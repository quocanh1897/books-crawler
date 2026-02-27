/**
 * Lightweight API request logger for binslib route handlers.
 *
 * Logs method, path, query params, response status, and duration to
 * stdout so they appear in `docker compose logs`.
 *
 * Usage in a route handler:
 *
 *   import { withLogging } from "@/lib/api-logger";
 *
 *   export const GET = withLogging(async (request: NextRequest) => {
 *     // ... existing handler code ...
 *     return NextResponse.json({ results });
 *   });
 *
 * Or for manual logging without the wrapper:
 *
 *   import { logApi } from "@/lib/api-logger";
 *
 *   export async function GET(request: NextRequest) {
 *     const t0 = performance.now();
 *     // ... handler code ...
 *     logApi(request, 200, performance.now() - t0, { results: items.length });
 *     return NextResponse.json({ results: items });
 *   }
 *
 * Log format (one line per request):
 *   [API] GET /api/search?scope=books&source=all&q=th%E1%BA%BF+gi%E1%BB%9Bi → 200 (12ms) {results: 5}
 *   [API] GET /api/books/by-slug/de-ba/chapters/42 → 200 (3ms)
 *   [API] GET /api/search?q=x → 200 (1ms) {results: 0}
 */

import { NextRequest, NextResponse } from "next/server";

// ── Manual logging ───────────────────────────────────────────────────────────

/**
 * Log an API request to stdout.
 *
 * @param request  The incoming request (used for method + URL).
 * @param status   HTTP status code of the response.
 * @param ms       Duration in milliseconds.
 * @param extra    Optional key-value pairs appended to the log line
 *                 (e.g. `{ results: 5 }` or `{ error: "not found" }`).
 */
export function logApi(
  request: NextRequest | Request,
  status: number,
  ms: number,
  extra?: Record<string, unknown>,
): void {
  const url = new URL(request.url);
  const path = url.pathname + (url.search || "");
  const method = request.method;
  const duration = ms < 1 ? "<1ms" : `${Math.round(ms)}ms`;

  let line = `[API] ${method} ${path} → ${status} (${duration})`;

  if (extra && Object.keys(extra).length > 0) {
    const parts = Object.entries(extra)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
    line += ` {${parts}}`;
  }

  console.log(line);
}

// ── Route handler wrapper ────────────────────────────────────────────────────

type RouteHandler = (
  request: NextRequest,
  context?: unknown,
) => Promise<NextResponse | Response> | NextResponse | Response;

/**
 * Wrap a Next.js route handler with automatic request logging.
 *
 * Logs the request on completion (or error) with status and duration.
 * Errors are caught, logged, and returned as 500 JSON responses.
 */
export function withLogging(handler: RouteHandler): RouteHandler {
  return async (request: NextRequest, context?: unknown) => {
    const t0 = performance.now();
    try {
      const response = await handler(request, context);
      const ms = performance.now() - t0;
      logApi(request, response.status, ms);
      return response;
    } catch (error) {
      const ms = performance.now() - t0;
      const message =
        error instanceof Error ? error.message : String(error);
      logApi(request, 500, ms, { error: message });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}
