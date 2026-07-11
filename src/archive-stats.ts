import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_STATS_DIR } from "./config.ts";
import { safeSessionId } from "./util.ts";

export interface ArchiveTotals {
  count: number;
  charsBefore: number;
  charsAfter: number;
  charsSaved: number;
}

const ZERO_TOTALS: ArchiveTotals = {
  count: 0,
  charsBefore: 0,
  charsAfter: 0,
  charsSaved: 0,
};

function normalizedInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeTotals(totals: Partial<ArchiveTotals>): ArchiveTotals {
  return {
    count: normalizedInteger(totals.count),
    charsBefore: normalizedInteger(totals.charsBefore),
    charsAfter: normalizedInteger(totals.charsAfter),
    charsSaved: normalizedInteger(totals.charsSaved),
  };
}

function isStoredTotals(value: unknown): value is ArchiveTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["count", "charsBefore", "charsAfter", "charsSaved"].every(
    (key) =>
      typeof record[key] === "number" &&
      Number.isInteger(record[key]) &&
      (record[key] as number) >= 0,
  );
}

export function archiveStatsPath(sessionId: unknown, dir = ARCHIVE_STATS_DIR): string {
  const id = safeSessionId(sessionId);
  return id ? join(dir, `${id}.json`) : "";
}

export async function readArchiveTotals(
  sessionId: unknown,
  dir = ARCHIVE_STATS_DIR,
): Promise<ArchiveTotals> {
  const path = archiveStatsPath(sessionId, dir);
  if (!path) return { ...ZERO_TOTALS };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isStoredTotals(parsed) ? parsed : { ...ZERO_TOTALS };
  } catch {
    return { ...ZERO_TOTALS };
  }
}

export async function writeArchiveTotals(
  sessionId: unknown,
  totals: Partial<ArchiveTotals>,
  dir = ARCHIVE_STATS_DIR,
): Promise<boolean> {
  const path = archiveStatsPath(sessionId, dir);
  if (!path) return false;
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(normalizeTotals(totals)), "utf8");
    await rename(tmp, path);
    return true;
  } catch {
    try {
      await unlink(tmp);
    } catch {
      // Nothing to clean up.
    }
    return false;
  }
}

export async function clearArchiveTotals(
  sessionId: unknown,
  dir = ARCHIVE_STATS_DIR,
): Promise<boolean> {
  const path = archiveStatsPath(sessionId, dir);
  if (!path) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}
