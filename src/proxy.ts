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
