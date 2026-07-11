import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// First-run provisioning contract: a missing headroom binary MUST trigger the
// plugin-owned install path on session_start, even when the daily autoupdate
// check is disabled. OMP_HEADROOM_AUTOUPDATE=0 turns off update polling only;
// it must never leave a fresh machine without a venv.

describe("plugin-owned provisioning", () => {
  test("session start provisions a missing venv even with autoupdate disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-provisioning-"));
    const script = `
      process.env.OMP_HEADROOM_BIN = process.argv[1];
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:1";
      process.env.OMP_HEADROOM_AUTOUPDATE = "0";
      process.env.OMP_HEADROOM_UV = "/nonexistent-headroom-test-uv";
      process.env.OMP_HEADROOM_PYTHON = "/bin/false";
      const mod = await import(process.argv[2] + "/src/index.ts");
      const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
      const handlers = new Map(), notices = [];
      mod.default({
        zod: fakeZod,
        setLabel(){},
        logger:{warn(){}},
        on:(event, handler)=>handlers.set(event, handler),
        registerTool(){},
        registerCommand(){},
        registerFlag(){},
      });
      const ctx = {
        hasUI: true,
        ui: { setWidget(){}, setStatus(){}, notify:(text)=>notices.push(String(text)) },
        sessionManager: { getSessionId: () => "provisioning-session", getBranch: () => [] },
      };
      await handlers.get("session_start")({}, ctx);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (notices.some((text) => text.includes("Installing headroom-ai"))) {
          process.stdout.write("ok");
          process.exit(0);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      process.stderr.write(JSON.stringify(notices));
      process.exit(3);
    `;
    const child = Bun.spawnSync(
      ["bun", "-e", script, join(root, "venv", "bin", "headroom"), `${import.meta.dir}/..`],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );
    try {
      if (child.exitCode !== 0) {
        throw new Error(
          `child exited ${child.exitCode}\n--- notices ---\n${child.stderr.toString() || "(none)"}`,
        );
      }
      expect(child.stdout.toString()).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
