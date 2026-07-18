import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runSessionStart(version) {
  const root = mkdtempSync(join(tmpdir(), "headroom-prewarm-"));
  const binPath = join(root, "venv", "bin", "headroom");
  const script = `
    process.env.OMP_HEADROOM_BIN = process.argv[1];
    process.env.OMP_HEADROOM_AUTOUPDATE = "0";
    const compressionRequests = [];
    let statsRequests = 0;
    const version = process.argv[3];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/v1/compress")) {
          compressionRequests.push({
            path,
            warmup: request.headers.get("X-Headroom-Warmup"),
          });
          const body = await request.json();
          return Response.json({
            messages: body.messages,
            tokens_before: 100,
            tokens_after: 100,
            tokens_saved: 0,
            ccr_hashes: [],
          });
        }
        if (path.endsWith("/stats")) {
          statsRequests++;
          return Response.json({ savings: { per_project: {} } });
        }
        return Response.json({ status: "healthy", ready: true, version });
      },
    });
    process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
    const mod = await import(process.argv[2] + "/src/index.ts");
    const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
    const handlers = new Map();
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
      ui: { setWidget(){}, setStatus(){}, notify(){} },
      sessionManager: { getSessionId: () => "prewarm-accounting", getBranch: () => [] },
    };
    await handlers.get("session_start")({}, ctx);
    const deadline = Date.now() + 4000;
    while (statsRequests === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    await Bun.sleep(100);
    await server.stop(true);
    console.log(JSON.stringify({ compressionRequests, statsRequests }));
    process.exit(0);
  `;
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  writeFileSync(binPath, `#!/bin/sh\necho headroom ${version}\n`);
  chmodSync(binPath, 0o755);
  const result = Bun.spawnSync(["bun", "-e", script, binPath, `${import.meta.dir}/..`, version], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  try {
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("proxy startup accounting", () => {
  test("current Headroom uses native startup preload without a synthetic request", () => {
    const observed = runSessionStart("0.32.0");
    expect(observed.statsRequests).toBeGreaterThan(0);
    expect(observed.compressionRequests).toEqual([]);
  }, 10_000);
});
