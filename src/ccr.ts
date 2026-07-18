// Compression-Cache-Retrieval (CCR) fallback store. Persists the full
// originals of compressed payloads to disk so headroom_retrieve keeps working
// even after the proxy's in-memory TTL expires.
import { type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CCR_DIR } from "./config.ts";
import { shared } from "./state.ts";
import type { HeadroomCtx, HeadroomState } from "./types.ts";
import { isMainSession, safeSessionId } from "./util.ts";

export interface CcrClearResult {
  cleared: boolean;
  deletedFiles: number;
  retainedEntries: number;
}

export function ccrSessionDir(sessionId: unknown, dir = CCR_DIR): string {
  const id = safeSessionId(sessionId);
  return id ? join(dir, id) : "";
}

export function ccrFallbackPath(hash: unknown, dir = CCR_DIR, sessionId?: unknown): string {
  const slug = typeof hash === "string" ? hash : "";
  if (!/^[0-9A-Za-z_-]{8,128}$/.test(slug)) return "";
  if (sessionId === undefined) return join(dir, `${slug}.txt`);
  const sessionDir = ccrSessionDir(sessionId, dir);
  return sessionDir ? join(sessionDir, `${slug}.txt`) : "";
}

export async function readCcrFallback(
  hash: unknown,
  dir = CCR_DIR,
  sessionId?: unknown,
): Promise<string | undefined> {
  const paths =
    sessionId === undefined
      ? [ccrFallbackPath(hash, dir)]
      : [ccrFallbackPath(hash, dir, sessionId), ccrFallbackPath(hash, dir)];
  for (const file of paths) {
    if (!file) continue;
    try {
      return await readFile(file, "utf8");
    } catch {
      // Try the legacy unowned fallback after a session-scoped miss.
    }
  }
  return undefined;
}

function storageSessionId(
  state: HeadroomState | null | undefined,
  ctx: HeadroomCtx | null | undefined,
): string {
  return safeSessionId(ctx?.sessionManager?.getSessionId?.()) || safeSessionId(state?.sessionId);
}

async function writeSessionOriginal(
  hash: string,
  originalText: string,
  sessionId: string,
  overwrite: boolean,
): Promise<boolean> {
  const dir = ccrSessionDir(sessionId);
  const file = ccrFallbackPath(hash, CCR_DIR, sessionId);
  if (!dir || !file) return false;
  await mkdir(dir, { recursive: true });
  if (!overwrite && existsSync(file)) return true;
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, originalText, "utf8");
    await rename(tmp, file);
    return true;
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

function compressionHashes(
  result: { ccrHashes?: unknown } | null | undefined,
  compressedText: unknown,
): Set<string> {
  const hashes = new Set<string>();
  if (Array.isArray(result?.ccrHashes)) {
    for (const hash of result.ccrHashes) {
      if (ccrFallbackPath(hash)) hashes.add(hash as string);
    }
  }
  if (typeof compressedText === "string") {
    for (const match of compressedText.matchAll(/hash=([0-9a-f]{8,})/g)) {
      const hash = match[1] as string;
      if (ccrFallbackPath(hash)) hashes.add(hash);
    }
  }
  return hashes;
}

export async function persistCcrOriginal(
  result: { ccrHashes?: unknown } | null | undefined,
  originalText: unknown,
  compressedText: unknown,
  state: HeadroomState | null | undefined,
  ctx: HeadroomCtx | null | undefined,
): Promise<number> {
  try {
    // Some Headroom versions expose hashes only through inline retrieval markers.
    const hashes = compressionHashes(result, compressedText);
    const sessionId = storageSessionId(state, ctx);
    if (hashes.size === 0 || typeof originalText !== "string" || !originalText || !sessionId) {
      return 0;
    }
    await Promise.all(
      [...hashes].map((hash) => writeSessionOriginal(hash, originalText, sessionId, true)),
    );
    // Count exactly 1 CCR per successful save — NOT hashes.size (which re-counts
    // old hashes from compressed text and causes exponential growth).
    if (state && ctx) {
      if (isMainSession(ctx)) state.ccrHashes += 1;
      else shared.foreignCcr += 1;
    }
    return 1;
  } catch {
    // Best effort: the proxy store remains the primary source.
    return 0;
  }
}

export interface CcrBatchEntry {
  originalText: string;
  compressedText: string;
}

export async function persistCcrOriginalBatch(
  entries: CcrBatchEntry[],
  state: HeadroomState | null | undefined,
  ctx: HeadroomCtx | null | undefined,
): Promise<number> {
  try {
    const sessionId = storageSessionId(state, ctx);
    if (!sessionId || entries.length === 0) return 0;
    const originalsByHash = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.originalText) return 0;
      const hashes = compressionHashes(undefined, entry.compressedText);
      if (hashes.size === 0) return 0;
      for (const hash of hashes) {
        const existing = originalsByHash.get(hash);
        if (existing !== undefined && existing !== entry.originalText) return 0;
        originalsByHash.set(hash, entry.originalText);
      }
    }
    await Promise.all(
      [...originalsByHash].map(([hash, original]) =>
        writeSessionOriginal(hash, original, sessionId, true),
      ),
    );
    if (state && ctx) {
      if (isMainSession(ctx)) state.ccrHashes += entries.length;
      else shared.foreignCcr += entries.length;
    }
    return entries.length;
  } catch {
    return 0;
  }
}

// Persist a CCR archive by explicit hash (used by session.compacting to archive
// full-session originals before OMP's native LLM summarization). Atomic write.
export async function persistCcrByHash(
  hash: unknown,
  originalText: unknown,
  state: HeadroomState | null | undefined,
  ctx: HeadroomCtx | null | undefined,
): Promise<number> {
  if (!hash || typeof originalText !== "string" || !originalText) return 0;
  try {
    const sessionId = storageSessionId(state, ctx);
    const slug = typeof hash === "string" && ccrFallbackPath(hash) ? hash : "";
    if (!sessionId || !slug) return 0;
    if (!(await writeSessionOriginal(slug, originalText, sessionId, false))) return 0;
    if (state && ctx) {
      if (isMainSession(ctx)) state.ccrHashes += 1;
      else shared.foreignCcr += 1;
    }
    return 1;
  } catch {
    return 0;
  }
}

export async function clearCcrSession(sessionId: unknown, dir = CCR_DIR): Promise<CcrClearResult> {
  const sessionDir = ccrSessionDir(sessionId, dir);
  if (!sessionDir) return { cleared: false, deletedFiles: 0, retainedEntries: 0 };
  let entries: Dirent[];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return { cleared: absent, deletedFiles: 0, retainedEntries: 0 };
  }
  let deletedFiles = 0;
  let retainedEntries = 0;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      retainedEntries += 1;
      continue;
    }
    try {
      await unlink(join(sessionDir, entry.name));
      deletedFiles += 1;
    } catch {
      retainedEntries += 1;
    }
  }
  if (retainedEntries === 0) {
    try {
      await rmdir(sessionDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") retainedEntries += 1;
    }
  }
  return { cleared: retainedEntries === 0, deletedFiles, retainedEntries };
}
