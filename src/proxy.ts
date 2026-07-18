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
