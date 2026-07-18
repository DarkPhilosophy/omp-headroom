#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [packageRootArg, homeArg] = process.argv.slice(2);
if (!packageRootArg || !homeArg) {
  throw new Error("usage: bun .scripts/packed-plugin-smoke.mjs <package-root> <temporary-home>");
}
if (process.env.OMP_HEADROOM_BIN !== undefined || process.env.OMP_HEADROOM_MODULE !== undefined) {
  throw new Error("OMP_HEADROOM_BIN and OMP_HEADROOM_MODULE must be unset");
}

const packageRoot = resolve(packageRootArg);
const home = resolve(homeArg);
const expectedBin = join(home, ".omp", "agent", "headroom-venv", "bin", "headroom");
const invocationLog = join(home, "headroom-smoke-invocation.log");
mkdirSync(join(home, ".omp", "agent", "headroom-venv", "bin"), { recursive: true });
writeFileSync(expectedBin, '#!/bin/sh\nprintf "%s" "$*" > "$HEADROOM_SMOKE_LOG"\nexit 0\n');
chmodSync(expectedBin, 0o755);

const env = { ...process.env };
delete env.OMP_HEADROOM_BIN;
delete env.OMP_HEADROOM_MODULE;
Object.assign(env, {
  HOME: home,
  PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
  HEADROOM_SMOKE_LOG: invocationLog,
  OMP_HEADROOM_AUTOUPDATE: "0",
  OMP_HEADROOM_URL: "http://127.0.0.1:9",
  OMP_HEADROOM_SYSTEMD_UNIT: "omp-headroom-packed-smoke.service",
  OMP_HEADROOM_RAINBOW_MS: "60000",
  OPENAI_API_KEY: "release-smoke-placeholder",
  OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
});

const child = Bun.spawn(
  ["omp", "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules"],
  { cwd: packageRoot, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

const deadline = Date.now() + 12_000;
while (Date.now() < deadline && !existsSync(invocationLog) && child.exitCode === null) {
  await Bun.sleep(25);
}
if (child.exitCode === null) child.kill("SIGTERM");
await child.exited;

if (!existsSync(invocationLog)) {
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  throw new Error(
    `real OMP did not invoke the default headroom executable\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  );
}
const invocation = readFileSync(invocationLog, "utf8").trim();
if (!invocation.startsWith("proxy --host 127.0.0.1 --port ")) {
  throw new Error(`unexpected headroom invocation: ${invocation}`);
}
console.log(`installed OMP plugin smoke passed: ${expectedBin}`);
