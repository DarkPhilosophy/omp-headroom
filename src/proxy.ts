import { PROXY_URL } from "./config.ts";

export function proxyPort(proxyUrl = PROXY_URL): number {
  try {
    return Number(new URL(proxyUrl).port || 8787);
  } catch {
    return 8787;
  }
}

export function proxyPath(path: string, proxyUrl = PROXY_URL): string {
  return `${proxyUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function modelUsesHeadroomProxy(
  model: { baseUrl?: unknown } | null | undefined,
  proxyUrl = PROXY_URL,
): boolean {
  if (typeof model?.baseUrl !== "string") return false;
  try {
    const target = new URL(model.baseUrl);
    const proxy = new URL(proxyUrl);
    const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    const sameEndpoint =
      target.port === proxy.port &&
      (target.origin === proxy.origin ||
        (loopback.has(target.hostname) && loopback.has(proxy.hostname)));
    return sameEndpoint && /\/(?:p\/[^/]+\/)?anthropic\/?$/.test(target.pathname);
  } catch {
    return false;
  }
}

export async function isProxyReady(proxyUrl = PROXY_URL): Promise<boolean> {
  try {
    const response = await fetch(proxyPath("/livez", proxyUrl), {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface LivezStatus {
  /** Proxy process is up and answering (liveness). */
  alive: boolean;
  /** Coarse health label from the proxy (`healthy` | `unhealthy` | ...). */
  status: string;
  /** `loop_health.known_failures` — non-zero means the proxy is degraded. */
  knownFailures: number;
  /** Proxy uptime in seconds, when reported. */
  uptimeSeconds?: number;
}

/**
 * Richer readiness probe than {@link isProxyReady}: returns the parsed
 * `/livez` payload so callers can distinguish three states that a boolean
 * collapses — "proxy dead" (`null`), "alive but unhealthy"
 * (`alive === true`, `status !== "healthy"`), and "ready"
 * (`alive && status === "healthy"`). The connect-with-retry loop uses this so
 * a slow cold-start (proxy blocked on model load, `/livez` itself timing out)
 * is retried with backoff instead of failing fast.
 */
export async function getLivez(proxyUrl = PROXY_URL): Promise<LivezStatus | null> {
  try {
    const response = await fetch(proxyPath("/livez", proxyUrl), {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      alive?: unknown;
      status?: unknown;
      uptime_seconds?: unknown;
      loop_health?: { known_failures?: unknown; status?: unknown } | null;
    };
    const loopHealth = body?.loop_health ?? {};
    return {
      alive: body?.alive === true,
      status: String(body?.status ?? loopHealth.status ?? "unknown"),
      knownFailures: Number(loopHealth.known_failures ?? 0),
      uptimeSeconds: typeof body?.uptime_seconds === "number" ? body.uptime_seconds : undefined,
    };
  } catch {
    return null;
  }
}
