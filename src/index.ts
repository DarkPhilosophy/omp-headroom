// OMP Headroom integration: context compression + CCR retrieval tools.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { clearArchiveTotals, readArchiveTotals, writeArchiveTotals } from "./archive-stats.ts";
import {
  ccrFallbackPath,
  clearCcrSession,
  persistCcrByHash,
  persistCcrOriginal,
  persistCcrOriginalBatch,
  readCcrFallback,
} from "./ccr.ts";
import { commandHelpLines, completeHeadroomCommand } from "./commands.ts";
import {
  adaptiveMinChars,
  isBeneficialCompressionResult,
  normalizeCompressionResult,
  payloadCharTotal,
} from "./compression.ts";
import {
  _cfg,
  ANTHROPIC_COMPRESSION_ENABLED,
  ANTHROPIC_MIN_TOOL_TEXT_CHARS,
  AUTOUPDATE,
  CODE_AWARE,
  COMPRESS_TOOL,
  COMPRESSED_MARKER,
  DEBUG_SIZING,
  EXTENSION_KEY,
  effectiveSettingValue,
  HEADROOM_BIN,
  HEADROOM_CONFIG_PATH,
  HEADROOM_SETTINGS,
  invalidSettingValue,
  LOGS_DIR,
  MIN_TOOL_TEXT_CHARS,
  PACKAGE_ROOT,
  PACKAGE_SPEC,
  PROVIDER_MIN_TEXT_CHARS,
  PROVIDER_TIMEOUT_MS,
  PROXY_EXTRA_ARGS,
  PROXY_URL,
  PYPI_JSON_URL,
  parseSettingValue,
  RAINBOW_CODES,
  RAINBOW_MS,
  READY_TTL_MS,
  RESPONSES_COMPRESS_CONCURRENCY,
  RETRIEVE_TOOL,
  RETRIEVED_MARKER,
  SESSION_ARCHIVE_ENABLED,
  STATS_MIN_INTERVAL_MS,
  STATS_TOOL,
  saveHeadroomConfigKey,
  settingSource,
  TOOL_TIMEOUT_MS,
  UPDATE_INTERVAL_MS,
  UPDATE_LOCK_FILE,
  UPDATE_STATE_FILE,
  VENV_DIR,
  VENV_PYTHON,
  WIDGET_PLACEMENT,
} from "./config.ts";
import {
  effectiveProviderFormat,
  payloadHasRetrieveTool,
  providerPayloadHasCompressionCandidate,
  RETRIEVE_DESCRIPTION,
  responseOutputText,
  systemToText,
} from "./provider.ts";
import { isProxyReady, modelUsesHeadroomProxy, proxyPath, proxyPort } from "./proxy.ts";
import { pipInstallInvocation, venvInvocation } from "./python-env.ts";
import { parseServiceAction, renderHeadroomUserService } from "./service.ts";
import {
  asAnthropicArchiveMessage,
  createResponsesSessionCompaction,
  createSessionCompaction,
  expandSessionArchiveText,
  type SessionArchiveCandidate,
} from "./session-archive.ts";
import { createHeadroomState, readForeignTotals, shared, subagentSessionIds } from "./state.ts";
import { retrieveViaProxy, stringifyRetrieveResult } from "./tools.ts";
import {
  asNumber,
  clip,
  getTextBlocks,
  isMainSession,
  isNewer,
  isRecord,
  safeSessionId,
  stableJson,
} from "./util.ts";
import {
  archiveSavingsPercent,
  cacheUsageLine,
  commandSummary,
  localCompressionLine,
  renderWidget,
} from "./widget.ts";

export {
  adaptiveMinChars,
  archiveSavingsPercent,
  cacheUsageLine,
  isBeneficialCompressionResult,
  isProxyReady,
  localCompressionLine,
  modelUsesHeadroomProxy,
  normalizeCompressionResult,
  payloadCharTotal,
  providerPayloadHasCompressionCandidate,
  proxyPath,
  proxyPort,
};

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

interface ExtensionToolRegistrar {
  registerTool(definition: unknown): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uvBin() {
  if (process.env.OMP_HEADROOM_UV) return process.env.OMP_HEADROOM_UV;
  const local = join(homedir(), ".local", "bin", "uv");
  return existsSync(local) ? local : "uv";
}

const PYTHON_BIN = process.env.OMP_HEADROOM_PYTHON ?? "python3";
let uvAvailable: boolean | undefined;

function run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let out = "";
    let err = "";
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, out, err: errorMessage(error) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: errorMessage(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

async function canUseUv() {
  if (uvAvailable === undefined) {
    uvAvailable = (await run(uvBin(), ["--version"], 10_000)).code === 0;
  }
  return uvAvailable;
}

async function createHeadroomVenv() {
  const invocation = venvInvocation({
    useUv: await canUseUv(),
    uv: uvBin(),
    python: PYTHON_BIN,
    venvDir: VENV_DIR,
  });
  return run(invocation.command, invocation.args, 120_000);
}

async function installPythonPackages(packages: string[], timeoutMs: number) {
  const invocation = pipInstallInvocation({
    useUv: await canUseUv(),
    uv: uvBin(),
    venvPython: VENV_PYTHON,
    packages,
  });
  return run(invocation.command, invocation.args, timeoutMs);
}

const SYSTEMD_UNIT = process.env.OMP_HEADROOM_SYSTEMD_UNIT ?? "headroom-proxy.service";
const USER_SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const USER_SYSTEMD_UNIT_PATH = join(USER_SYSTEMD_DIR, SYSTEMD_UNIT);
let systemdUnitKnown: boolean | undefined;

async function systemdUnitAvailable() {
  if (!SYSTEMD_UNIT) return false;
  if (systemdUnitKnown === undefined) {
    const result = await run("systemctl", ["--user", "cat", SYSTEMD_UNIT], 5_000);

    systemdUnitKnown = result.code === 0;
  }
  return systemdUnitKnown;
}

interface HeadroomToolTranscript {
  source: string;
  compressed: string;
  details: unknown;
}

// Whether the proxy systemd unit is currently active (running). Used to avoid
// re-issuing `start` on a unit that is already up — a busy proxy can be slow to
// answer /livez, and a redundant restart wrongly parks the widget in "starting".
async function systemdUnitActive() {
  if (!SYSTEMD_UNIT) return false;
  const result = await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT], 5_000);
  return result.out.trim() === "active";
}

function systemdCtl(verb, args: string[] = []) {
  return run("systemctl", ["--user", verb, ...args, SYSTEMD_UNIT], 30_000);
}

function serviceActionUsage() {
  return "Usage: /headroom service <install|uninstall|status>";
}

function commandFailure(result) {
  const detail = (result.err || result.out).trim();
  return detail ? clip(detail, 200) : `exit code ${result.code}`;
}

async function manageHeadroomUserService(action, ctx, state) {
  if (action === "status") {
    const configured = existsSync(USER_SYSTEMD_UNIT_PATH) || (await systemdUnitAvailable());
    const active = await systemdUnitActive();
    ctx.ui.notify(
      `Headroom user service:\n  unit: ${configured ? "configured" : "not configured"}\n  status: ${active ? "active" : "inactive"}\n  path: ${USER_SYSTEMD_UNIT_PATH}`,
      "info",
    );
    return;
  }

  if (action === "install") {
    if (!existsSync(HEADROOM_BIN)) await maintainInstall(ctx, state, true);
    if (!existsSync(HEADROOM_BIN)) {
      ctx.ui.notify(
        `Headroom service was not installed because its executable is missing: ${HEADROOM_BIN}${state.lastError ? `\n${state.lastError}` : ""}`,
        "error",
      );
      return;
    }

    const unit = renderHeadroomUserService(HEADROOM_BIN, proxyPort());
    if (existsSync(USER_SYSTEMD_UNIT_PATH)) {
      const existing = readFileSync(USER_SYSTEMD_UNIT_PATH, "utf8");
      if (existing !== unit) {
        ctx.ui.notify(
          `Headroom user service already exists at ${USER_SYSTEMD_UNIT_PATH}; it was not replaced because its contents differ from this release. Review or remove it, then rerun /headroom service install.`,
          "warn",
        );
        return;
      }
    } else {
      mkdirSync(USER_SYSTEMD_DIR, { recursive: true });
      writeFileSync(USER_SYSTEMD_UNIT_PATH, unit, "utf8");
    }

    const reload = await run("systemctl", ["--user", "daemon-reload"], 30_000);
    if (reload.code !== 0) {
      ctx.ui.notify(`systemctl daemon-reload failed: ${commandFailure(reload)}`, "error");
      return;
    }
    const enabled = await systemdCtl("enable", ["--now"]);
    if (enabled.code !== 0) {
      ctx.ui.notify(`systemctl enable --now failed: ${commandFailure(enabled)}`, "error");
      return;
    }
    systemdUnitKnown = true;
    state.proxyReady = await isProxyReady();
    state.proxyStarting = false;
    state.proxyCheckedAt = Date.now();
    ctx.ui.notify(
      `Headroom user service installed and enabled.\n  unit: ${USER_SYSTEMD_UNIT_PATH}\n  proxy: ${state.proxyReady ? "ready" : "starting"}`,
      "info",
    );
    return;
  }

  if (existsSync(USER_SYSTEMD_UNIT_PATH) || (await systemdUnitAvailable())) {
    const disabled = await systemdCtl("disable", ["--now"]);
    if (disabled.code !== 0) {
      ctx.ui.notify(`systemctl disable --now failed: ${commandFailure(disabled)}`, "error");
      return;
    }
  }
  if (existsSync(USER_SYSTEMD_UNIT_PATH)) unlinkSync(USER_SYSTEMD_UNIT_PATH);
  const reload = await run("systemctl", ["--user", "daemon-reload"], 30_000);
  if (reload.code !== 0) {
    ctx.ui.notify(`systemctl daemon-reload failed: ${commandFailure(reload)}`, "error");
    return;
  }
  systemdUnitKnown = false;
  state.proxyReady = await isProxyReady();
  state.proxyStarting = false;
  state.proxyCheckedAt = Date.now();
  ctx.ui.notify("Headroom user service disabled and removed.", "info");
}

async function restartProxy(ctx, state) {
  const ownedProcess = state.proxyProcess;
  if (ownedProcess) {
    ownedProcess.kill("SIGTERM");
    state.proxyProcess = undefined;
    await sleep(500);
  }
  if (await systemdUnitAvailable()) {
    const result = await systemdCtl("restart");
    if (result.code !== 0) {
      state.lastError = `systemctl restart failed: ${clip(result.err.trim(), 200)}`;
      return false;
    }
  } else if (!ownedProcess && (await isProxyReady())) {
    state.proxyReady = true;
    state.proxyStarting = false;
    state.lastError =
      "Refusing to restart an unowned Headroom proxy; use the service manager that owns it.";
    renderWidget(ctx, state);
    return false;
  }
  state.proxyReady = false;
  state.proxyStarting = false;
  return ensureProxy(ctx, state, 25_000);
}

async function installedVersion() {
  if (!existsSync(VENV_PYTHON)) return "";
  const result = await run(
    VENV_PYTHON,
    ["-c", "from importlib.metadata import version;print(version('headroom-ai'))"],
    15_000,
  );
  return result.code === 0 ? result.out.trim() : "";
}

async function latestPypiVersion() {
  try {
    const response = await fetch(PYPI_JSON_URL, { signal: AbortSignal.timeout(6_000) });
    if (!response.ok) return "";
    const data = await response.json();
    return typeof data?.info?.version === "string" ? data.info.version : "";
  } catch {
    return "";
  }
}

function readUpdateStamp() {
  try {
    return JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeUpdateStamp(stamp) {
  try {
    writeFileSync(UPDATE_STATE_FILE, JSON.stringify(stamp));
  } catch {
    // Best effort.
  }
}

function acquireUpdateLock() {
  try {
    writeFileSync(UPDATE_LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      // Self-steal: if the lock contains OUR OWN PID, a previous
      // doMaintainInstall in this same process crashed without
      // releasing (e.g. unhandled rejection bypassing finally).
      // Safe to reclaim — no other update can be in flight.
      const lockPid = readFileSync(UPDATE_LOCK_FILE, "utf8").trim();
      if (lockPid === String(process.pid)) {
        writeFileSync(UPDATE_LOCK_FILE, String(process.pid));
        return true;
      }
      // Stale after 45 min (previous OMP session crashed mid-update).
      if (Date.now() - statSync(UPDATE_LOCK_FILE).mtimeMs > 45 * 60_000) {
        writeFileSync(UPDATE_LOCK_FILE, String(process.pid));
        return true;
      }
    } catch {
      // Lock vanished mid-check; do not race for it.
    }
    return false;
  }
}

function releaseUpdateLock() {
  try {
    unlinkSync(UPDATE_LOCK_FILE);
  } catch {
    // Already gone.
  }
}

let maintenanceInFlight: Promise<void> | undefined;

// ROCm torch survival: a `headroom` upgrade pulls torch from the default (CUDA)
// PyPI index, which silently replaces the ROCm build and breaks GPU kompress
// (cuda.is_available goes False, kompress falls back to slow CPU). After any
// upgrade we detect whether the venv was ROCm and re-pin the ROCm torch from
// the ROCm wheel index. Override the pinned build/index via env if a newer
// ROCm wheel is needed. Inert on a CUDA venv (isRocmVenv returns false).
const ROCM_TORCH_SPEC = process.env.OMP_HEADROOM_ROCM_TORCH || "torch==2.9.1+rocm6.4";
const ROCM_TORCH_INDEX =
  process.env.OMP_HEADROOM_ROCM_INDEX || "https://download.pytorch.org/whl/rocm6.4";
async function isRocmVenv() {
  if (!existsSync(VENV_PYTHON)) return false;
  try {
    const r = await run(
      VENV_PYTHON,
      ["-c", "import torch,sys; sys.exit(0 if '+rocm' in torch.__version__ else 1)"],
      15_000,
    );
    return r.code === 0;
  } catch {
    return false;
  }
}
async function repinRocmTorch() {
  const r = await installPythonPackages(
    [ROCM_TORCH_SPEC, "--index-url", ROCM_TORCH_INDEX],
    600_000,
  );
  if (r.code !== 0) throw new Error(`ROCm torch re-pin failed: ${clip(r.err.trim(), 300)}`);
}
// Hardware AMD GPU detection. Unlike isRocmVenv() (which inspects
// torch.__version__ — already CUDA right after a fresh [all] install), this
// reads the DRM vendor ID directly, so it works BEFORE any torch is present.
// AMD PCI vendor id = 0x1002. Inert on non-Linux / no sysfs.
function detectAmdGpu() {
  try {
    for (const card of readdirSync("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      const vendorPath = join("/sys/class/drm", card, "device/vendor");
      if (existsSync(vendorPath) && readFileSync(vendorPath, "utf8").trim() === "0x1002")
        return true;
    }
  } catch {
    /* not Linux or sysfs unavailable */
  }
  return false;
}
function maintainInstall(ctx, state, force = false) {
  if (!maintenanceInFlight) {
    maintenanceInFlight = doMaintainInstall(ctx, state, force).finally(() => {
      maintenanceInFlight = undefined;
    });
  }
  return maintenanceInFlight;
}

async function doMaintainInstall(ctx, state, force) {
  try {
    if (!existsSync(HEADROOM_BIN)) {
      if (!acquireUpdateLock()) return;
      try {
        state.installState = "installing";
        renderWidget(ctx, state);
        ctx?.ui?.notify?.(`Installing ${PACKAGE_SPEC} into ${VENV_DIR}…`, "info");
        if (!existsSync(VENV_PYTHON)) {
          const venv = await createHeadroomVenv();
          if (venv.code !== 0) {
            throw new Error(`Python venv creation failed: ${clip(venv.err.trim(), 200)}`);
          }
        }
        const install = await installPythonPackages([PACKAGE_SPEC], 1_800_000);
        if (install.code !== 0)
          throw new Error(`headroom install failed: ${clip(install.err.trim(), 300)}`);
        // A fresh [all] install pulls CUDA torch even on AMD GPUs. Detect
        // the hardware and re-pin the ROCm build so GPU kompression works.
        if (detectAmdGpu()) {
          try {
            await repinRocmTorch();
          } catch (e) {
            ctx?.ui?.notify?.(`ROCm torch re-pin failed: ${clip(errorMessage(e), 120)}`, "warn");
          }
        }
        state.installState = "";
        state.version = await installedVersion();
        writeUpdateStamp({ checkedAt: Date.now(), latest: state.version });
        ctx?.ui?.notify?.(`Headroom ${state.version} installed.`, "info");
      } finally {
        releaseUpdateLock();
      }
      return;
    }

    // AUTOUPDATE only disables the daily update poll. First-time provisioning
    // above must always run: a missing venv is a broken install, not an update.
    if (!AUTOUPDATE && !force) return;
    if (!state.version) state.version = await installedVersion();
    const stamp = readUpdateStamp();
    if (!force && stamp.checkedAt && Date.now() - stamp.checkedAt < UPDATE_INTERVAL_MS) {
      if (typeof stamp.latest === "string" && stamp.latest) state.latest = stamp.latest;
    } else {
      const latest = await latestPypiVersion();
      if (latest) {
        state.latest = latest;
        writeUpdateStamp({ checkedAt: Date.now(), latest });
      }
    }
    if (!isNewer(state.latest, state.version)) return;

    if (!acquireUpdateLock()) return;
    try {
      const wasRocm = (await isRocmVenv()) || detectAmdGpu();
      state.installState = "updating";
      renderWidget(ctx, state);
      const upgrade = await installPythonPackages(["--upgrade", PACKAGE_SPEC], 1_800_000);
      if (upgrade.code !== 0)
        throw new Error(`headroom update failed: ${clip(upgrade.err.trim(), 300)}`);
      state.installState = "";
      state.version = await installedVersion();
      writeUpdateStamp({ checkedAt: Date.now(), latest: state.version });
      if (wasRocm) await repinRocmTorch();
      const restarted = await restartProxy(ctx, state);
      ctx?.ui?.notify?.(
        restarted
          ? `Headroom updated to ${state.version}; proxy restarted.`
          : `Headroom updated to ${state.version}, but ${state.lastError || "the proxy restart is still pending."}`,
        restarted ? "info" : "warn",
      );
    } finally {
      releaseUpdateLock();
    }
  } catch (error) {
    state.installState = "";
    state.lastError = errorMessage(error);
  } finally {
    renderWidget(ctx, state);
  }
}

// Check whether the systemd unit's ExecStart points to our HEADROOM_BIN.
// Used to diagnose stale-proxy mismatches without auto-restarting a
// user-managed shared service.
async function systemdExecStartMatches() {
  if (!SYSTEMD_UNIT) return false;
  try {
    const result = await run("systemctl", ["--user", "cat", SYSTEMD_UNIT], 5_000);
    if (result.code !== 0) return false;
    const execLine = result.out.split("\n").find((l) => l.trim().startsWith("ExecStart="));
    return typeof execLine === "string" && execLine.includes(HEADROOM_BIN);
  } catch {
    return false;
  }
}

async function reconcileProxyVersion(ctx, state) {
  if (!AUTOUPDATE || !state.proxyReady) return;
  try {
    const response = await fetch(proxyPath("/livez"), {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return;
    const live = await response.json();
    const liveVersion = typeof live?.version === "string" ? live.version : "";
    if (!state.version) state.version = await installedVersion();
    if (!liveVersion || !state.version || liveVersion === state.version) {
      state.reconcileKey = "";
      return;
    }
    if (await systemdUnitActive()) {
      // The user systemd unit owns the live proxy. We never auto-restart
      // a shared service from the extension — that could interrupt active
      // requests. Diagnose alignment and notify ONCE per unique mismatch.
      const aligned = await systemdExecStartMatches();
      const key = `${liveVersion}|${state.version}|${aligned}`;
      if (state.reconcileKey === key) return;
      state.reconcileKey = key;
      if (!aligned) {
        ctx?.ui?.notify?.(
          `Headroom proxy is ${liveVersion} but should be ${state.version}; the systemd unit ExecStart does not match ${HEADROOM_BIN}.`,
          "warn",
        );
      } else {
        ctx?.ui?.notify?.(
          `Headroom proxy is still ${liveVersion}; restart the systemd unit to activate ${state.version}.`,
          "info",
        );
      }
      return;
    }
    // An older proxy (often orphaned by a previous session) is still serving;
    // restart it so the upgraded install actually takes effect.
    const restarted = await restartProxy(ctx, state);
    if (restarted)
      ctx?.ui?.notify?.(
        `Headroom proxy restarted on ${state.version} (was ${liveVersion}).`,
        "info",
      );
  } catch {
    // Best effort.
  }
}

// ── Per-request sizing instrumentation (OMP_HEADROOM_DEBUG_SIZING=1) ─────────
// Logs ONLY numeric char estimates and a boolean persistence indicator.
// The canonical digest is computed IN MEMORY and compared to the previous
// hook_output digest to empirically test whether OMP persists the hook's
// transformed payload. NEVER logs hash values or payload text.

function messagesDigest(messages) {
  return createHash("sha256").update(stableJson(messages)).digest("hex");
}

// Build per-session debug log path. Session ID is sanitized (allowlist
// [A-Za-z0-9_-]); if absent or invalid, return "" → caller skips logging.
function debugSizingLogPath(state) {
  if (!DEBUG_SIZING) return "";
  const sid = typeof state?.sessionId === "string" ? state.sessionId : "";
  const safe = sid.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe) return "";
  return join(LOGS_DIR, `${safe}-sizing.jsonl`);
}

// Per-request debug sizing. CONCURRENCY-SAFE: each before_provider_request
// invocation captures `const seq = ++state._debugReqSeq` into a local variable
// and passes it explicitly to all stages — never re-read from state. This
// prevents parallel hook invocations (main agent + background tools) from
// cross-pairing stages in the log.
//
// previous_output_prefix_match:
//   true  = prior hook_output's conversation items persisted as the prefix
//           of this request's hook_input.
//   false = prefix content changed (normalization, tool injection, new
//           archive, or mutation — does NOT prove compression was ephemeral).
//   null  = incomparable (first request, format differs, prior len >
//           current, or a concurrent request interleaved).
function debugSizingInput(state, seq, payload) {
  if (!DEBUG_SIZING || typeof seq !== "number") return;
  try {
    const logFile = debugSizingLogPath(state);
    if (!logFile) return;
    const fmt = Array.isArray(payload?.messages)
      ? "messages"
      : Array.isArray(payload?.input)
        ? "input"
        : "other";
    const msgs = fmt === "messages" ? payload.messages : fmt === "input" ? payload.input : [];
    // Predecessor check: only compute prefix-match if the immediately
    // preceding request (seq-1) completed and wrote its output. If a
    // concurrent request interleaved (lastCompleted != seq-1), or this
    // is the first request, mark null — B has no causal predecessor.
    const prevSeq = state._debugLastCompletedSeq || 0;
    let prevPrefixMatch: boolean | null = null;
    if (
      prevSeq === seq - 1 &&
      state._debugPrevOutputDigest &&
      state._debugPrevOutputLen > 0 &&
      state._debugPrevOutputFormat === fmt &&
      state._debugPrevOutputLen <= msgs.length
    ) {
      prevPrefixMatch =
        messagesDigest(msgs.slice(0, state._debugPrevOutputLen)) === state._debugPrevOutputDigest;
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({
        seq,
        stage: "hook_input",
        chars: payloadCharTotal(payload),
        msgCount: msgs.length,
        fmt,
        previous_output_prefix_match: prevPrefixMatch,
      })}\n`,
    );
  } catch {
    /* never break the hook */
  }
}

function debugSizingStage(state, seq, stage, payload) {
  if (!DEBUG_SIZING || typeof seq !== "number" || typeof stage !== "string") return;
  try {
    const logFile = debugSizingLogPath(state);
    if (!logFile) return;
    const msgs = Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload?.input)
        ? payload.input
        : [];
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({
        seq,
        stage,
        chars: payloadCharTotal(payload),
        msgCount: msgs.length,
      })}\n`,
    );
  } catch {
    /* never break the hook */
  }
}
function debugSizingDiagnostic(state, seq, detail) {
  if (!DEBUG_SIZING || typeof seq !== "number" || !isRecord(detail)) return;
  try {
    const logFile = debugSizingLogPath(state);
    if (!logFile) return;
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ seq, stage: "anthropic_diagnostic", ...detail })}\n`,
    );
  } catch {
    /* diagnostics must never break the hook */
  }
}

function debugSizingOutput(state, seq, payload) {
  if (!DEBUG_SIZING || typeof seq !== "number") return;
  try {
    const logFile = debugSizingLogPath(state);
    if (!logFile) return;
    const fmt = Array.isArray(payload?.messages)
      ? "messages"
      : Array.isArray(payload?.input)
        ? "input"
        : "other";
    const msgs = fmt === "messages" ? payload.messages : fmt === "input" ? payload.input : [];
    // Mark completion + update prev-output atomically. Only write if no
    // newer request already completed — prevents an older concurrent
    // request from corrupting the next prefix-match comparison.
    state._debugLastCompletedSeq = Math.max(state._debugLastCompletedSeq || 0, seq);
    if (!state._debugLastOutputSeq || seq >= state._debugLastOutputSeq) {
      state._debugPrevOutputDigest = messagesDigest(msgs);
      state._debugPrevOutputLen = msgs.length;
      state._debugPrevOutputFormat = fmt;
      state._debugLastOutputSeq = seq;
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({
        seq,
        stage: "hook_output",
        chars: payloadCharTotal(payload),
        msgCount: msgs.length,
        fmt,
      })}\n`,
    );
  } catch {
    /* never break the hook */
  }
}

function normalizeModel(payload, ctx) {
  if (isRecord(payload) && typeof payload.model === "string" && payload.model) return payload.model;
  if (ctx?.model?.id) return ctx.model.id;
  return "gpt-4o";
}

// Fraction of the context window currently used (0 when unknown).
function contextUsageRatio(ctx) {
  const usage = ctx?.getContextUsage?.();
  const tokens = asNumber(usage?.tokens);
  const window = asNumber(usage?.contextWindow);
  return window > 0 && tokens > 0 ? Math.min(1, tokens / window) : 0;
}

// Adaptive compression threshold. Below the start ratio the base applies;
// between start and full the threshold shrinks linearly down to
// base * floor ratio. Applied to tool-output thresholds only — the provider
// candidate gate keeps its base so trivial payloads never stampede the proxy.
// Originals stay retrievable via CCR; the inline context does get more
// aggressively summarized as the window fills.

function contextWindow(ctx) {
  const usage = ctx?.getContextUsage?.();
  const value = usage?.contextWindow;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const HEADROOM_TEST_HASH = "0123456789abcdef01234567";
const HEADROOM_TEST_SURFACES = ["tool", "compaction"];
const HEADROOM_TEST_TIMESTAMP = Date.parse("2026-01-01T00:00:00.000Z");

function isHeadroomTestSurface(surface) {
  return HEADROOM_TEST_SURFACES.includes(
    String(surface || "")
      .trim()
      .toLowerCase(),
  );
}

function headroomTestToolContent() {
  return Array.from(
    { length: 200 },
    (_, index) =>
      `build ${index}: module=src/index.ts status=completed checksum=abcdef1234567890 decisions=preserve-retrieval-contract`,
  ).join("\n");
}

async function runHeadroomCompression(content, ctx, state) {
  await ensureProxy(ctx, state, 10_000);
  const callId = "headroom_manual_compress";
  const messages = [
    { role: "user", content: "Compress this content for token-efficient reasoning." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: callId, type: "function", function: { name: COMPRESS_TOOL, arguments: "{}" } },
      ],
    },
    { role: "tool", content, tool_call_id: callId },
  ];
  const result = await compressOpenAiMessages(
    messages,
    normalizeModel(undefined, ctx),
    contextWindow(ctx),
    TOOL_TIMEOUT_MS,
    state,
    { targeted: true },
  );
  const candidateMessage = result?.messages?.at?.(-1);
  const candidate = isRecord(candidateMessage) ? candidateMessage.content : undefined;
  const persisted =
    isBeneficialCompressionResult(result) &&
    typeof candidate === "string" &&
    candidate.length < content.length
      ? await persistCcrOriginal(result, content, candidate, state, ctx)
      : 0;
  if (persisted) recordCompression(state, "tool", result, ctx);
  state.lastError = "";
  refreshStatsAndRender(ctx, state);
  return {
    compressed: persisted ? candidate : undefined,
    details: {
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      tokensSaved: result.tokensSaved,
      ccrHashes: result.ccrHashes,
    },
  };
}

function seedHeadroomToolTranscript(sessionManager, source, compressed, details) {
  const toolCallId = "headroom-test-compress";
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: COMPRESS_TOOL,
        arguments: { content: source },
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "headroom-fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: HEADROOM_TEST_TIMESTAMP,
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: COMPRESS_TOOL,
    content: [{ type: "text", text: compressed }],
    details,
    isError: false,
    timestamp: HEADROOM_TEST_TIMESTAMP + 1,
  });
}

function seedHeadroomCompactionTranscript(sessionManager) {
  const firstKeptEntryId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Continue from the compacted conversation." }],
    timestamp: HEADROOM_TEST_TIMESTAMP,
  });
  sessionManager.appendCompaction(
    "Previous work was compacted. Preserve active decisions, file paths, identifiers, errors, constraints, and unresolved work.",
    "Headroom test fixture: native OMP compaction card.",
    firstKeptEntryId,
    245_000,
    undefined,
    true,
    { headroomCcrHash: HEADROOM_TEST_HASH, headroomArchived: true },
  );
}

async function createHeadroomTranscriptFixture(ctx, state, surface) {
  const selected = String(surface || "")
    .trim()
    .toLowerCase();
  if (!isHeadroomTestSurface(selected)) return undefined;
  if (typeof ctx?.newSession !== "function" || typeof ctx?.reload !== "function") return false;

  let toolTranscript: HeadroomToolTranscript | undefined;
  if (selected === "tool") {
    const source = headroomTestToolContent();
    try {
      const result = await runHeadroomCompression(source, ctx, state);
      if (typeof result.compressed !== "string") {
        return { error: "proxy returned no shorter retrievable Headroom result" };
      }
      toolTranscript = { source, compressed: result.compressed, details: result.details };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  const result = await ctx.newSession({
    setup: async (sessionManager) => {
      await sessionManager.setSessionName?.(`Headroom test — ${selected}`);
      if (selected === "tool") {
        if (!toolTranscript) throw new Error("Headroom tool fixture was not initialized");
        seedHeadroomToolTranscript(
          sessionManager,
          toolTranscript.source,
          toolTranscript.compressed,
          toolTranscript.details,
        );
      } else {
        seedHeadroomCompactionTranscript(sessionManager);
      }
    },
  });
  if (result?.cancelled) return false;

  // Reload removes OMP's generic "New session started" line and replays the
  // native fixture entries through the standard transcript renderer.
  await ctx.reload();
  return true;
}

async function runHeadroomCompaction(ctx, state) {
  if (typeof ctx.compact !== "function") {
    ctx.ui.notify("Compaction is unavailable in this OMP context.", "warn");
    return false;
  }
  state.lastCompactionCcrHash = "";
  // Distinct benefit vs the bare OMP `/compact`: this path archives the full
  // discarded history to Headroom CCR (retrievable via headroom_retrieve). The
  // session.compacting hook only archives while this flag is set, so vanilla
  // `/compact` stays untouched.
  state.headroomCompactActive = true;
  ctx.ui.notify("Headroom compaction started…", "info");
  try {
    await ctx.compact();
    ctx.ui.notify(
      state.lastCompactionCcrHash
        ? `Headroom archive ready: ${state.lastCompactionCcrHash}.`
        : "OMP compaction completed; Headroom did not archive a discarded source segment.",
      state.lastCompactionCcrHash ? "info" : "warn",
    );
    return !!state.lastCompactionCcrHash;
  } catch (error) {
    ctx.ui.notify(`Compaction failed: ${errorMessage(error).slice(0, 120)}`, "error");
    return false;
  } finally {
    state.headroomCompactActive = false;
  }
}

async function persistHolisticCompression(result, originalMessages, state, ctx) {
  if (!isBeneficialCompressionResult(result)) return false;
  return (
    (await persistCcrOriginal(
      result,
      stableJson(originalMessages),
      stableJson(result.messages),
      state,
      ctx,
    )) > 0
  );
}

// Apply-gate + transform for OpenAI provider compression. Returns the original
// payload unchanged unless the proxy proves a strict token reduction, the
// returned payload is shorter, and all user messages remain byte-stable.
export function applyOpenAiCompressionResult(result, payloadWithTool, hadSystem) {
  if (!isBeneficialCompressionResult(result)) return payloadWithTool;
  return fromOpenAiPayloadMessages(payloadWithTool, result.messages, hadSystem);
}

async function compressOpenAiMessages(
  messages,
  model,
  tokenBudget,
  timeoutMs,
  state,
  { targeted = false } = {},
) {
  // `targeted` = explicit single-tool-output compression: protect_recent 0 so
  // the tool content itself is eligible and analysis protection is disabled.
  // User messages are never eligible in either mode.
  const body: Record<string, unknown> = {
    messages,
    model,
    config: {
      compress_user_messages: false,
      protect_recent: targeted ? 0 : 2,
      protect_analysis_context: !targeted,
    },
  };
  if (Number.isInteger(tokenBudget) && tokenBudget > 0) body.token_budget = tokenBudget;
  // Per-project routing: /p/<sessionId>/v1/compress lets the proxy track
  // stats per OMP session so multi-instance widgets don't mix data.
  const project = state?.sessionId ? `/p/${state.sessionId}` : "";
  const response = await fetch(proxyPath(`${project}/v1/compress`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client": "omp",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const failure = data.error;
    const message = isRecord(failure) ? failure.message : failure;
    throw new Error(
      `Headroom proxy compression failed (${response.status}): ${String(message ?? text ?? response.statusText)}`,
    );
  }
  return normalizeCompressionResult(data, messages);
}

function toOpenAiPayloadMessages(payload) {
  const sourceMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = [...sourceMessages];
  const systemText = systemToText(payload.system);
  if (systemText !== undefined) messages.unshift({ role: "system", content: systemText });
  return { messages, hadSystem: systemText !== undefined };
}

function fromOpenAiPayloadMessages(payload, compressedMessages, hadSystem) {
  // The Anthropic-shaped path never reaches this function: the request handler
  // routes those payloads through compressAnthropicPayload instead.
  const rest = compressedMessages;
  if (hadSystem && isRecord(rest[0]) && rest[0].role === "system") {
    return { ...payload, system: rest[0].content, messages: rest.slice(1) };
  }
  return { ...payload, messages: rest };
}

function readArchivedAncestor(hash: string, sessionId: unknown): string {
  try {
    const files = [ccrFallbackPath(hash, undefined, sessionId), ccrFallbackPath(hash)];
    for (const file of files) {
      if (file && existsSync(file)) return readFileSync(file, "utf8");
    }
    return "";
  } catch {
    return "";
  }
}

async function prepareArchiveSession(ctx, state): Promise<void> {
  const sid = ctx?.sessionManager?.getSessionId?.();
  if (typeof sid !== "string" || !sid) return;
  if (state.sessionId !== sid) {
    state.sessionId = sid;
    state._archiveHydrated = false;
    state.sessionArchiveCompactions = 0;
    state.sessionArchiveCharsBefore = 0;
    state.sessionArchiveCharsAfter = 0;
    state.sessionArchiveCharsSaved = 0;
    state._ompHydrated = false;
    state.ompCompactions = 0;
  }
  if (state._archiveHydrated) return;
  const totals = await readArchiveTotals(sid);
  state.sessionArchiveCompactions = totals.count;
  state.sessionArchiveCharsBefore = totals.charsBefore;
  state.sessionArchiveCharsAfter = totals.charsAfter;
  state.sessionArchiveCharsSaved = totals.charsSaved;
  state._archiveHydrated = true;
}

async function persistSessionArchiveCandidate(
  candidate: SessionArchiveCandidate,
  state,
  ctx,
): Promise<boolean> {
  const archiveSessionId = ctx?.sessionManager?.getSessionId?.() || state.sessionId;
  const original = expandSessionArchiveText(candidate.originalText, (hash) =>
    readArchivedAncestor(hash, archiveSessionId),
  );
  const persisted = await persistCcrByHash(candidate.hash, original, state, ctx);
  if (!persisted) return false;
  const previous = {
    count: state.sessionArchiveCompactions,
    charsBefore: state.sessionArchiveCharsBefore,
    charsAfter: state.sessionArchiveCharsAfter,
    charsSaved: state.sessionArchiveCharsSaved,
  };
  state.sessionArchiveCompactions = previous.count + 1;
  state.sessionArchiveCharsBefore = previous.charsBefore + candidate.prefixChars;
  state.sessionArchiveCharsAfter = previous.charsAfter + candidate.archiveChars;
  state.sessionArchiveCharsSaved =
    previous.charsSaved + Math.max(0, candidate.prefixChars - candidate.archiveChars);
  const stored = await writeArchiveTotals(state.sessionId, {
    count: state.sessionArchiveCompactions,
    charsBefore: state.sessionArchiveCharsBefore,
    charsAfter: state.sessionArchiveCharsAfter,
    charsSaved: state.sessionArchiveCharsSaved,
  });
  if (stored) return true;
  state.sessionArchiveCompactions = previous.count;
  state.sessionArchiveCharsBefore = previous.charsBefore;
  state.sessionArchiveCharsAfter = previous.charsAfter;
  state.sessionArchiveCharsSaved = previous.charsSaved;
  return false;
}

async function applyMessageSessionArchive(payload, provider, state, ctx) {
  if (!payloadHasRetrieveTool(payload)) return payload;
  if (provider === "anthropic") {
    const source = Array.isArray(payload.messages) ? payload.messages : [];
    const candidate = createSessionCompaction(source);
    if (!candidate.compacted) return payload;
    const projected = {
      ...payload,
      messages: candidate.messages.map(asAnthropicArchiveMessage),
    };
    if (stableJson(projected).length >= stableJson(payload).length) return payload;
    return (await persistSessionArchiveCandidate(candidate, state, ctx)) ? projected : payload;
  }

  const { messages, hadSystem } = toOpenAiPayloadMessages(payload);
  const candidate = createSessionCompaction(messages);
  if (!candidate.compacted) return payload;
  const projected = fromOpenAiPayloadMessages(payload, candidate.messages, hadSystem);
  if (stableJson(projected).length >= stableJson(payload).length) return payload;
  return (await persistSessionArchiveCandidate(candidate, state, ctx)) ? projected : payload;
}

async function applyResponsesSessionArchive(payload, state, ctx) {
  if (!payloadHasRetrieveTool(payload)) return payload;
  const input = Array.isArray(payload.input) ? payload.input : [];
  const candidate = createResponsesSessionCompaction(input);
  if (!candidate.compacted) return payload;
  const projected = { ...payload, input: candidate.input };
  if (stableJson(projected).length >= stableJson(payload).length) return payload;
  return (await persistSessionArchiveCandidate(candidate, state, ctx)) ? projected : payload;
}

function anthropicToolResultText(block) {
  if (!isRecord(block) || block.type !== "tool_result") return undefined;
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return undefined;
  const textBlocks = getTextBlocks(block.content);
  if (textBlocks.length !== block.content.length) return undefined;
  return textBlocks.map((item) => item.text).join("\n");
}
function anthropicCompressionDiagnostic(payload, ctx) {
  const minToolChars = adaptiveMinChars(ANTHROPIC_MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  let toolResultBlocks = 0;
  let textToolResultBlocks = 0;
  let eligibleToolResultBlocks = 0;
  let markedToolResultBlocks = 0;
  let missingCallIdBlocks = 0;
  let maxToolResultChars = 0;

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      toolResultBlocks++;
      if (typeof block.tool_use_id !== "string" || !block.tool_use_id) {
        missingCallIdBlocks++;
      }
      const text = anthropicToolResultText(block);
      if (text === undefined) continue;
      textToolResultBlocks++;
      maxToolResultChars = Math.max(maxToolResultChars, text.length);
      if (text.includes(COMPRESSED_MARKER) || text.includes(RETRIEVED_MARKER)) {
        markedToolResultBlocks++;
      } else if (text.length >= minToolChars) {
        eligibleToolResultBlocks++;
      }
    }
  }

  return {
    enabled: ANTHROPIC_COMPRESSION_ENABLED,
    hasRetrieveTool: payloadHasRetrieveTool(payload),
    messageCount: messages.length,
    minToolChars,
    toolResultBlocks,
    textToolResultBlocks,
    eligibleToolResultBlocks,
    markedToolResultBlocks,
    missingCallIdBlocks,
    maxToolResultChars,
  };
}

// Anthropic rejects messages containing empty text content blocks with
// "messages: text content blocks must be non-empty". OMP's stored assistant
// history can carry [text, "", tool_use] shapes (an empty placeholder block
// between real text and tool_use). Strip those empty blocks only from
// non-user history. User messages remain byte-stable even when they contain
// structurally empty blocks.
function stripEmptyAnthropicTextBlocks(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages) return payload;
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isRecord(message) || message.role === "user" || !Array.isArray(message.content)) {
      return message;
    }
    const filtered = message.content.filter(
      (block) =>
        !(
          isRecord(block) &&
          block.type === "text" &&
          (typeof block.text !== "string" || block.text.trim() === "")
        ),
    );
    if (filtered.length === 0 || filtered.length === message.content.length) return message;
    changed = true;
    return { ...message, content: filtered };
  });
  return changed ? { ...payload, messages: nextMessages } : payload;
}

async function compressAnthropicPayload(payload, ctx, state) {
  payload = stripEmptyAnthropicTextBlocks(payload);
  if (!payloadHasRetrieveTool(payload)) return payload;
  if (!ANTHROPIC_COMPRESSION_ENABLED) return payload;
  // Compress only structurally isolated tool_result blocks. A holistic
  // Anthropic→OpenAI→Anthropic round-trip cannot preserve arbitrary content
  // blocks or trustworthy token metrics, so it is intentionally unsupported.
  const startMs = Date.now();
  const ANTHROPIC_BUDGET_MS = 18_000;

  // Compress individual tool_result blocks without touching user prose.
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const minToolChars = adaptiveMinChars(ANTHROPIC_MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
  let changed = false;
  const nextMessages: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
      nextMessages.push(message);
      continue;
    }
    const nextContent: unknown[] = [];
    let contentChanged = false;
    for (const block of message.content) {
      const output = anthropicToolResultText(block);
      if (
        output === undefined ||
        output.length < minToolChars ||
        output.includes(COMPRESSED_MARKER) ||
        output.includes(RETRIEVED_MARKER)
      ) {
        nextContent.push(block);
        continue;
      }
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "hr_ar";
      const synthetic = [
        {
          role: "user",
          content: "Compress Anthropic tool_result content for token-efficient reasoning.",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name: "ar", arguments: "{}" } }],
        },
        { role: "tool", content: output, tool_call_id: callId },
      ];
      if (Date.now() - startMs > ANTHROPIC_BUDGET_MS) {
        nextContent.push(block);
        continue;
      }
      const result = await compressOpenAiMessages(
        synthetic,
        normalizeModel(payload, ctx),
        undefined,
        PROVIDER_TIMEOUT_MS,
        state,
        { targeted: true },
      );
      const compressedMessage = result?.messages?.at?.(-1);
      const compressed = isRecord(compressedMessage) ? compressedMessage.content : undefined;
      if (
        isBeneficialCompressionResult(result) &&
        typeof compressed === "string" &&
        compressed.length < output.length
      ) {
        const persisted = await persistCcrOriginal(result, output, compressed, state, ctx);
        if (persisted) {
          nextContent.push({ ...block, content: compressed });
          recordCompression(state, "provider", result, ctx);
          contentChanged = true;
          changed = true;
          continue;
        }
      }
      nextContent.push(block);
    }
    nextMessages.push(contentChanged ? { ...message, content: nextContent } : message);
  }
  return changed ? { ...payload, messages: nextMessages } : payload;
}

const RESPONSES_BATCH_MAX_ITEMS = 8;
const RESPONSES_BATCH_MAX_CHARS = MIN_TOOL_TEXT_CHARS * RESPONSES_BATCH_MAX_ITEMS;

function responsesBatchChunks(input, minToolChars) {
  const chunks: Array<Array<{ index: number; item: Record<string, unknown>; output: string }>> = [];
  let chunk: Array<{ index: number; item: Record<string, unknown>; output: string }> = [];
  let chunkChars = 0;
  const flush = () => {
    if (chunkChars >= minToolChars) chunks.push(chunk);
    chunk = [];
    chunkChars = 0;
  };
  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    const output = responseOutputText(item);
    if (
      !isRecord(item) ||
      output === undefined ||
      output.length < PROVIDER_MIN_TEXT_CHARS ||
      output.length >= minToolChars ||
      output.includes(COMPRESSED_MARKER) ||
      output.includes(RETRIEVED_MARKER)
    ) {
      continue;
    }
    if (
      chunk.length >= RESPONSES_BATCH_MAX_ITEMS ||
      (chunk.length > 0 && chunkChars + output.length > RESPONSES_BATCH_MAX_CHARS)
    ) {
      flush();
    }
    chunk.push({ index, item, output });
    chunkChars += output.length;
  }
  flush();
  return chunks;
}

async function compressResponsesBatch(entries, workingPayload, ctx, state) {
  const toolCalls = entries.map((entry) => {
    const id =
      typeof entry.item.call_id === "string"
        ? entry.item.call_id
        : `headroom_response_output_${entry.index}`;
    return {
      id,
      type: "function",
      function: { name: "response_tool", arguments: "{}" },
    };
  });
  const messages = [
    {
      role: "user",
      content: "Compress OpenAI Responses tool outputs for token-efficient reasoning.",
    },
    { role: "assistant", content: null, tool_calls: toolCalls },
    ...entries.map((entry, index) => ({
      role: "tool",
      content: entry.output,
      tool_call_id: toolCalls[index].id,
    })),
  ];
  const result = await compressOpenAiMessages(
    messages,
    normalizeModel(workingPayload, ctx),
    undefined,
    PROVIDER_TIMEOUT_MS,
    state,
    { targeted: true },
  );
  if (!isBeneficialCompressionResult(result)) return undefined;
  const returnedTools = Array.isArray(result.messages)
    ? result.messages.filter((message) => isRecord(message) && message.role === "tool")
    : [];
  if (returnedTools.length !== entries.length) return undefined;
  const changes: Array<{
    index: number;
    item: Record<string, unknown>;
    originalText: string;
    compressedText: string;
  }> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const returned = returnedTools[index];
    const compressed = isRecord(returned) ? returned.content : undefined;
    if (
      !isRecord(returned) ||
      returned.tool_call_id !== toolCalls[index].id ||
      typeof compressed !== "string"
    ) {
      return undefined;
    }
    if (compressed === entry.output) continue;
    if (compressed.length >= entry.output.length || !compressed.includes(COMPRESSED_MARKER)) {
      return undefined;
    }
    changes.push({
      index: entry.index,
      item: { ...entry.item, output: compressed },
      originalText: entry.output,
      compressedText: compressed,
    });
  }
  if (changes.length === 0) return undefined;
  const persisted = await persistCcrOriginalBatch(changes, state, ctx);
  if (persisted !== changes.length) return undefined;
  return { changes, result };
}

export async function compressResponsesPayload(
  payload,
  ctx,
  state,
  { providerReady = true, debugSeq = 0 } = {},
) {
  const workingPayload = await applyResponsesSessionArchive(payload, state, ctx);
  debugSizingStage(state, debugSeq, "before_compression", workingPayload);
  if (!payloadHasRetrieveTool(workingPayload)) return workingPayload;
  const input = Array.isArray(workingPayload.input) ? workingPayload.input : [];
  let changed = false;
  if (!providerReady) return workingPayload;
  // Batch individually-small outputs when their aggregate clears the adaptive
  // floor, then compress oversized outputs concurrently with bounded workers.
  // Input order and unchanged object identity are preserved.
  let _failures = 0;
  const minToolChars = adaptiveMinChars(MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
  const nextInput: unknown[] = [...input];
  for (const batchEntries of responsesBatchChunks(input, minToolChars)) {
    try {
      const batch = await compressResponsesBatch(batchEntries, workingPayload, ctx, state);
      if (!batch) continue;
      for (const entry of batch.changes) nextInput[entry.index] = entry.item;
      recordCompression(state, "provider", batch.result, ctx);
      changed = true;
    } catch {
      // Batch failure is fail-open; oversized outputs still run independently.
      _failures += 1;
    }
  }
  const compressItem = async (item) => {
    const output = responseOutputText(item);
    if (
      output === undefined ||
      output.length < minToolChars ||
      output.includes(COMPRESSED_MARKER) ||
      output.includes(RETRIEVED_MARKER)
    ) {
      return { item };
    }
    const callId = typeof item.call_id === "string" ? item.call_id : "headroom_response_output";
    const messages = [
      {
        role: "user",
        content: "Compress OpenAI Responses tool output for token-efficient reasoning.",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: callId, type: "function", function: { name: "response_tool", arguments: "{}" } },
        ],
      },
      { role: "tool", content: output, tool_call_id: callId },
    ];
    try {
      const result = await compressOpenAiMessages(
        messages,
        normalizeModel(workingPayload, ctx),
        undefined,
        PROVIDER_TIMEOUT_MS,
        state,
        { targeted: true },
      );
      const compressedMessage = result?.messages?.at?.(-1);
      const compressed = isRecord(compressedMessage) ? compressedMessage.content : undefined;
      if (
        isBeneficialCompressionResult(result) &&
        typeof compressed === "string" &&
        compressed.length < output.length
      ) {
        return { item: { ...item, output: compressed }, result, output, compressed };
      }
    } catch {
      // A failed item keeps its original output; other items still compress.
      _failures += 1;
    }
    return { item };
  };
  const settled = new Array(input.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(RESPONSES_COMPRESS_CONCURRENCY, Math.max(1, input.length)) },
      async () => {
        while (cursor < input.length) {
          const index = cursor++;
          settled[index] = await compressItem(input[index]);
        }
      },
    ),
  );
  for (let index = 0; index < settled.length; index++) {
    const entry = settled[index];
    if (!entry.result) continue;
    const persisted = await persistCcrOriginal(
      entry.result,
      entry.output,
      entry.compressed,
      state,
      ctx,
    );
    if (!persisted) continue;
    nextInput[index] = entry.item;
    recordCompression(state, "provider", entry.result, ctx);
    changed = true;
  }
  return changed ? { ...workingPayload, input: nextInput } : workingPayload;
}

function recordCompression(state, kind, result, ctx) {
  const saved = Math.max(0, asNumber(result?.tokensSaved));
  if (saved <= 0) return;
  // hasUI=false → subagent or pre-initialize main. Use MODULE-LEVEL counters
  // (not state.foreignSelf*) because the factory creates a separate state per
  // call, but Bun caches the module — so _sharedForeign* is visible to both
  // the main's compactStatsLine and the subagent's recordCompression.
  if (ctx && !isMainSession(ctx)) {
    if (kind === "provider") shared.foreignProvider += 1;
    if (kind === "tool") shared.foreignTool += 1;
    return;
  }
  state.tokensSaved += saved;
  state.tokensBefore += Math.max(0, asNumber(result?.tokensBefore));
  state.tokensAfter += Math.max(0, asNumber(result?.tokensAfter));
  if (kind === "provider") state.providerCompressions += 1;
  if (kind === "tool") state.toolCompressions += 1;
}

// Fire-and-forget stats refresh + widget repaint for hook paths: the provider
// request must not wait on a 3s stats GET. fetchStats never rejects; the paint
// is guarded so a render bug cannot become an unhandled rejection.
function refreshStatsAndRender(ctx, state) {
  void fetchStats(state).then(() => {
    try {
      renderWidget(ctx, state);
    } catch {
      // Painting is best-effort.
    }
  });
}

async function fetchStats(state, force = false) {
  const now = Date.now();
  if (!force && state.statsFetchedAt && now - state.statsFetchedAt < STATS_MIN_INTERVAL_MS)
    return state.stats;
  if (state.statsInFlight) return state.statsInFlight;
  let inFlight: Promise<unknown> | undefined;
  inFlight = (async () => {
    try {
      // Per-project: read from /p/<sessionId>/stats so each OMP instance has its
      // own stats bucket. Fall back to global /stats for lifetime totals.
      const project = state.sessionId ? `/p/${state.sessionId}` : "";
      const response = await fetch(proxyPath(`${project}/stats`), {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return undefined;
      state.stats = await response.json();
      state.statsFetchedAt = Date.now();
      state.proxyReady = true;
      state.proxyStarting = false;
      state.proxyCheckedAt = state.statsFetchedAt;
      state.lastError = "";
      // Also refresh subagent (+N) totals from foreign files — this runs after
      // every compression event on the main session, so (+N) updates promptly
      // even if the rainbow timer's read is delayed or blocked.
      try {
        const t = readForeignTotals();
        state.foreignProvider = t.provider;
        state.foreignTool = t.tool;
        state.foreignCcr = t.ccr;
      } catch {}
      return state.stats;
    } catch (error) {
      state.lastError = `Headroom stats unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    } finally {
      if (state.statsInFlight === inFlight) state.statsInFlight = undefined;
    }
  })();
  state.statsInFlight = inFlight;
  return inFlight;
}

async function ensureProxy(ctx, state, waitMs = 0) {
  const now = Date.now();
  if (state.proxyReady && now - state.proxyCheckedAt < READY_TTL_MS) return true;
  if (await isProxyReady()) {
    state.proxyReady = true;
    state.proxyStarting = false;
    state.proxyCheckedAt = Date.now();
    renderWidget(ctx, state);
    return true;
  }

  // /livez did not answer in time. Before assuming the proxy is down and
  // (re)starting it, check whether the systemd unit is already running — a
  // busy/swapping proxy is alive but slow. If so, keep waiting instead of
  // flipping into a "starting" restart cycle that strands proxyReady=false.
  if (await systemdUnitActive()) {
    state.proxyStarting = true;
    const deadlineActive = Date.now() + Math.max(waitMs, 2_000);
    while (Date.now() <= deadlineActive) {
      if (await isProxyReady()) {
        state.proxyReady = true;
        state.proxyStarting = false;
        state.proxyCheckedAt = Date.now();
        await fetchStats(state, true);
        renderWidget(ctx, state);
        return true;
      }
      await sleep(500);
    }
    renderWidget(ctx, state);
    return false;
  }

  state.proxyReady = false;
  if (!state.proxyStarting && !state.proxyProcess) {
    if (!existsSync(HEADROOM_BIN)) {
      state.lastError = `Headroom binary missing: ${HEADROOM_BIN}`;
      renderWidget(ctx, state);
      return false;
    }
    state.proxyStarting = true;
    if (await systemdUnitAvailable()) {
      void systemdCtl("start").then((result) => {
        if (result.code !== 0) {
          state.proxyStarting = false;
          state.lastError = `systemctl start failed: ${clip(result.err.trim(), 200)}`;
        }
      });
      ctx?.ui?.notify?.(`Starting Headroom proxy via ${SYSTEMD_UNIT}…`, "info");
    } else {
      const proxyEnv: NodeJS.ProcessEnv = { ...process.env, HEADROOM_TELEMETRY: "off" };
      if (CODE_AWARE) proxyEnv.HEADROOM_CODE_AWARE_ENABLED ??= "1";
      proxyEnv.HEADROOM_NO_SUBSCRIPTION_TRACKING ??= "1";
      state.proxyProcess = spawn(
        HEADROOM_BIN,
        [
          "proxy",
          "--host",
          "127.0.0.1",
          "--port",
          String(proxyPort()),
          "--no-telemetry",
          ...PROXY_EXTRA_ARGS,
        ],
        { env: proxyEnv, stdio: "ignore" },
      );
      state.proxyProcess.unref();
      state.proxyProcess.once("error", (error) => {
        state.lastError = errorMessage(error);
        state.proxyStarting = false;
        state.proxyProcess = undefined;
      });
      state.proxyProcess.once("exit", (code) => {
        state.proxyStarting = false;
        state.proxyProcess = undefined;
        if (code !== null && code !== 0)
          state.lastError = `Headroom proxy exited with code ${code}`;
      });
      ctx?.ui?.notify?.(`Starting Headroom proxy on ${PROXY_URL}…`, "info");
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (await isProxyReady()) {
      state.proxyReady = true;
      state.proxyStarting = false;
      state.proxyCheckedAt = Date.now();
      await fetchStats(state, true);
      renderWidget(ctx, state);
      return true;
    }
    await sleep(500);
  }
  renderWidget(ctx, state);
  return false;
}

export default function headroomExtension(pi: ExtensionAPI) {
  // pi.zod IS the zod module object (loader sets `readonly zod = z`), so
  // `pi.zod.object` exists directly. Older shims exposed it as `{ z }`. Accept
  // either, and never throw at registration when it is absent.
  const legacyZod = pi.zod as unknown as { z?: typeof pi.zod };
  const z = legacyZod.z ?? pi.zod;
  const toolRegistrar = pi as unknown as ExtensionToolRegistrar;
  pi.setLabel?.("Headroom");
  let latestCtx: ExtensionContext | undefined;
  let rainbowTimer: NodeJS.Timeout | undefined;
  let widgetOnScreen = true; // updated by widget_layout event

  function startRainbowTimer() {
    if (rainbowTimer) return;
    rainbowTimer = setInterval(() => {
      const ctx = latestCtx;
      if (!ctx || !state.enabled || !widgetOnScreen) return;
      const isMainUi = isMainSession(ctx);
      const now = Date.now();
      let dirty = false;
      // Rainbow only animates while the proxy is confirmed ready (the title is
      // grey otherwise) — but the widget must still refresh for (+N) updates.
      if (state.proxyReady) {
        state.rainbowPhase = (state.rainbowPhase + 1) % RAINBOW_CODES.length;
        dirty = true;
      }
      // Main UI session: refresh aggregated subagent (+N) totals ~1/s. This is
      // LOCAL file I/O and must NOT be gated on proxyReady — otherwise a busy
      // or briefly-unreachable proxy would freeze the subagent counters.
      if (isMainUi && now - (state.foreignReadAt || 0) > 1_000) {
        state.foreignReadAt = now;
        const t = readForeignTotals();
        if (
          t.provider !== state.foreignProvider ||
          t.tool !== state.foreignTool ||
          t.ccr !== state.foreignCcr
        ) {
          state.foreignProvider = t.provider;
          state.foreignTool = t.tool;
          state.foreignCcr = t.ccr;
          dirty = true;
        }
      }
      // Periodically re-fetch proxy stats so the widget's ctx/req line stays
      // live even when the extension's own hooks aren't firing (e.g. proxy
      // compresses at transport level without the hook recording it).
      if (isMainUi && state.proxyReady && now - (state.statsFetchedAt || 0) > 5_000) {
        void fetchStats(state).then(() => {
          try {
            renderWidget(ctx, state);
          } catch {}
        });
      }
      if (dirty) renderWidget(ctx, state);
    }, RAINBOW_MS);
    // unref removed: it can cause the timer to be skipped in idle moments,
    // which freezes the rainbow animation. Keeping the process alive is fine
    // since OMP interactive sessions are long-running.
  }

  function stopRainbowTimer() {
    if (!rainbowTimer) return;
    clearInterval(rainbowTimer);
    rainbowTimer = undefined;
  }

  const state = createHeadroomState();

  // Capture the main UI session's render target + clear foreign files exactly once.
  // session_start may fire BEFORE OMP wires the UI (hasUI=false then), so we also
  // call this from the active hooks, where the main session's ctx has hasUI=true.
  function ensureMainCaptured(ctx) {
    if (!isMainSession(ctx)) return;
    latestCtx = ctx;
    if (!shared.foreignCleared) {
      shared.foreignCleared = true;
      // Retroactive: pre-initialize compressions incremented the shared
      // foreign counters. Move them back to THIS state's main counters.
      state.providerCompressions += shared.foreignProvider;
      state.toolCompressions += shared.foreignTool;
      state.ccrHashes += shared.foreignCcr;
      shared.foreignProvider = 0;
      shared.foreignTool = 0;
      shared.foreignCcr = 0;
    }
    // One-time hydration of OMP native compaction count (resume-safe).
    // getBranch() returns the current branch path only (not abandoned
    // branches), so the count matches what the user sees. Entries with
    // type "compaction" are appended by all 3 OMP compaction modes
    // (soft/remote/snapcompact). Guarded: older OMP may lack the API.
    if (!state._ompHydrated) {
      state._ompHydrated = true;
      try {
        const branch = ctx?.sessionManager?.getBranch?.();
        if (Array.isArray(branch)) {
          state.ompCompactions = branch.filter(
            (entry) => isRecord(entry) && entry.type === "compaction",
          ).length;
        }
      } catch {
        /* best effort — leave 0 */
      }
    }
  }

  pi.registerFlag("headroom", {
    description: "Enable Headroom token compression",
    type: "boolean",
    default: true,
  });

  pi.on("session_start", async (_event, ctx) => {
    // Capture the OMP session ID for per-project proxy routing. Each session
    // gets its own stats bucket at /p/<sessionId>/stats so multi-instance
    // OMP sessions don't pollute each other's widget data.
    const sid = ctx?.sessionManager?.getSessionId?.();
    await prepareArchiveSession(ctx, state);
    // CRITICAL: only the main UI session (hasUI===true) may capture latestCtx.
    if (isMainSession(ctx)) {
      latestCtx = ctx;
    } else if (typeof sid === "string" && sid) {
      // Subagent/advisor session — record its ID so the main can read its
      // proxy per_project bucket and render it as (+N).
      subagentSessionIds.add(sid);
    }
    // `before_provider_request` is the sole automatic compression path:
    // it transforms only the outbound provider payload, never the transcript.
    state.enabled = pi.getFlag?.("headroom") !== false && process.env.OMP_HEADROOM_DISABLED !== "1";
    startRainbowTimer();
    renderWidget(ctx, state);
    void (async () => {
      if (!existsSync(HEADROOM_BIN)) await maintainInstall(ctx, state);
      await ensureProxy(ctx, state, 25_000);
      await maintainInstall(ctx, state);
      await reconcileProxyVersion(ctx, state);
      // Load accumulated per-project stats immediately so a resumed session
      // (omp --resume) shows its prior totals instead of zeroes until the
      // first request. The proxy persists per_project[sessionId].
      await fetchStats(state, true);
      renderWidget(ctx, state);
    })();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopRainbowTimer();
    // The proxy is a shared daemon (systemd unit or adopted orphan) serving
    // other agent sessions — never tear it down on session exit.
    ctx?.ui?.setWidget?.(EXTENSION_KEY, undefined, { placement: WIDGET_PLACEMENT as never });
    ctx?.ui?.setStatus?.(EXTENSION_KEY, undefined);
  });
  // OMP native compaction count. session_compact fires once per completed
  // compaction for ALL modes (soft/remote/snapcompact — they converge on
  // one emit). Counting only — no compaction customization.
  pi.on("session_compact", async (_event, ctx) => {
    if (!isMainSession(ctx)) return;
    state.ompCompactions = (state.ompCompactions || 0) + 1;
    renderWidget(ctx, state);
  });
  // Provider-native prompt cache telemetry. OMP normalizes cache usage on the
  // finalized assistant message, so this observes the real provider response
  // without changing provider routing or request payloads.
  pi.on("message_end", async (event, ctx) => {
    if (!isMainSession(ctx) || event?.message?.role !== "assistant") return;
    ensureMainCaptured(ctx);
    const usage = event.message.usage;
    state.cacheInputTokens += Math.max(0, asNumber(usage?.input));
    state.cacheReadTokens += Math.max(0, asNumber(usage?.cacheRead));
    state.cacheWriteTokens += Math.max(0, asNumber(usage?.cacheWrite));
    renderWidget(ctx, state);
  });
  // Headroom-powered session compaction (hybrid architecture).
  // session.compacting fires ONLY when session_before_compact returned no
  // full replacement (we register none). Headroom's role:
  //   1. Archive the FULL originals to CCR (retrievable via headroom_retrieve)
  //   2. Override the summarization prompt for content-aware density
  // OMP's OWN LLM (which has the session credentials — the proxy does not)
  // produces the clean narrative summary. Result: [rezumat semantic LLM]
  // + [originale CCR-retrievable], with NO raw markers in the rendered
  // summary (preserveData is non-rendered; prompt drives the LLM only).
  pi.on("session.compacting", async (event, ctx) => {
    if (!state.headroomCompactActive) return undefined;
    try {
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      if (messages.length === 0) return undefined;
      const originalText = JSON.stringify(messages, null, 2);
      const hash = createHash("sha256").update(originalText).digest("hex").slice(0, 24);
      const persisted = await persistCcrByHash(hash, originalText, state, ctx);
      if (persisted === 0) {
        // Fail-closed: CCR archive failed → let OMP summarize natively
        // without claiming an archive we couldn't persist.
        pi.logger?.warn?.(
          "headroom session.compacting: CCR archive failed; skipping headroom archival.",
        );
        return undefined;
      }
      state.lastCompactionCcrHash = hash;
      return {
        // `context` is ADDITIVE — appended to OMP's native compaction
        // prompt (NOT a replacement). Preserves OMP's proven summary
        // format/safety/budget while adding Headroom's fidelity bar.
        context: [
          "Headroom archival active: full originals of the summarized conversation are persisted and retrievable.",
          `Full archived source — preserve this exact reference in the summary: Retrieve more: hash=${hash}`,
          "Preserve every file path, identifier, decision, error, constraint, and tool result verbatim where they matter. This summary replaces the full history.",
        ],
        preserveData: {
          headroomArchiveChars: originalText.length,
          headroomArchived: true,
          headroomCcrHash: hash,
        },
      };
    } catch (error) {
      pi.logger?.warn?.(`headroom session.compacting failed: ${errorMessage(error)}`);
      return undefined;
    }
  });
  (
    pi as ExtensionAPI & {
      on: (
        event: "widget_layout",
        handler: (event: { key: string; visible: boolean }) => void,
      ) => void;
    }
  ).on("widget_layout", (e) => {
    if (e.key !== EXTENSION_KEY) return;
    widgetOnScreen = e.visible;
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!state.enabled) return;
    await prepareArchiveSession(ctx, state);
    ensureMainCaptured(ctx);
    // Main session: refresh subagent (+N) from foreign files on every provider
    // request — the timer-based read alone is unreliable.
    if (isMainSession(ctx)) {
      try {
        const t = readForeignTotals();
        state.foreignProvider = t.provider;
        state.foreignTool = t.tool;
        state.foreignCcr = t.ccr;
      } catch {}
    }
    const payload = event.payload;
    if (!isRecord(payload) || (!Array.isArray(payload.messages) && !Array.isArray(payload.input)))
      return;
    // `headroom wrap omp` already routes Anthropic through this proxy. Running
    // the SDK compression hook as well would double-compress the same request.
    if (modelUsesHeadroomProxy(ctx?.model)) {
      if (DEBUG_SIZING) {
        state._debugReqSeq = asNumber(state._debugReqSeq) + 1;
        const seq = state._debugReqSeq;
        debugSizingInput(state, seq, payload);
        debugSizingDiagnostic(state, seq, {
          skippedHeadroomProxy: true,
          format: Array.isArray(payload.messages) ? "messages" : "input",
        });
        debugSizingOutput(state, seq, payload);
      }
      return;
    }

    // DEBUG: ground-truth what the hook sees, to diagnose req=0. Toggle with
    // OMP_HEADROOM_DEBUG=1. Writes one JSON line per request to debug.log.
    if (process.env.OMP_HEADROOM_DEBUG === "1") {
      try {
        const shape = Array.isArray(payload.input) ? "responses(input)" : "messages";
        const prov = (() => {
          try {
            return effectiveProviderFormat(payload, ctx);
          } catch {
            return "?";
          }
        })();
        let detail = {};
        if (Array.isArray(payload.input)) {
          const types = {};
          let big = 0;
          let batchItems = 0;
          let batchChars = 0;
          const threshold = adaptiveMinChars(MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
          for (const it of payload.input) {
            const t = isRecord(it) ? String(it.type) : typeof it;
            types[t] = (types[t] || 0) + 1;
            const o = responseOutputText(it);
            if (typeof o === "string" && o.length >= threshold) big++;
            else if (typeof o === "string" && o.length >= PROVIDER_MIN_TEXT_CHARS) {
              batchItems++;
              batchChars += o.length;
            }
          }
          detail = {
            items: payload.input.length,
            types,
            itemsOverThreshold: big,
            batchCandidates: batchItems,
            batchCandidateChars: batchChars,
            threshold,
          };
        } else if (Array.isArray(payload.messages)) {
          detail = { messages: payload.messages.length, model: payload.model || ctx?.model?.id };
        }
        appendFileSync(
          join(homedir(), ".headroom-debug.log"),
          `${JSON.stringify({
            ts: new Date().toISOString(),
            shape,
            prov,
            ready: state.proxyReady,
            ...detail,
          })}\n`,
        );
      } catch {
        /* never break the hook on debug */
      }
    }

    let seq = 0;
    if (DEBUG_SIZING) {
      state._debugReqSeq = asNumber(state._debugReqSeq) + 1;
      seq = state._debugReqSeq;
    }
    debugSizingInput(state, seq, payload);
    const hr = (val) => {
      debugSizingOutput(state, seq, val || payload);
      return val;
    };
    let archiveFallback: unknown;
    try {
      if (Array.isArray(payload.input)) {
        const ready = await ensureProxy(ctx, state, 1_000);
        const nextPayload = await compressResponsesPayload(payload, ctx, state, {
          providerReady: ready,
          debugSeq: seq,
        });
        if (ready) refreshStatsAndRender(ctx, state);
        else renderWidget(ctx, state);
        return hr(nextPayload);
      }

      const provider = effectiveProviderFormat(payload, ctx);
      if (provider === "anthropic") {
        const workingPayload = await applyMessageSessionArchive(payload, provider, state, ctx);
        const archived = workingPayload !== payload;
        if (archived) archiveFallback = workingPayload;
        const candidate = providerPayloadHasCompressionCandidate(workingPayload);
        if (!candidate) {
          debugSizingDiagnostic(state, seq, {
            ...anthropicCompressionDiagnostic(workingPayload, ctx),
            candidate,
            proxyReady: null,
          });
          state.lastError = "";
          renderWidget(ctx, state);
          return hr(archived ? workingPayload : undefined);
        }
        const ready = await ensureProxy(ctx, state, 1_000);
        debugSizingDiagnostic(state, seq, {
          ...anthropicCompressionDiagnostic(workingPayload, ctx),
          candidate,
          proxyReady: ready,
        });
        if (!ready) {
          renderWidget(ctx, state);
          return hr(archived ? workingPayload : undefined);
        }
        const nextPayload = await compressAnthropicPayload(workingPayload, ctx, state);
        state.lastError = "";
        refreshStatsAndRender(ctx, state);
        return hr(nextPayload);
      }

      if (!payloadHasRetrieveTool(payload)) return hr(undefined);
      const workingPayload = await applyMessageSessionArchive(payload, provider, state, ctx);
      const archived = workingPayload !== payload;
      if (archived) archiveFallback = workingPayload;
      const { messages: oaMessages, hadSystem } = toOpenAiPayloadMessages(workingPayload);
      if (!providerPayloadHasCompressionCandidate(workingPayload)) {
        state.lastError = "";
        renderWidget(ctx, state);
        return hr(archived ? workingPayload : undefined);
      }
      const ready = await ensureProxy(ctx, state, 1_000);
      if (!ready) {
        renderWidget(ctx, state);
        return hr(archived ? workingPayload : undefined);
      }
      const result = await compressOpenAiMessages(
        oaMessages,
        normalizeModel(workingPayload, ctx),
        contextWindow(ctx),
        PROVIDER_TIMEOUT_MS,
        state,
      );
      if (await persistHolisticCompression(result, oaMessages, state, ctx)) {
        recordCompression(state, "provider", result, ctx);
        state.lastError = "";
        refreshStatsAndRender(ctx, state);
        return hr(applyOpenAiCompressionResult(result, workingPayload, hadSystem));
      }
      return hr(archived ? workingPayload : undefined);
    } catch (error) {
      state.lastError = errorMessage(error);
      pi.logger?.warn?.(`headroom before_provider_request failed: ${state.lastError}`);
      // A committed archive is already smaller and retrievable, so preserve it
      // even when the later proxy-compression stage fails.
      renderWidget(ctx, state);
      return hr(archiveFallback);
    }
  });

  // Tool registration needs zod for parameter schemas. If zod is unavailable
  // (older host), skip the tools but never let it abort the whole extension —
  // the widget + compression hooks must still load.
  if (z) {
    toolRegistrar.registerTool({
      name: RETRIEVE_TOOL,
      label: "Headroom Retrieve",
      // OMP 17 defers custom tools out of the provider payload by default
      // ("discoverable"). The compression/archive gates require this tool to
      // be present in payload.tools, so it must stay top-level.
      loadMode: "essential",
      description: RETRIEVE_DESCRIPTION,
      parameters: z.object({
        hash: z.string().describe("Hash key from a Headroom compression marker."),
        query: z.string().optional().describe("Optional search query to filter original content."),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        await ensureProxy(ctx, state, 5_000);
        let data: Record<string, unknown>;
        try {
          const retrieved = await retrieveViaProxy(
            PROXY_URL,
            params.hash,
            params.query,
            signal,
            TOOL_TIMEOUT_MS,
          );
          data = isRecord(retrieved) ? retrieved : { error: String(retrieved), hash: params.hash };
        } catch (error) {
          data = { error: errorMessage(error), hash: params.hash };
        }
        let fallback = false;
        if (data.error) {
          const sessionId = ctx?.sessionManager?.getSessionId?.() || state.sessionId;
          const original = await readCcrFallback(params.hash, undefined, sessionId);
          if (original !== undefined) {
            data = { original_content: original };
            fallback = true;
          }
        }
        state.ccrHashes += 1;
        refreshStatsAndRender(ctx, state);
        return {
          content: [{ type: "text", text: stringifyRetrieveResult(data, params.hash, fallback) }],
          isError: !!data.error,
          details: data,
        };
      },
    });

    toolRegistrar.registerTool({
      name: COMPRESS_TOOL,
      label: "Headroom Compress",
      description:
        "Compress large content to save context window space. The original is stored by Headroom and can be retrieved later with headroom_retrieve when a hash is present.",
      parameters: z.object({
        content: z.string().describe("Text, JSON, logs, code, or search results to compress."),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await runHeadroomCompression(params.content, ctx, state);
        return {
          content: [
            {
              type: "text",
              text: typeof result.compressed === "string" ? result.compressed : params.content,
            },
          ],
          details: result.details,
        };
      },
    });

    toolRegistrar.registerTool({
      name: STATS_TOOL,
      label: "Headroom Stats",
      description: "Show Headroom compression statistics for this OMP session and proxy.",
      parameters: z.object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        await ensureProxy(ctx, state, 3_000);
        await fetchStats(state, true);
        renderWidget(ctx, state);
        return {
          content: [{ type: "text", text: commandSummary(state) }],
          details: state.stats || {},
        };
      },
    });
  } // close if (z)
  const UPDATE_AUTO_CLEAR_MS = 45_000;
  const headroomCommand = {
    description:
      "Manage Headroom: stats, on, off, compact, clear, test, service, version, config, set, debug, start, stop, restart, update",
    getArgumentCompletions: (prefix) => completeHeadroomCommand(prefix, HEADROOM_TEST_SURFACES),
    handler: async (args, ctx) => {
      const parts = String(args || "")
        .trim()
        .split(/\s+/);
      const action = parts[0]?.toLowerCase() || "stats";
      const sub = parts.slice(1).join(" ");

      if (action === "on") {
        state.enabled = true;
        await ensureProxy(ctx, state, 25_000);
        ctx.ui.notify("Headroom enabled.", "info");
      } else if (action === "off") {
        state.enabled = false;
        ctx.ui.notify("Headroom disabled for this session.", "info");
      } else if (action === "compact") {
        await runHeadroomCompaction(ctx, state);
      } else if (action === "clear") {
        if (sub !== "session confirm") {
          ctx.ui.notify(
            "This deletes the current session's Headroom CCR archives and archive counters. Run /headroom clear session confirm to continue.",
            "warn",
          );
        } else {
          const sessionId = safeSessionId(ctx?.sessionManager?.getSessionId?.());
          if (!sessionId) {
            ctx.ui.notify("Headroom clear failed: no valid current OMP session ID.", "error");
          } else {
            const ccr = await clearCcrSession(sessionId);
            const statsCleared = await clearArchiveTotals(sessionId);
            if (!ccr.cleared || !statsCleared) {
              ctx.ui.notify(
                `Headroom clear failed: ${ccr.retainedEntries} archive entries could not be removed.`,
                "error",
              );
            } else {
              state.ccrHashes = 0;
              state.sessionArchiveCompactions = 0;
              state.sessionArchiveCharsBefore = 0;
              state.sessionArchiveCharsAfter = 0;
              state.sessionArchiveCharsSaved = 0;
              state._archiveHydrated = true;
              ctx.ui.notify(
                `Cleared Headroom data for this session: ${ccr.deletedFiles} CCR archive files and archive counters.`,
                "info",
              );
            }
          }
        }
      } else if (action === "test") {
        const created = await createHeadroomTranscriptFixture(ctx, state, sub);
        if (created === undefined) {
          ctx.ui.notify(
            `Unknown Headroom test "${sub || "(empty)"}". Available: ${HEADROOM_TEST_SURFACES.join(", ")}.`,
            "warn",
          );
        } else if (created && typeof created === "object" && "error" in created) {
          ctx.ui.notify(`Headroom test failed: ${created.error}`, "error");
        } else if (!created) {
          ctx.ui.notify("Headroom test requires an interactive OMP session.", "warn");
        }
      } else if (action === "service") {
        const serviceAction = parseServiceAction(sub);
        if (!serviceAction) {
          ctx.ui.notify(
            `${serviceActionUsage()}\nThe service command only manages ${SYSTEMD_UNIT}.`,
            "warn",
          );
        } else {
          await manageHeadroomUserService(serviceAction, ctx, state);
        }
      } else if (action === "version") {
        const proxyVer = state.version || "?";
        const proxyReady = state.proxyReady
          ? "ready"
          : state.proxyStarting
            ? "starting"
            : "offline";
        const extPath = import.meta.path || join(PACKAGE_ROOT, "src", "index.ts");
        let extBuild = "?";
        try {
          extBuild = createHash("sha256").update(readFileSync(extPath)).digest("hex").slice(0, 12);
        } catch {
          // Missing/unreadable source is already reported by the plugin status.
        }
        ctx.ui.notify(
          `Headroom plugin:\n` +
            `  plugin: ${existsSync(extPath) ? "installed" : "missing"}\n` +
            `  path: ${extPath}\n` +
            `  build: ${extBuild}\n` +
            `  proxy: ${PROXY_URL} (${proxyVer}, ${proxyReady})\n` +
            `  binary: ${HEADROOM_BIN}\n` +
            `  config: ${HEADROOM_CONFIG_PATH}${existsSync(HEADROOM_CONFIG_PATH) ? ` (loaded, ${Object.keys(_cfg).length} keys)` : " (absent — env only)"}\n` +
            `  logs: ${LOGS_DIR}/\n` +
            `  autoupdate: ${AUTOUPDATE ? "on" : "off"}\n` +
            `  provider archive: ${SESSION_ARCHIVE_ENABLED ? "on" : "off"}`,
          "info",
        );
      } else if (action === "config") {
        const rows = HEADROOM_SETTINGS.map((setting) => {
          const value = effectiveSettingValue(setting);
          const rendered = typeof value === "boolean" ? (value ? "on" : "off") : String(value);
          const source = settingSource(setting);
          const invalid = invalidSettingValue(setting);
          const suffix = invalid === undefined ? "" : ` — invalid "${invalid}", using default`;
          return `  ${setting.key} = ${rendered} (${source === "env" ? setting.env : source})${suffix}`;
        });
        ctx.ui.notify(
          `Headroom config — ${HEADROOM_CONFIG_PATH}${existsSync(HEADROOM_CONFIG_PATH) ? "" : " (absent)"}\n` +
            `${rows.join("\n")}\n` +
            `  proxy: ${state.version || "?"} ${state.proxyReady ? "ready" : "offline"}\n` +
            `Change with: /headroom set <key> <value>`,
          "info",
        );
      } else if (action === "set") {
        const match = sub.match(/^(\S+)(?:\s+([\s\S]+))?$/);
        const key = match?.[1] ?? "";
        const rawValue = match?.[2] ?? "";
        const setting = HEADROOM_SETTINGS.find((entry) => entry.key === key);
        if (!setting) {
          const known = HEADROOM_SETTINGS.map((entry) => entry.key).join(", ");
          ctx.ui.notify(
            key
              ? `Unknown Headroom setting "${key}". Known keys: ${known}`
              : `Usage: /headroom set <key> <value>\nKnown keys: ${known}`,
            "warn",
          );
        } else {
          try {
            const parsed = parseSettingValue(setting, rawValue);
            await saveHeadroomConfigKey(setting.key, parsed);
            const rendered = typeof parsed === "boolean" ? (parsed ? "on" : "off") : String(parsed);
            const overriddenByEnv = settingSource(setting) === "env";
            ctx.ui.notify(
              `Saved ${setting.key} = ${rendered} to ${HEADROOM_CONFIG_PATH}.\n` +
                (overriddenByEnv
                  ? `Warning: ${setting.env} is set and overrides the YAML value.\n`
                  : "") +
                `Takes effect after /reload-plugins or a new session.`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(`Headroom set failed: ${errorMessage(error)}`, "error");
          }
        }
      } else if (action === "debug") {
        const logFile = debugSizingLogPath(state);
        ctx.ui.notify(
          `Headroom debug:\n` +
            `  sizing: ${DEBUG_SIZING ? "ON" : "OFF"}\n` +
            `  log: ${logFile || "(no session ID)"}\n` +
            `  proxy: ${PROXY_URL}\n` +
            `  version: ${state.version || "?"}`,
          "info",
        );
      } else if (action === "start") {
        await ensureProxy(ctx, state, 25_000);
        ctx.ui.notify(
          state.proxyReady ? "Headroom proxy ready." : "Headroom proxy is still starting.",
          "info",
        );
      } else if (action === "stop") {
        if (await systemdUnitAvailable()) await systemdCtl("stop");
        if (state.proxyProcess) state.proxyProcess.kill("SIGTERM");
        state.proxyProcess = undefined;
        state.proxyReady = false;
        state.proxyStarting = false;
        ctx.ui.notify("Headroom proxy stopped.", "info");
      } else if (action === "restart") {
        const restarted = await restartProxy(ctx, state);
        ctx.ui.notify(
          restarted
            ? "Headroom proxy restarted."
            : state.lastError || "Headroom proxy is still starting.",
          restarted ? "info" : "warn",
        );
      } else if (action === "update") {
        state.lastError = "";
        state.installState = "updating";
        renderWidget(ctx, state);
        // Auto-clear "updating" after 45s even if the process hangs
        // (matches the lock stale timeout / observed install duration).
        const clearTimer = setTimeout(() => {
          if (state.installState) {
            state.installState = "";
            renderWidget(ctx, state);
          }
        }, UPDATE_AUTO_CLEAR_MS);
        await maintainInstall(ctx, state, true);
        // Unconditionally clear "updating": maintainInstall early-returns on
        // up-to-date (no version change) or lock-held without touching
        // installState, so relying on it leaves the indicator stuck forever.
        if (state.installState === "updating") state.installState = "";
        clearTimeout(clearTimer);
        if (state.lastError) {
          ctx.ui.notify(`Headroom update failed: ${state.lastError}`, "error");
        } else {
          const upToDate = state.version && !isNewer(state.latest, state.version);
          ctx.ui.notify(
            `Headroom ${state.version || "?"}${upToDate ? " (up to date)" : ""}`,
            "info",
          );
        }
      } else if (action === "help" || action === "stats") {
        if (action === "help") {
          const lines = commandHelpLines();
          ctx.ui.notify(`Headroom commands:\n${lines.join("\n")}`, "info");
        } else {
          await ensureProxy(ctx, state, 3_000);
          await fetchStats(state, true);
          ctx.ui.notify(commandSummary(state), "info");
        }
      } else {
        // Unknown subcommand → show help
        const lines = commandHelpLines();
        ctx.ui.notify(`Unknown command "${action}". Available:\n${lines.join("\n")}`, "info");
      }
      renderWidget(ctx, state);
    },
  };
  pi.registerCommand("headroom", headroomCommand);
}
