import { RETRIEVED_MARKER } from "./config.ts";
import { isRecord } from "./util.ts";

export async function retrieveViaProxy(
  proxyUrl: string,
  hash: string,
  query: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  try {
    const response = await fetch(new URL("/v1/retrieve", proxyUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client": "omp" },
      body: JSON.stringify(query ? { hash, query } : { hash }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok)
      return {
        error:
          isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
        hash,
      };
    return data;
  } catch (error) {
    return { error: String(error), hash };
  }
}

export function stringifyRetrieveResult(data: unknown, hash: string, fallback = false): string {
  let body: string;
  if (!isRecord(data)) body = String(data);
  else if (typeof data.original_content === "string") body = data.original_content;
  else if (Array.isArray(data.results)) body = JSON.stringify(data.results, null, 2);
  else body = JSON.stringify(data, null, 2);

  const note = fallback ? "; local fallback (full original)" : "";
  return `${RETRIEVED_MARKER}hash=${hash || "?"}${note}; original content — do not re-compress]\n${body}`;
}
