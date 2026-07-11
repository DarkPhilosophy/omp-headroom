import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveStatsPath, readArchiveTotals, writeArchiveTotals } from "../src/archive-stats.ts";

const ZERO_TOTALS = { count: 0, charsBefore: 0, charsAfter: 0, charsSaved: 0 };
const SESSION_ID = "session-A_123";

async function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "headroom-archive-stats-"));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("archive stats persistence", () => {
  test("sanitizes session IDs and rejects traversal or malformed IDs", async () => {
    await withTempDir(async (dir) => {
      const validPath = archiveStatsPath(SESSION_ID, dir);
      expect(validPath).not.toBe("");
      expect(validPath).toContain(SESSION_ID);

      const invalidIds = ["", "../../escape", "session/id", "session id", "a".repeat(129)];
      for (const sessionId of invalidIds) {
        expect(archiveStatsPath(sessionId, dir)).toBe("");
        expect(await writeArchiveTotals(sessionId, { count: 1 }, dir)).toBe(false);
        expect(await readArchiveTotals(sessionId, dir)).toEqual(ZERO_TOTALS);
      }

      expect(readdirSync(dir)).toHaveLength(0);
    });
  });

  test("atomically persists totals and reads the same values after a simulated restart", async () => {
    await withTempDir(async (dir) => {
      const totals = { count: 3, charsBefore: 120_000, charsAfter: 31_500, charsSaved: 88_500 };
      expect(await writeArchiveTotals(SESSION_ID, totals, dir)).toBe(true);

      const repo = `${import.meta.dir}/..`;
      const script = `
        const mod = await import(process.argv[3] + "/src/archive-stats.ts");
        const totals = await mod.readArchiveTotals(process.argv[2], process.argv[1]);
        process.stdout.write(JSON.stringify(totals));
      `;
      const child = spawnSync("bun", ["-e", script, dir, SESSION_ID, repo], {
        encoding: "utf8",
      });

      if (child.status !== 0) {
        throw new Error(
          `child exited ${child.status}\n--- stderr ---\n${child.stderr || "(none)"}`,
        );
      }
      expect(JSON.parse(child.stdout)).toEqual(totals);
    });
  });

  test("missing or malformed stats fail closed to zero totals", async () => {
    await withTempDir(async (dir) => {
      expect(await readArchiveTotals(SESSION_ID, dir)).toEqual(ZERO_TOTALS);

      const path = archiveStatsPath(SESSION_ID, dir);
      writeFileSync(path, "{ not valid json", "utf8");
      expect(await readArchiveTotals(SESSION_ID, dir)).toEqual(ZERO_TOTALS);

      writeFileSync(path, JSON.stringify({ count: "wrong", charsBefore: null }), "utf8");
      expect(await readArchiveTotals(SESSION_ID, dir)).toEqual(ZERO_TOTALS);
    });
  });

  test("a second write atomically replaces totals without accumulating or leaving temp files", async () => {
    await withTempDir(async (dir) => {
      const first = { count: 2, charsBefore: 10_000, charsAfter: 4_000, charsSaved: 6_000 };
      const second = { count: 1, charsBefore: 7_500, charsAfter: 2_500, charsSaved: 5_000 };

      expect(await writeArchiveTotals(SESSION_ID, first, dir)).toBe(true);
      expect(await writeArchiveTotals(SESSION_ID, second, dir)).toBe(true);
      expect(await readArchiveTotals(SESSION_ID, dir)).toEqual(second);

      const files = readdirSync(dir);
      expect(files.filter((name) => name.includes(".tmp")).length).toBe(0);
      expect(files).toHaveLength(1);
    });
  });

  test("writes normalize totals to nonnegative integers before persistence", async () => {
    await withTempDir(async (dir) => {
      expect(
        await writeArchiveTotals(
          SESSION_ID,
          { count: 3.9, charsBefore: -12, charsAfter: 4.8, charsSaved: -1 },
          dir,
        ),
      ).toBe(true);

      expect(await readArchiveTotals(SESSION_ID, dir)).toEqual({
        count: 3,
        charsBefore: 0,
        charsAfter: 4,
        charsSaved: 0,
      });
    });
  });
});

describe("archive stats resume integration", () => {
  test("real session_start hydrates archive totals into the widget without a provider request", async () => {
    await withTempDir(async (root) => {
      const sessionId = "resume-archive-1";
      const totals = {
        count: 3,
        charsBefore: 120_000,
        charsAfter: 31_500,
        charsSaved: 88_500,
      };
      const binPath = join(root, "venv", "bin", "headroom");
      const statsDir = join(root, "headroom-archive-stats");
      mkdirSync(join(root, "venv", "bin"), { recursive: true });
      writeFileSync(binPath, "", "utf8");
      expect(await writeArchiveTotals(sessionId, totals, statsDir)).toBe(true);

      const repo = `${import.meta.dir}/..`;
      const script = `
        process.env.OMP_HEADROOM_BIN = process.argv[1];
        process.env.OMP_HEADROOM_URL = "http://127.0.0.1:1";
        process.env.OMP_HEADROOM_AUTOUPDATE = "0";
        const mod = await import(process.argv[2] + "/src/index.ts");
        const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
        const handlers = new Map();
        let widgets = [];
        mod.default({
          zod: fakeZod,
          setLabel(){},
          logger:{warn(){}},
          on:(event, handler)=>handlers.set(event, handler),
          registerTool(){},
          registerCommand(){},
          registerFlag(){},
        });
        const start = handlers.get("session_start");
        if (typeof start !== "function") process.exit(2);
        const ctx = {
          hasUI: true,
          ui: {
            setWidget: (_key, lines) => { widgets = lines || []; },
            setStatus(){},
            notify(){},
          },
          sessionManager: {
            getSessionId: () => "resume-archive-1",
            getBranch: () => [],
          },
        };
        await start({}, ctx);
        const widgetText = JSON.stringify(widgets);
        if (!widgetText.includes("arch 88.5kch ×3")) process.exit(3);
        if (widgetText.includes("com ")) process.exit(5);
        await handlers.get("session_shutdown")?.({}, ctx);
        process.stdout.write("ok");
        process.exit(0);
      `;
      const child = spawnSync("bun", ["-e", script, binPath, repo], {
        encoding: "utf8",
      });

      try {
        if (child.status !== 0) {
          throw new Error(
            `child exited ${child.status}\n--- stderr ---\n${child.stderr || "(none)"}`,
          );
        }
        expect(child.stdout).toBe("ok");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
