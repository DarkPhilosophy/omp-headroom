// OMP Headroom integration: context compression + CCR retrieval tools.
// @ts-nocheck
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const EXTENSION_KEY = "headroom";
const RETRIEVE_TOOL = "headroom_retrieve";
const COMPRESS_TOOL = "headroom_compress";
const STATS_TOOL = "headroom_stats";

const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
// "rightEditor" needs the right-panel OMP fork; stock OMP renders widgets at the bottom.
const WIDGET_PLACEMENT = process.env.OMP_HEADROOM_WIDGET_PLACEMENT || "rightEditor";
const DEFAULT_HEADROOM_BIN = join(homedir(), ".omp", "agent", "headroom-venv", "bin", "headroom");

const PROXY_URL = (process.env.OMP_HEADROOM_URL || DEFAULT_PROXY_URL).replace(/\/+$/, "");
const DASHBOARD_URL = `${PROXY_URL}/dashboard`;
const HEADROOM_BIN = process.env.OMP_HEADROOM_BIN || DEFAULT_HEADROOM_BIN;
const MIN_TOOL_TEXT_CHARS = Number(process.env.OMP_HEADROOM_MIN_TOOL_CHARS || 12_000);
const ANTHROPIC_MIN_TOOL_TEXT_CHARS = Number(process.env.OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS || 8_000);
const PROVIDER_MIN_TEXT_CHARS = Number(process.env.OMP_HEADROOM_MIN_PROVIDER_CHARS || 1_000);
// Adaptive thresholds: as the session context fills up, the bar for "worth
// compressing" drops so more content gets compressed exactly when space is
// scarce. Pure scaling — fidelity is untouched because compressed content
// stays retrievable via CCR hashes. Disable with OMP_HEADROOM_ADAPTIVE=0.
const ADAPTIVE_THRESHOLDS = process.env.OMP_HEADROOM_ADAPTIVE !== "0";
const ADAPTIVE_START_RATIO = Number(process.env.OMP_HEADROOM_ADAPTIVE_START || 0.5);
const ADAPTIVE_FULL_RATIO = Number(process.env.OMP_HEADROOM_ADAPTIVE_FULL || 0.9);
const ADAPTIVE_FLOOR_RATIO = Number(process.env.OMP_HEADROOM_ADAPTIVE_FLOOR || 0.25);
const SESSION_COMPACTION = process.env.OMP_HEADROOM_SESSION_COMPACTION !== "0";
const SESSION_LIVE_MESSAGES = Number(process.env.OMP_HEADROOM_LIVE_MESSAGES || 24);
const SESSION_PREFIX_MIN_CHARS = Number(process.env.OMP_HEADROOM_PREFIX_MIN_CHARS || 30_000);
const SESSION_PREFIX_MIN_SHARE = Number(process.env.OMP_HEADROOM_PREFIX_MIN_SHARE || 0.45);
const SESSION_ARCHIVE_MAX_MESSAGE_CHARS = Number(process.env.OMP_HEADROOM_ARCHIVE_MAX_MESSAGE_CHARS || 900);
const SESSION_ARCHIVE_MARKER = "[Headroom session archive]";
const SESSION_TELEMETRY = process.env.OMP_HEADROOM_SESSION_TELEMETRY === "1";
const WIDGET_ARCHIVE_REASON = process.env.OMP_HEADROOM_WIDGET_ARCHIVE_REASON === "1";
const SESSION_TELEMETRY_FILE = join(dirname(dirname(dirname(HEADROOM_BIN))), "headroom-session-telemetry.jsonl");
// 20s (was 8s): a cold first compress loads the local embedding model (~6s) and
// a large payload on top can exceed 8s, silently skipping compression. Prewarm
// removes the cold cost from the critical path; this covers the residual.
const PROVIDER_TIMEOUT_MS = Number(process.env.OMP_HEADROOM_TIMEOUT_MS || 12_000);
const TOOL_TIMEOUT_MS = Number(process.env.OMP_HEADROOM_TOOL_TIMEOUT_MS || 20_000);
const ANTHROPIC_PROVIDER_MODE = process.env.OMP_HEADROOM_ANTHROPIC_PROVIDER || "full";
const RAINBOW_MS = Number(process.env.OMP_HEADROOM_RAINBOW_MS || 180);
const RAINBOW_CODES = [196, 202, 226, 46, 51, 39, 129, 201];
// 30s (was 4s): once the proxy answered, trust it for longer. A busy proxy
// (loading the embedder, compressing a 200k-token payload, or swapping) can be
// slow to answer /livez; frequent re-checks then misfire and flip proxyReady
// to false, which freezes the widget and skips compression.
const READY_TTL_MS = Number(process.env.OMP_HEADROOM_READY_TTL_MS || 30_000);
const STATS_MIN_INTERVAL_MS = Number(process.env.OMP_HEADROOM_STATS_INTERVAL_MS || 2_500);
const WIDGET_PRIORITY = Number(process.env.OMP_HEADROOM_PRIORITY) || -1050; // between kickbacks (-1100) and usage (-1000)
const COMPRESSED_MARKER = "Retrieve more: hash=";
const RETRIEVED_MARKER = "[headroom:retrieved ";

const VENV_DIR = dirname(dirname(HEADROOM_BIN));
const VENV_PYTHON = join(VENV_DIR, "bin", "python");
const AUTOUPDATE = process.env.OMP_HEADROOM_AUTOUPDATE !== "0";
const UPDATE_INTERVAL_MS = Number(process.env.OMP_HEADROOM_UPDATE_INTERVAL_MS || 24 * 3_600_000);
const EXTRAS = process.env.OMP_HEADROOM_EXTRAS ?? "all";
const PACKAGE_SPEC = EXTRAS ? `headroom-ai[${EXTRAS}]` : "headroom-ai";
const UPDATE_STATE_FILE = join(dirname(VENV_DIR), ".headroom-update.json");
const UPDATE_LOCK_FILE = join(dirname(VENV_DIR), ".headroom-update.lock");
const CCR_DIR = join(dirname(VENV_DIR), "headroom-ccr");
const CCR_FALLBACK_TTL_MS = Number(process.env.OMP_HEADROOM_CCR_TTL_MS || 7 * 24 * 3_600_000);
const CODE_AWARE = process.env.OMP_HEADROOM_CODE_AWARE !== "0";
const PROXY_EXTRA_ARGS = (process.env.OMP_HEADROOM_PROXY_ARGS || "").split(/\s+/).filter(Boolean);
// Bounded parallel compression for Responses tool outputs: fast when several
// oversized outputs land in one request, without stampeding the local proxy.
const RESPONSES_COMPRESS_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.OMP_HEADROOM_RESPONSES_CONCURRENCY || 3) || 3));
const PYPI_JSON_URL = "https://pypi.org/pypi/headroom-ai/json";
const SKIP_TOOLS = new Set(
	(process.env.OMP_HEADROOM_SKIP_TOOLS || "edit,ast_edit,write,todo,resolve")
		.split(",")
		.map(name => name.trim().toLowerCase())
		.filter(Boolean),
);

// Cross-session subagent stats via filesystem IPC.
//
// loadLegacyPiModule imports each extension with `?mtime=<now>` (see
// legacy-pi-compat.ts), which busts Bun's module cache — so every session
// (main + each subagent) gets a SEPARATE module instance. Module-level
// counters are therefore NOT shared. We instead have each subagent instance
// write its own running totals to a per-instance JSON file; the main UI
// session reads + sums all of them to render `(+N)`.
// Each OMP process (instance) gets its own subdirectory so subagents from
// instance A never pollute instance B's (+N). All sessions — main + subagents —
// within the same process share the same process.pid.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const FOREIGN_DIR = join(dirname(VENV_DIR), "headroom-foreign", String(process.pid));
const FOREIGN_FILE = join(FOREIGN_DIR, `${INSTANCE_ID}.json`);
const FOREIGN_TTL_MS = Number(process.env.OMP_HEADROOM_FOREIGN_TTL_MS || 6 * 3_600_000);

// SHARED across all factory calls (main + subagent) because Bun caches the
// module despite loadLegacyPiModule's ?mtime bust. The factory creates a
// SEPARATE `state` object per call, so we can't use state.foreignSelf* —
// the subagent's state2.foreignSelf* is invisible to the main's state1.
// These module-level counters are the ONLY reliable cross-call bridge.
let _sharedForeignProvider = 0;
let _sharedForeignTool = 0;
let _sharedForeignCcr = 0;
let _sharedForeignCleared = false;
// Session IDs of subagents seen in THIS process (hasUI=false session_start).
// The main reads the proxy's per_project bucket for each to render (+N).
const _subagentSessionIds = new Set();

// Called by a subagent/advisor instance after it compresses. Writes this
// instance's cumulative foreign totals to its own file (overwrite, not append,
// so files stay tiny and concurrent writers never contend on one file).
function writeForeignSelf(state) {
	try {
		mkdirSync(FOREIGN_DIR, { recursive: true });
		writeFileSync(
			FOREIGN_FILE,
			JSON.stringify({
				provider: Math.max(0, asNumber(state.foreignSelfProvider)),
				tool: Math.max(0, asNumber(state.foreignSelfTool)),
				ccr: Math.max(0, asNumber(state.foreignSelfCcr)),
				ts: Date.now(),
			}),
		);
	} catch {
		// Best effort: never break a hook on IPC failure.
	}
}

function readForeignTotals() {
	const totals = { provider: 0, tool: 0, ccr: 0 };
	let files;
	try {
		files = readdirSync(FOREIGN_DIR);
	} catch {
		return totals;
	}
	const now = Date.now();
	for (const name of files) {
		if (!name.endsWith(".json") || name === `${INSTANCE_ID}.json`) continue;
		const file = join(FOREIGN_DIR, name);
		try {
			const data = JSON.parse(readFileSync(file, "utf8"));
			if (now - asNumber(data?.ts) > FOREIGN_TTL_MS) {
				try { unlinkSync(file); } catch {}
				continue;
			}
			totals.provider += Math.max(0, asNumber(data?.provider));
			totals.tool += Math.max(0, asNumber(data?.tool));
			totals.ccr += Math.max(0, asNumber(data?.ccr));
		} catch {
			// Ignore unreadable/half-written files.
		}
	}
	return totals;
}

// Called by the main UI session at session_start: wipe stale foreign files so
// each fresh main session starts its `(+N)` aggregation clean.
function clearForeignFiles() {
	let files;
	try {
		files = readdirSync(FOREIGN_DIR);
	} catch {
		return;
	}
	for (const name of files) {
		try { unlinkSync(join(FOREIGN_DIR, name)); } catch {}
	}
}

function computeInner(contentWidth = 0) {
	const cols = process.stdout.columns || 102;
	const envMax = Number(process.env.OMP_HEADROOM_WIDGET_MAX_WIDTH || 0);
	const envMin = Number(process.env.OMP_HEADROOM_WIDGET_MIN_WIDTH || 0);
	const min = Number.isFinite(envMin) && envMin >= 12 ? envMin : 18;
	const autoMax = Math.max(min, Math.min(52, Math.floor(cols * 0.45) - 2));
	const cap = Number.isFinite(envMax) && envMax >= min ? envMax : autoMax;
	return Math.max(min, Math.min(cap, Math.max(min, contentWidth)));
}

function color(code, text) {
	return `\x1b[${code}m${text}\x1b[0m`;
}

function rainbow(text, phase) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		out += color(`38;5;${RAINBOW_CODES[(i + phase) % RAINBOW_CODES.length]}`, text[i]);
	}
	return out;
}
// OSC 8 terminal hyperlink (zero visible width): makes the rainbow title a
// Ctrl/Cmd-clickable link to the dashboard. Renderers without OSC 8 ignore
// the escapes and show plain text, so it degrades cleanly.
function link(url, text) {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function clip(text, max) {
	const value = String(text ?? "");
	if (value.length <= max) return value;
	return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}
function row(text, inner) {
	const value = clip(text, Math.max(0, inner - 1));
	return `│${value}${" ".repeat(Math.max(0, inner - value.length))}│`;
}
// Border line with content embedded in the frame. Raw strings carry the
// visible width (ANSI/OSC escapes in styled strings are zero-width).
function borderLine(inner, open, close, leftRaw, leftStyled, rightRaw = "", rightStyled = "") {
	const fill = Math.max(1, inner + 2 - 2 - leftRaw.length - rightRaw.length);
	return `${open}${leftStyled}${"─".repeat(fill)}${rightStyled}${close}`;
}


// Compact token count for the widget: 16,468,518 -> "16.5M", 12,300 -> "12.3k".
function formatCompactTokens(value) {
	const n = Math.max(0, asNumber(value));
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

// Proxy lifetime tokens saved across ALL sessions. Prefer the persistent
// lifetime store (survives proxy restarts) over the current-process totals.
function proxyLifetimeTokens(state) {
	const stats = state.stats;
	const comp = stats?.summary?.compression;
	return asNumber(
		stats?.persistent_savings?.lifetime?.tokens_saved ??
			stats?.tokens?.saved ??
			comp?.totalTokensRemoved ??
			comp?.total_tokens_removed ??
			0,
	);
}

function proxyLifetimeUsd(state) {
	const stats = state.stats;
	return asNumber(
		stats?.persistent_savings?.lifetime?.compression_savings_usd ??
			stats?.cost?.savingsUsd ??
			stats?.summary?.cost?.totalSavedUsd ??
			stats?.summary?.cost?.total_saved_usd ??
			0,
	);
}

// Per-session proxy stats from /stats savings.per_project[sessionId]. The proxy
// tracks compression per OMP session (keyed by session ID). Returns the entry
// for THIS session, or undefined.
function sessionProxyStats(state) {
	if (!state.sessionId) return undefined;
	return state.stats?.savings?.per_project?.[state.sessionId];
}

function compactStatsLine(state) {
	const seg = (label, main, foreign) => {
		const m = Math.max(0, asNumber(main));
		const f = Math.max(0, asNumber(foreign));
		return `${label} ${formatInt(m)}${f > 0 ? ` (+${formatInt(f)})` : ""}`;
	};
	// FALLBACK: when the extension's own req counter is 0 (old cached module, or
	// proxy compresses at transport level only), use the per-session proxy
	// request count so the widget reflects real activity.
	// Prefer the proxy per-session request count (accurate, matches the
	// dashboard). Fall back to the extension's in-memory counter only when proxy
	// data is unavailable (no sessionId / pre-first-fetch).
	const _ps = sessionProxyStats(state);
	let reqCount = (_ps && asNumber(_ps.requests) > 0) ? asNumber(_ps.requests) : state.providerCompressions;
	// Subagent (+N): sum the proxy per_project requests for every subagent
	// session ID seen in this process. Falls back to module-level counters
	// (set by the extension's own hooks) when proxy data is unavailable.
	let foreignReq = _sharedForeignProvider;
	const pp = state.stats?.savings?.per_project;
	if (pp && _subagentSessionIds.size > 0) {
		let sum = 0;
		for (const sid of _subagentSessionIds) sum += Math.max(0, asNumber(pp[sid]?.requests));
		if (sum > 0) foreignReq = sum;
	}
	const lines = [
		seg("req", reqCount, foreignReq),
		seg("tool", state.toolCompressions, _sharedForeignTool),
		seg("ccr", state.ccrHashes, _sharedForeignCcr),
	];
	if (state.sessionArchiveCompactions > 0) lines.push(`arch ${formatInt(state.sessionArchiveCompactions)}`);
	return lines.join(" · ");
}

function localCompressionLine(state) {
	// Prefer the proxy per-session savings (accurate, matches the dashboard:
	// tokens_saved / savings_percent / compression_savings_usd). Fall back to
	// the extension's in-memory cumulative only when proxy data is unavailable.
	// (The old "ctx X>Y" line showed the in-memory SUM of every compression's
	// input size — misleading, it looked like an 8M-token single context.)
	const ps = sessionProxyStats(state);
	if (ps && asNumber(ps.tokens_saved) > 0) {
		const saved = asNumber(ps.tokens_saved);
		const pct = asNumber(ps.savings_percent ?? ps.compression_pct);
		const archive = state.sessionArchiveCharsSaved > 0 ? ` · arch ${formatCompactTokens(state.sessionArchiveCharsSaved)}ch` : "";
		return `saved ${formatInt(saved)} · ${formatPct(pct)}${archive}`;
	}
	const saved = Math.max(0, asNumber(state.tokensSaved));
	const pct = state.tokensBefore > 0 ? (state.tokensSaved / state.tokensBefore) * 100 : 0;
	const archive = state.sessionArchiveCharsSaved > 0 ? ` · arch ${formatCompactTokens(state.sessionArchiveCharsSaved)}ch` : "";
	return `saved ${formatInt(saved)} · ${formatPct(pct)}${archive}`;
}

function archiveAttemptLine(state) {
	if (!WIDGET_ARCHIVE_REASON) return "";
	const a = state.lastSessionArchive;
	if (!a?.reason || a.reason !== "compacted") return "";
	const share = Number.isFinite(a.prefixShare) ? `/${formatPct(a.prefixShare * 100)}` : "";
	const prefix = Number.isFinite(a.prefixChars) ? ` ${formatCompactTokens(a.prefixChars)}ch${share}` : "";
	const saved = state.sessionArchiveCharsSaved > 0 ? ` · ${formatCompactTokens(state.sessionArchiveCharsSaved)}ch saved` : "";
	return ` arch ${formatInt(state.sessionArchiveCompactions)} · ${a.reason}${prefix}${saved}`;
}


const RETRIEVE_DESCRIPTION =
	"Retrieve original uncompressed content that Headroom compressed to save tokens. Use this when a compression marker/hash indicates more details are available.";
const RETRIEVE_SCHEMA = {
	type: "object",
	properties: {
		hash: {
			type: "string",
			description: "Hash key from a Headroom compression marker, for example the value after hash=.",
		},
		query: {
			type: "string",
			description: "Optional search query. When provided, returns only original content chunks matching the query.",
		},
	},
	required: ["hash"],
};

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The ONLY reliable discriminator between the main UI session and a
// subagent/advisor: ctx.hasUI. OMP sets hasUI=true only for the real
// interactive session; subagents are created with hasUI:false and a
// `noOpUIContext` whose `setWidget` IS a (no-op) function — so checking
// `typeof ctx.ui.setWidget === "function"` WRONGLY classifies subagents as
// main. Never use the setWidget fallback for this decision.
function isMainSession(ctx) {
	return ctx?.hasUI === true;
}

function asNumber(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatInt(value) {
	return Math.round(asNumber(value)).toLocaleString();
}

function formatPct(value) {
	const n = asNumber(value);
	return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function formatUsd(value) {
	const n = asNumber(value);
	return n > 0 ? `$${n.toFixed(2)}` : "$0.00";
}

function proxyPort() {
	try {
		return Number(new URL(PROXY_URL).port || 8787);
	} catch {
		return 8787;
	}
}

function proxyPath(path) {
	return `${PROXY_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function uvBin() {
	if (process.env.OMP_HEADROOM_UV) return process.env.OMP_HEADROOM_UV;
	const local = join(homedir(), ".local", "bin", "uv");
	return existsSync(local) ? local : "uv";
}

function run(command, args, timeoutMs) {
	return new Promise(resolve => {
		let out = "";
		let err = "";
		let child;
		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: -1, out, err: String(error?.message || error) });
			return;
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		timer.unref?.();
		child.stdout.on("data", chunk => (out += chunk));
		child.stderr.on("data", chunk => (err += chunk));
		child.once("error", error => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: String(error?.message || error) });
		});
		child.once("close", code => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, out, err });
		});
	});
}

const SYSTEMD_UNIT = process.env.OMP_HEADROOM_SYSTEMD_UNIT ?? "headroom-proxy.service";
const STATS_PLUGIN_DIR = join(dirname(VENV_DIR), "headroom-omp-stats");
let systemdUnitKnown;

async function systemdUnitAvailable() {
	if (!SYSTEMD_UNIT) return false;
	if (systemdUnitKnown === undefined) {
		const result = await run("systemctl", ["--user", "cat", SYSTEMD_UNIT], 5_000);
		systemdUnitKnown = result.code === 0;
	}
	return systemdUnitKnown;
}

// Whether the proxy systemd unit is currently active (running). Used to avoid
// re-issuing `start` on a unit that is already up — a busy proxy can be slow to
// answer /livez, and a redundant restart wrongly parks the widget in "starting".
async function systemdUnitActive() {
	if (!SYSTEMD_UNIT) return false;
	const result = await run("systemctl", ["--user", "is-active", SYSTEMD_UNIT], 5_000);
	return result.out.trim() === "active";
}

function systemdCtl(verb) {
	return run("systemctl", ["--user", verb, SYSTEMD_UNIT], 30_000);
}


async function installStatsPlugin() {
	if (!existsSync(join(STATS_PLUGIN_DIR, "pyproject.toml"))) return;
	await run(uvBin(), ["pip", "install", "-p", VENV_PYTHON, "--no-progress", "--reinstall", STATS_PLUGIN_DIR], 300_000);
}

async function restartProxy(ctx, state) {
	if (state.proxyProcess) {
		state.proxyProcess.kill("SIGTERM");
		state.proxyProcess = undefined;
		await sleep(500);
	}
	if (await systemdUnitAvailable()) {
		const result = await systemdCtl("restart");
		if (result.code !== 0) state.lastError = `systemctl restart failed: ${clip(result.err.trim(), 200)}`;
	} else {
		await run("pkill", ["-f", `${HEADROOM_BIN} proxy`], 10_000);
		await sleep(750);
	}
	state.proxyReady = false;
	state.proxyStarting = false;
	return ensureProxy(ctx, state, 25_000);
}

async function installedVersion() {
	if (!existsSync(VENV_PYTHON)) return "";
	const result = await run(VENV_PYTHON, ["-c", "from importlib.metadata import version;print(version('headroom-ai'))"], 15_000);
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

function isNewer(candidate, current) {
	if (!candidate || !current) return false;
	const a = String(candidate).split(/[^0-9]+/).filter(Boolean).map(Number);
	const b = String(current).split(/[^0-9]+/).filter(Boolean).map(Number);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const delta = (a[i] || 0) - (b[i] || 0);
		if (delta !== 0) return delta > 0;
	}
	return false;
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

let maintenanceInFlight;

// ROCm torch survival: a `headroom` upgrade pulls torch from the default (CUDA)
// PyPI index, which silently replaces the ROCm build and breaks GPU kompress
// (cuda.is_available goes False, kompress falls back to slow CPU). After any
// upgrade we detect whether the venv was ROCm and re-pin the ROCm torch from
// the ROCm wheel index. Override the pinned build/index via env if a newer
// ROCm wheel is needed. Inert on a CUDA venv (isRocmVenv returns false).
const ROCM_TORCH_SPEC = process.env.OMP_HEADROOM_ROCM_TORCH || "torch==2.9.1+rocm6.4";
const ROCM_TORCH_INDEX = process.env.OMP_HEADROOM_ROCM_INDEX || "https://download.pytorch.org/whl/rocm6.4";
async function isRocmVenv() {
	if (!existsSync(VENV_PYTHON)) return false;
	try {
		const r = await run(VENV_PYTHON, ["-c", "import torch,sys; sys.exit(0 if '+rocm' in torch.__version__ else 1)"], 15_000);
		return r.code === 0;
	} catch { return false; }
}
async function repinRocmTorch() {
	const r = await run(uvBin(), ["pip", "install", "-p", VENV_PYTHON, "--no-progress", ROCM_TORCH_SPEC, "--index-url", ROCM_TORCH_INDEX], 600_000);
	if (r.code !== 0) throw new Error(`ROCm torch re-pin failed: ${clip(r.err.trim(), 300)}`);
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
	if (!AUTOUPDATE && !force) return;
	try {
		if (!existsSync(HEADROOM_BIN)) {
			if (!acquireUpdateLock()) return;
			try {
				state.installState = "installing";
				renderWidget(ctx, state);
				ctx?.ui?.notify?.(`Installing ${PACKAGE_SPEC} into ${VENV_DIR}…`, "info");
				if (!existsSync(VENV_PYTHON)) {
					const venv = await run(uvBin(), ["venv", VENV_DIR], 120_000);
					if (venv.code !== 0) throw new Error(`uv venv failed: ${clip(venv.err.trim(), 200)}`);
				}
				const install = await run(uvBin(), ["pip", "install", "-p", VENV_PYTHON, "--no-progress", PACKAGE_SPEC], 1_800_000);
				if (install.code !== 0) throw new Error(`headroom install failed: ${clip(install.err.trim(), 300)}`);
				await installStatsPlugin();
				state.installState = "";
				state.version = await installedVersion();
				writeUpdateStamp({ checkedAt: Date.now(), latest: state.version });
				ctx?.ui?.notify?.(`Headroom ${state.version} installed.`, "info");
			} finally {
				releaseUpdateLock();
			}
			return;
		}

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
		const wasRocm = await isRocmVenv();
		state.installState = "updating";
		renderWidget(ctx, state);
		const upgrade = await run(uvBin(), ["pip", "install", "-p", VENV_PYTHON, "--upgrade", "--no-progress", PACKAGE_SPEC], 1_800_000);
		if (upgrade.code !== 0) throw new Error(`headroom update failed: ${clip(upgrade.err.trim(), 300)}`);
		state.installState = "";
		state.version = await installedVersion();
		writeUpdateStamp({ checkedAt: Date.now(), latest: state.version });
		await installStatsPlugin();
		if (wasRocm) await repinRocmTorch();
			await restartProxy(ctx, state);
			ctx?.ui?.notify?.(`Headroom updated to ${state.version}; proxy restarted.`, "info");
		} finally {
			releaseUpdateLock();
		}
	} catch (error) {
		state.installState = "";
		state.lastError = String(error?.message || error);
	} finally {
		renderWidget(ctx, state);
	}
}

function ccrFallbackPath(hash, dir = CCR_DIR) {
	const slug = String(hash || "").replace(/[^0-9A-Za-z_-]/g, "");
	return slug ? join(dir, `${slug}.txt`) : "";
}

export async function readCcrFallback(hash, dir = CCR_DIR) {
	const file = ccrFallbackPath(hash, dir);
	if (!file) return undefined;
	try {
		const original = await readFile(file, "utf8");
		return original || undefined;
	} catch {
		return undefined;
	}
}

async function persistCcrOriginal(result, originalText, compressedText, state, ctx) {
	try {
		// 0.25.x stopped populating ccr_hashes on /v1/compress; the hashes only
		// appear as inline "Retrieve more: hash=…" markers in the compressed text.
		const hashes = new Set(Array.isArray(result?.ccrHashes) ? result.ccrHashes : []);
		if (typeof compressedText === "string") {
			for (const match of compressedText.matchAll(/hash=([0-9a-f]{8,})/g)) hashes.add(match[1]);
		}
		if (hashes.size === 0 || typeof originalText !== "string" || !originalText) return 0;
		await mkdir(CCR_DIR, { recursive: true });
		await Promise.all(
			[...hashes].map(hash => {
				const file = ccrFallbackPath(hash);
				return file ? writeFile(file, originalText, "utf8") : undefined;
			}),
		);
		// Count exactly 1 CCR per successful save — NOT hashes.size (which re-counts
		// old hashes from compressed text and causes exponential growth).
		if (state && ctx) {
			if (isMainSession(ctx)) {
				state.ccrHashes += 1;
			} else {
				_sharedForeignCcr += 1;
			}
		}
		return 1;
	} catch {
		// Best effort: the proxy store remains the primary source.
		return 0;
	}
}

// Make a chained archive file self-contained: inline the full original text of
// every session archive referenced from the new prefix. Without this, CCR TTL
// cleanup could delete an older chain link while a newer archive still points
// at it, silently losing history. `readHashFile` returns "" when unavailable.
export function expandSessionArchiveText(originalText, readHashFile) {
	try {
		const prefix = JSON.parse(originalText);
		if (!Array.isArray(prefix)) return originalText;
		const parts = [];
		const seen = new Set();
		for (const message of prefix) {
			if (!messageHasSessionArchive(message)) continue;
			const texts = [];
			collectProviderTextCandidates(message?.content, texts);
			for (const text of texts) {
				const match = typeof text === "string" ? text.match(/Full original prefix: Retrieve more: hash=([0-9a-f]{8,})/) : null;
				const hash = match?.[1];
				if (!hash || seen.has(hash)) continue;
				seen.add(hash);
				const original = readHashFile(hash);
				if (typeof original === "string" && original) {
					parts.push(`--- chained session archive hash=${hash} (full original) ---\n${original}`);
				}
			}
		}
		return parts.length ? `${originalText}\n\n${parts.join("\n\n")}` : originalText;
	} catch {
		return originalText;
	}
}

async function persistSessionArchive(compaction, state, ctx) {
	if (!compaction?.compacted || !compaction.hash || typeof compaction.originalText !== "string") return 0;
	try {
		await mkdir(CCR_DIR, { recursive: true });
		const file = ccrFallbackPath(compaction.hash);
		if (!file) return 0;
		const existed = existsSync(file);
		if (!existed) {
			const fileText = expandSessionArchiveText(compaction.originalText, hash => {
				try {
					return readFileSync(ccrFallbackPath(hash), "utf8");
				} catch {
					return "";
				}
			});
			await writeFile(file, fileText, "utf8");
		}
		if (state) {
			state.sessionArchiveCompactions += 1;
			state.sessionArchiveCharsBefore += Math.max(0, asNumber(compaction.prefixChars));
			state.sessionArchiveCharsAfter += Math.max(0, asNumber(compaction.archiveChars));
			state.sessionArchiveCharsSaved += Math.max(0, asNumber(compaction.prefixChars) - asNumber(compaction.archiveChars));
		}
		if (!existed && state && ctx) {
			if (isMainSession(ctx)) state.ccrHashes += 1;
			else _sharedForeignCcr += 1;
		}
		return 1;
	} catch {
		return 0;
	}
}

// Holistic provider path: count tool results SmartCrusher crushed and marked
// with "Retrieve more: hash=…". Per-project (main → state.ccrHashes, subagent
// → shared counter). Only counts NEW markers (absent from the original input)
// to avoid re-counting across turns.
function countNewCcr(originalMessages, result, state, ctx) {
	try {
		const compressed = result?.messages;
		if (!Array.isArray(compressed)) return;
		const oldMarkers = new Set(
			(JSON.stringify(originalMessages || []).match(/Retrieve more: hash=[a-f0-9]{8,}/g) || []),
		);
		let n = 0;
		for (const m of compressed) {
			if (m?.role !== "tool" || typeof m?.content !== "string") continue;
			const here = m.content.match(/Retrieve more: hash=[a-f0-9]{8,}/g) || [];
			if (here.some(mk => !oldMarkers.has(mk))) n += 1;
		}
		if (n > 0) {
			if (ctx && !isMainSession(ctx)) _sharedForeignCcr += n;
			else if (state) state.ccrHashes += n;
		}
	} catch { /* best effort */ }
}

async function cleanupCcrFallback() {
	try {
		const cutoff = Date.now() - CCR_FALLBACK_TTL_MS;
		for (const name of await readdir(CCR_DIR)) {
			const file = join(CCR_DIR, name);
			try {
				if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
			} catch {
				// Skip races.
			}
		}
	} catch {
		// Directory absent.
	}
}

async function reconcileProxyVersion(ctx, state) {
	if (!AUTOUPDATE || !state.proxyReady) return;
	try {
		const response = await fetch(proxyPath("/livez"), { method: "GET", signal: AbortSignal.timeout(2_000) });
		if (!response.ok) return;
		const live = await response.json();
		const liveVersion = typeof live?.version === "string" ? live.version : "";
		if (!state.version) state.version = await installedVersion();
		if (!liveVersion || !state.version || liveVersion === state.version) return;
		if (await systemdUnitActive()) {
			// The user systemd unit owns the live proxy. Restarting it cannot make
			// it report the extension venv's version if ExecStart points elsewhere.
			// Avoid a notification/restart loop; the real fix is aligning the unit
			// venv with OMP_HEADROOM_BIN.
			return;
		}
		// An older proxy (often orphaned by a previous session) is still serving;
		// restart it so the upgraded install actually takes effect.
		await restartProxy(ctx, state);
		if (state.proxyReady) ctx?.ui?.notify?.(`Headroom proxy restarted on ${state.version} (was ${liveVersion}).`, "info");
	} catch {
		// Best effort.
	}
}

async function isProxyReady() {
	try {
		// 5s (was 1.2s): a busy/swapping proxy can be slow to answer /livez. A short
		// timeout falsely marks it dead and triggers a needless restart cycle that
		// leaves proxyReady stuck false (freezes the widget + skips compression).
		const response = await fetch(proxyPath("/livez"), { method: "GET", signal: AbortSignal.timeout(5_000) });
		return response.ok;
	} catch {
		return false;
	}
}

function systemToText(system) {
	if (typeof system === "string") return system;
	if (!Array.isArray(system)) return undefined;
	const parts = [];
	for (const item of system) {
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		if (isRecord(item) && typeof item.text === "string") {
			parts.push(item.text);
			continue;
		}
		parts.push(JSON.stringify(item));
	}
	return parts.join("\n");
}

function inferProviderFormat(payload) {
	if (!isRecord(payload)) return "openai";
	if (payload.system !== undefined) return "anthropic";
	if (Array.isArray(payload.input)) return "responses";
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	for (const tool of tools) {
		if (isRecord(tool) && "input_schema" in tool) return "anthropic";
	}
	return "openai";
}

function effectiveProviderFormat(payload, ctx) {
	const inferred = inferProviderFormat(payload);
	if (inferred !== "openai") return inferred;
	const provider = ctx?.model?.provider;
	if (provider === "anthropic") return "anthropic";
	return inferred;
}

function hasRetrieveTool(tools) {
	if (!Array.isArray(tools)) return false;
	return tools.some(tool => {
		if (!isRecord(tool)) return false;
		if (tool.name === RETRIEVE_TOOL) return true;
		if (isRecord(tool.function) && tool.function.name === RETRIEVE_TOOL) return true;
		return false;
	});
}

function retrieveToolDefinition(provider) {
	if (provider === "responses") {
		return { type: "function", name: RETRIEVE_TOOL, description: RETRIEVE_DESCRIPTION, parameters: RETRIEVE_SCHEMA };
	}
	if (provider === "anthropic") {
		return { name: RETRIEVE_TOOL, description: RETRIEVE_DESCRIPTION, input_schema: RETRIEVE_SCHEMA };
	}
	return { type: "function", function: { name: RETRIEVE_TOOL, description: RETRIEVE_DESCRIPTION, parameters: RETRIEVE_SCHEMA } };
}

function withRetrieveTool(payload, providerOverride) {
	if (!isRecord(payload)) return payload;
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (hasRetrieveTool(tools)) return payload;
	const provider = providerOverride || inferProviderFormat(payload);
	return { ...payload, tools: [...tools, retrieveToolDefinition(provider)] };
}

function getTextBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter(block => isRecord(block) && block.type === "text" && typeof block.text === "string");
}

function textContentLength(content) {
	let length = 0;
	for (const block of getTextBlocks(content)) length += block.text.length;
	return length;
}

function textHasCompressedMarker(text) {
	return typeof text === "string" && (text.includes(COMPRESSED_MARKER) || text.includes(RETRIEVED_MARKER));
}

function collectProviderTextCandidates(value, out) {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectProviderTextCandidates(item, out);
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.text === "string") out.push(value.text);
	if (typeof value.content === "string") out.push(value.content);
	else if (Array.isArray(value.content)) collectProviderTextCandidates(value.content, out);
	if (typeof value.output === "string") out.push(value.output);
}

function isProviderCompressionCandidate(text, minChars = PROVIDER_MIN_TEXT_CHARS) {
	return typeof text === "string" && !textHasCompressedMarker(text) && text.trim().length >= minChars;
}

export function payloadHasCompressedMarker(value) {
	if (typeof value === "string") return textHasCompressedMarker(value);
	if (Array.isArray(value)) return value.some(payloadHasCompressedMarker);
	if (!isRecord(value)) return false;
	return Object.values(value).some(payloadHasCompressedMarker);
}

export function providerPayloadHasCompressionCandidate(payload, minChars = PROVIDER_MIN_TEXT_CHARS) {
	if (!isRecord(payload)) return false;
	const topLevelTexts = [];
	collectProviderTextCandidates(payload.system, topLevelTexts);
	if (topLevelTexts.some(text => isProviderCompressionCandidate(text, minChars))) return true;
	const items = Array.isArray(payload.messages) ? payload.messages : Array.isArray(payload.input) ? payload.input : [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const texts = [];
		collectProviderTextCandidates(item.content, texts);
		const output = responseOutputText(item);
		if (typeof output === "string") texts.push(output);
		if (texts.some(text => isProviderCompressionCandidate(text, minChars))) return true;
	}
	return false;
}

function stableJson(value) {
	return JSON.stringify(value, (_key, v) => {
		if (!isRecord(v)) return v;
		const out = {};
		for (const key of Object.keys(v).sort()) out[key] = v[key];
		return out;
	});
}

function sessionHash(prefixMessages) {
	return createHash("sha256").update(stableJson(prefixMessages)).digest("hex").slice(0, 24);
}

function messageApproxChars(message) {
	if (!isRecord(message)) return 0;
	const texts = [];
	collectProviderTextCandidates(message.content, texts);
	if (typeof message.system === "string") texts.push(message.system);
	const textChars = texts.reduce((sum, text) => sum + String(text).length, 0);
	return Math.max(textChars, JSON.stringify(message).length);
}

function messageHasSessionArchive(message) {
	const texts = [];
	collectProviderTextCandidates(message?.content, texts);
	return texts.some(text => typeof text === "string" && text.includes(SESSION_ARCHIVE_MARKER));
}

function messageToolCallIds(message) {
	const ids = [];
	if (isRecord(message) && Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) {
			if (isRecord(call) && typeof call.id === "string") ids.push(call.id);
		}
	}
	if (isRecord(message) && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string") ids.push(block.id);
		}
	}
	if (isRecord(message) && (message.type === "function_call" || message.type === "custom_tool_call") && typeof message.call_id === "string") {
		ids.push(message.call_id);
	}
	return ids;
}

function messageToolResultIds(message) {
	const ids = [];
	if (isRecord(message) && message.role === "tool" && typeof message.tool_call_id === "string") ids.push(message.tool_call_id);
	if (isRecord(message) && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") ids.push(block.tool_use_id);
		}
	}
	if (isRecord(message) && (message.type === "function_call_output" || message.type === "custom_tool_call_output") && typeof message.call_id === "string") {
		ids.push(message.call_id);
	}
	return ids;
}

function safeSessionCut(messages, requestedCut) {
	let cut = Math.max(0, Math.min(messages.length, requestedCut));
	let changed = true;
	while (changed && cut > 0) {
		changed = false;
		const liveToolResults = new Set();
		for (let i = cut; i < messages.length; i++) {
			for (const id of messageToolResultIds(messages[i])) liveToolResults.add(id);
		}
		if (liveToolResults.size === 0) break;
		for (let i = cut - 1; i >= 0; i--) {
			if (messageToolCallIds(messages[i]).some(id => liveToolResults.has(id))) {
				cut = i;
				changed = true;
				break;
			}
		}
	}
	return cut;
}

function truncateMiddle(text, maxChars) {
	if (typeof text !== "string" || text.length <= maxChars) return text;
	const half = Math.max(20, Math.floor((maxChars - 40) / 2));
	return `${text.slice(0, half)}\n… [${text.length - (half * 2)} chars archived; retrieve full prefix by hash] …\n${text.slice(-half)}`;
}

function archiveLineForMessage(message, index, maxChars) {
	if (!isRecord(message)) return `- ${index}: ${String(message)}`;
	const role = String(message.role || message.type || "unknown");
	const ids = [];
	for (const id of messageToolCallIds(message)) ids.push(`tool_call=${id}`);
	for (const id of messageToolResultIds(message)) ids.push(`tool_result=${id}`);
	const texts = [];
	collectProviderTextCandidates(message.content, texts);
	const text = truncateMiddle(texts.join("\n\n").trim(), maxChars);
	const suffix = ids.length ? ` (${ids.join(", ")})` : "";
	return `- ${index}: ${role}${suffix}${text ? ` — ${text}` : ""}`;
}

function buildSessionArchiveText(prefixMessages, hash, options) {
	const maxChars = Math.max(120, Number(options.archiveMaxMessageChars ?? SESSION_ARCHIVE_MAX_MESSAGE_CHARS));
	const lines = [
		SESSION_ARCHIVE_MARKER,
		`Earlier stable conversation prefix compacted: ${prefixMessages.length} messages.`,
		`Full original prefix: Retrieve more: hash=${hash}`,
		"Recent live messages after this archive are verbatim and authoritative.",
		"Archive index:",
	];
	prefixMessages.forEach((message, index) => lines.push(archiveLineForMessage(message, index, maxChars)));
	return lines.join("\n");
}

export function createSessionCompaction(messages, options = {}) {
	if (options.enabled === false || !SESSION_COMPACTION) return { compacted: false, messages, reason: "disabled" };
	if (!Array.isArray(messages) || messages.length < 4) return { compacted: false, messages, reason: "too_few_messages" };
	// Re-compaction is allowed: an earlier archive message may be folded into
	// the next prefix (its hash line survives inside the new originalText, so
	// the retrieval chain stays intact). Only refuse when an archive-marker
	// message would sit in the live tail — archiving the archive's neighbors
	// without the marker scrolling into the stable prefix first.

	let headCount = 0;
	while (headCount < messages.length && isRecord(messages[headCount]) && ["system", "developer"].includes(String(messages[headCount].role || ""))) {
		headCount++;
	}
	const head = messages.slice(0, headCount);
	const body = messages.slice(headCount);
	const liveMessages = Math.max(1, Number(options.liveMessages ?? SESSION_LIVE_MESSAGES));
	let cut = safeSessionCut(body, Math.max(0, body.length - liveMessages));
	if (cut <= 0) return { compacted: false, messages, reason: "no_safe_prefix" };
	for (let i = cut; i < body.length; i++) {
		if (messageHasSessionArchive(body[i])) return { compacted: false, messages, reason: "existing_archive" };
	}
	const prefix = body.slice(0, cut);
	const live = body.slice(cut);
	const prefixChars = prefix.reduce((sum, message) => sum + messageApproxChars(message), 0);
	const totalChars = body.reduce((sum, message) => sum + messageApproxChars(message), 0);
	const minPrefixChars = Math.max(0, Number(options.minPrefixChars ?? SESSION_PREFIX_MIN_CHARS));
	const minPrefixShare = Math.max(0, Number(options.minPrefixShare ?? SESSION_PREFIX_MIN_SHARE));
	const prefixShare = totalChars > 0 ? prefixChars / totalChars : 0;
	if (prefixChars < minPrefixChars) {
		return { compacted: false, messages, reason: "prefix_too_small", prefixChars, totalChars, prefixShare, prefixCount: prefix.length, liveCount: live.length };
	}
	if (prefixShare < minPrefixShare) {
		return { compacted: false, messages, reason: "share_too_small", prefixChars, totalChars, prefixShare, prefixCount: prefix.length, liveCount: live.length };
	}
	const hash = sessionHash(prefix);
	const originalText = JSON.stringify(prefix, null, 2);
	const archiveText = buildSessionArchiveText(prefix, hash, options);
	const archiveMessage = { role: "user", content: archiveText };
	return {
		compacted: true,
		reason: "compacted",
		messages: [...head, archiveMessage, ...live],
		hash,
		originalText,
		prefixCount: prefix.length,
		liveCount: live.length,
		prefixChars,
		totalChars,
		prefixShare,
		archiveChars: archiveText.length,
	};
}

function asResponsesArchiveItem(message) {
	return {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: message.content }],
	};
}

export function createResponsesSessionCompaction(input, options = {}) {
	const compaction = createSessionCompaction(input, options);
	if (!compaction.compacted) return { ...compaction, input };
	return {
		...compaction,
		input: compaction.messages.map(message => {
			if (isRecord(message) && message.role === "user" && typeof message.content === "string" && message.content.includes(SESSION_ARCHIVE_MARKER)) {
				return asResponsesArchiveItem(message);
			}
			return message;
		}),
	};
}

function asAnthropicArchiveMessage(message) {
	if (!isRecord(message) || typeof message.content !== "string" || !message.content.includes(SESSION_ARCHIVE_MARKER)) return message;
	return { ...message, content: [{ type: "text", text: message.content }] };
}

function writeSessionTelemetry(state, compaction) {
	if (!SESSION_TELEMETRY || !state || !compaction) return;
	try {
		appendFileSync(SESSION_TELEMETRY_FILE, `${JSON.stringify({
			ts: new Date().toISOString(),
			pid: process.pid,
			sessionId: state.sessionId || "",
			reason: compaction.reason || (compaction.compacted ? "compacted" : "unknown"),
			compacted: !!compaction.compacted,
			prefixChars: asNumber(compaction.prefixChars),
			totalChars: asNumber(compaction.totalChars),
			prefixShare: asNumber(compaction.prefixShare),
			prefixCount: asNumber(compaction.prefixCount),
			liveCount: asNumber(compaction.liveCount),
			archiveChars: asNumber(compaction.archiveChars),
			compactions: asNumber(state.sessionArchiveCompactions),
			archiveSavedChars: asNumber(state.sessionArchiveCharsSaved),
		})}\n`);
	} catch {
		// Telemetry is best-effort and must never break the provider hook.
	}
}

function recordSessionCompactionAttempt(state, compaction) {
	if (!state || !compaction) return;
	state.lastSessionArchive = {
		reason: compaction.reason || (compaction.compacted ? "compacted" : "unknown"),
		compacted: !!compaction.compacted,
		prefixChars: asNumber(compaction.prefixChars),
		totalChars: asNumber(compaction.totalChars),
		prefixShare: asNumber(compaction.prefixShare),
		prefixCount: asNumber(compaction.prefixCount),
		liveCount: asNumber(compaction.liveCount),
		archiveChars: asNumber(compaction.archiveChars),
	};
	writeSessionTelemetry(state, compaction);
}

async function applyOpenAiSessionCompaction(payload, state, ctx) {
	const payloadWithTool = withRetrieveTool(payload);
	const { messages, hadSystem } = toOpenAiPayloadMessages(payloadWithTool);
	const compaction = createSessionCompaction(messages);
	if (!compaction.compacted) { recordSessionCompactionAttempt(state, compaction); return { payload: payloadWithTool, messages, hadSystem, compacted: false }; }
	await persistSessionArchive(compaction, state, ctx);
	recordSessionCompactionAttempt(state, compaction);
	const compactedPayload = withRetrieveTool(fromOpenAiPayloadMessages(payloadWithTool, compaction.messages, hadSystem));
	return { payload: compactedPayload, messages: compaction.messages, hadSystem, compacted: true };
}

async function applyAnthropicSessionCompaction(payload, state, ctx) {
	if (!Array.isArray(payload?.messages)) return { payload, compacted: false };
	const compaction = createSessionCompaction(payload.messages);
	if (!compaction.compacted) { recordSessionCompactionAttempt(state, compaction); return { payload, compacted: false }; }
	await persistSessionArchive(compaction, state, ctx);
	recordSessionCompactionAttempt(state, compaction);
	const messages = compaction.messages.map(asAnthropicArchiveMessage);
	return { payload: withRetrieveTool({ ...payload, messages }, "anthropic"), compacted: true };
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
export function adaptiveMinChars(base, usageRatio, { enabled = ADAPTIVE_THRESHOLDS } = {}) {
	const value = Math.max(0, asNumber(base));
	if (!enabled) return value;
	const start = Number.isFinite(ADAPTIVE_START_RATIO) ? Math.min(0.95, Math.max(0, ADAPTIVE_START_RATIO)) : 0.5;
	const full = Math.min(1, Math.max(start + 0.01, Number.isFinite(ADAPTIVE_FULL_RATIO) ? ADAPTIVE_FULL_RATIO : 0.9));
	const floorRatio = Number.isFinite(ADAPTIVE_FLOOR_RATIO) ? Math.min(1, Math.max(0.05, ADAPTIVE_FLOOR_RATIO)) : 0.25;
	const ratio = Math.min(1, Math.max(0, asNumber(usageRatio)));
	if (ratio <= start) return value;
	const t = Math.min(1, (ratio - start) / (full - start));
	const floor = value * floorRatio;
	return Math.round(value - t * (value - floor));
}

function contextWindow(ctx) {
	const usage = ctx?.getContextUsage?.();
	const value = usage?.contextWindow;
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeCompressionResult(data, fallbackMessages) {
	const before = asNumber(data?.tokens_before ?? data?.tokensBefore);
	const after = asNumber(data?.tokens_after ?? data?.tokensAfter);
	const saved = Math.max(0, asNumber(data?.tokens_saved ?? data?.tokensSaved, Math.max(0, before - after)));
	const ccrHashes = data?.ccr_hashes ?? data?.ccrHashes;
	return {
		messages: Array.isArray(data?.messages) ? data.messages : fallbackMessages,
		tokensBefore: before,
		tokensAfter: after,
		tokensSaved: saved,
		compressionRatio: asNumber(data?.compression_ratio ?? data?.compressionRatio, before > 0 ? after / before : 1),
		transformsApplied: data?.transforms_applied ?? data?.transformsApplied ?? [],
		transformsSummary: data?.transforms_summary ?? data?.transformsSummary,
		ccrHashes: Array.isArray(ccrHashes) ? ccrHashes : [],
		compressed: saved > 0,
	};
}

async function compressOpenAiMessages(messages, model, tokenBudget, timeoutMs, state, { skipProject = false, targeted = false } = {}) {
	// `targeted` = an explicit single-tool-output compress (tool_result hook,
	// COMPRESS_TOOL, Anthropic FRAGMENT, Responses): protect_recent 0 so the tool
	// content itself is eligible, protect_analysis_context off (explicit request,
	// not passive review). Full-context (before_provider_request) keeps the
	// defaults (protect_recent 2, analysis on) and compresses user messages.
	const body = {
		messages,
		model,
		config: {
			compress_user_messages: true,
			protect_recent: targeted ? 0 : 2,
			protect_analysis_context: !targeted,
		},
	};
	if (Number.isInteger(tokenBudget) && tokenBudget > 0) body.token_budget = tokenBudget;
	// Per-project routing: /p/<sessionId>/v1/compress lets the proxy track
	// stats per OMP session so multi-instance widgets don't mix data.
	const project = !skipProject && state?.sessionId ? `/p/${state.sessionId}` : "";
	const response = await fetch(proxyPath(`${project}/v1/compress`), {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Client": "omp" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { error: text };
	}
	if (!response.ok) {
		const message = data?.error?.message ?? data?.error ?? text ?? response.statusText;
		throw new Error(`Headroom proxy compression failed (${response.status}): ${message}`);
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
	let rest = compressedMessages;
	if (hadSystem && isRecord(rest[0]) && rest[0].role === "system") {
		return { ...payload, system: rest[0].content, messages: rest.slice(1) };
	}
	return { ...payload, messages: rest };
}

function responseOutputText(item) {
	if (!isRecord(item)) return undefined;
	if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.output === "string") {
		return item.output;
	}
	return undefined;
}

function anthropicToolResultText(block) {
	if (!isRecord(block) || block.type !== "tool_result") return undefined;
	if (typeof block.content === "string") return block.content;
	if (!Array.isArray(block.content)) return undefined;
	const textBlocks = getTextBlocks(block.content);
	if (textBlocks.length !== block.content.length) return undefined;
	return textBlocks.map(item => item.text).join("\n");
}

// Anthropic rejects messages containing empty text content blocks with
// "messages: text content blocks must be non-empty". OMP's stored assistant
// history can carry [text, "", tool_use] shapes (an empty placeholder block
// between real text and tool_use). Strip those empty text blocks defensively
// before the payload reaches the provider. Safe: an empty text block carries
// no information. Never empties a message — if filtering would remove every
// block, the original message is kept untouched.
function stripEmptyAnthropicTextBlocks(payload) {
	const messages = Array.isArray(payload.messages) ? payload.messages : null;
	if (!messages) return payload;
	let changed = false;
	const nextMessages = messages.map(message => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message;
		const filtered = message.content.filter(
			block => !(isRecord(block) && block.type === "text" && (typeof block.text !== "string" || block.text.trim() === "")),
		);
		if (filtered.length === 0 || filtered.length === message.content.length) return message;
		changed = true;
		return { ...message, content: filtered };
	});
	return changed ? { ...payload, messages: nextMessages } : payload;
}
// Convert Anthropic payload to plain OpenAI text for holistic compression.
function anthropicToOpenAiMessages(payload) {
	const msgs = [];
	if (typeof payload.system === "string") msgs.push({ role: "system", content: payload.system });
	else if (Array.isArray(payload.system)) {
		const t = payload.system.filter(b => isRecord(b) && b.type === "text").map(b => b.text).join("\n");
		if (t) msgs.push({ role: "system", content: t });
	}
	for (const m of payload.messages || []) {
		if (!isRecord(m) || !Array.isArray(m.content)) { msgs.push(m); continue; }
		const parts = [];
		for (const b of m.content) {
			if (!isRecord(b)) continue;
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			else if (b.type === "tool_use") { /* preserved structurally by openAiMessagesToAnthropic; never stringify — leaks "[tool_use id=… name=…]" as visible text */ }
			else if (b.type === "tool_result") {
				const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? getTextBlocks(b.content).map(x => x.text).join("\n") : "";
				parts.push(`[tool_result id=${b.tool_use_id}] ${t}`);
			}
		}
		msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: parts.join("\n\n") });
	}
	return msgs;
}

function openAiMessagesToAnthropic(payload, compressed, hadSystem) {
	const orig = Array.isArray(payload.messages) ? payload.messages : [];
	let cursor = hadSystem ? 1 : 0;
	const next = [];
	for (const o of orig) {
		const c = compressed[cursor++];
		if (!isRecord(c) || typeof c.content !== "string") { next.push(o); continue; }
		if (!isRecord(o) || !Array.isArray(o.content)) { next.push({ ...o, content: c.content }); continue; }
		const texts = o.content.filter(b => isRecord(b) && b.type === "text");
		if (texts.length === 0) { next.push(o); continue; }
		const nc = [];
		let ti = 0;
		for (const b of o.content) {
			if (isRecord(b) && b.type === "text" && typeof b.text === "string") {
				nc.push(ti === 0 ? { ...b, text: c.content } : { ...b, text: "" });
				ti++;
			} else nc.push(b);
		}
		next.push({ ...o, content: nc });
	}
	return { ...payload, messages: next };
}

async function compressAnthropicPayload(payload, ctx, state) {
	payload = stripEmptyAnthropicTextBlocks(payload);
	if (ANTHROPIC_PROVIDER_MODE === "off") return payload;
	// Budget the whole Anthropic compression (holistic + fragment fallback) so the
	// before_provider_request handler stays well under the harness 30s limit even
	// when the proxy is slow (seen 85s outliers under memory pressure).
	const startMs = Date.now();
	const ANTHROPIC_BUDGET_MS = 18_000;

	// FULL mode: holistic — convert entire payload to text, compress, map back.
	if (ANTHROPIC_PROVIDER_MODE === "full") {
		const msgs = Array.isArray(payload.messages) ? payload.messages : [];
		if (msgs.length > 0) {
			const hadSystem = typeof payload.system === "string" || Array.isArray(payload.system);
			const oa = anthropicToOpenAiMessages(payload);
			if (oa.length > 0) {
				try {
					const result = await compressOpenAiMessages(oa, normalizeModel(payload, ctx), contextWindow(ctx), PROVIDER_TIMEOUT_MS, state);
					if (result?.compressed && asNumber(result.tokensSaved) > 0) {
						recordCompression(state, "provider", result, ctx);
						countNewCcr(oa, result, state, ctx);
						return withRetrieveTool(stripEmptyAnthropicTextBlocks(openAiMessagesToAnthropic(payload, result.messages, hadSystem)), "anthropic");
					}
				} catch { /* fall through to fragment mode */ }
			}
		}
	}

	// FRAGMENT mode: compress individual tool_result blocks.
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const minToolChars = adaptiveMinChars(ANTHROPIC_MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
	let changed = false;
	const nextMessages = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
			nextMessages.push(message); continue;
		}
		let contentChanged = false;
		const nextContent = [];
		for (const block of message.content) {
			const output = anthropicToolResultText(block);
			if (output === undefined || output.length < minToolChars || output.includes(COMPRESSED_MARKER) || output.includes(RETRIEVED_MARKER)) {
				nextContent.push(block); continue;
			}
			const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "hr_ar";
			const synthetic = [
				{ role: "user", content: "Compress Anthropic tool_result content for token-efficient reasoning." },
				{ role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "ar", arguments: "{}" } }] },
				{ role: "tool", content: output, tool_call_id: callId },
			];
			if (Date.now() - startMs > ANTHROPIC_BUDGET_MS) { nextContent.push(block); continue; }
			const result = await compressOpenAiMessages(synthetic, normalizeModel(payload, ctx), undefined, PROVIDER_TIMEOUT_MS, state, { targeted: true });
			const compressed = result?.messages?.at?.(-1)?.content;
			if (typeof compressed === "string" && compressed.length < output.length) {
				nextContent.push({ ...block, content: compressed });
				recordCompression(state, "provider", result, ctx);
				void persistCcrOriginal(result, output, compressed, state, ctx);
				contentChanged = true; changed = true; continue;
			}
			nextContent.push(block);
		}
		nextMessages.push(contentChanged ? { ...message, content: nextContent } : message);
	}
	return changed ? withRetrieveTool({ ...payload, messages: nextMessages }, "anthropic") : payload;
}

export async function compressResponsesPayload(payload, ctx, state, { providerReady = true } = {}) {
	const session = createResponsesSessionCompaction(Array.isArray(payload?.input) ? payload.input : []);
	if (session.compacted) await persistSessionArchive(session, state, ctx);
	recordSessionCompactionAttempt(state, session);
	const payloadWithTool = withRetrieveTool(session.compacted ? { ...payload, input: session.input } : payload);
	const input = Array.isArray(payloadWithTool.input) ? payloadWithTool.input : [];
	let changed = session.compacted;
	if (!providerReady) return payloadWithTool;
	// Compress oversized outputs concurrently but bounded (default 3 workers,
	// OMP_HEADROOM_RESPONSES_CONCURRENCY overrides): a request replaying many
	// big tool outputs must not stampede the local proxy. Order is preserved by
	// index; state mutations (counters, CCR persistence) are applied after the
	// wave, in input order, so completion order never skews the stats.
	let failures = 0;
	const minToolChars = adaptiveMinChars(MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx));
	const compressItem = async item => {
		const output = responseOutputText(item);
		if (output === undefined || output.length < minToolChars || output.includes(COMPRESSED_MARKER) || output.includes(RETRIEVED_MARKER)) {
			return { item };
		}
		const callId = typeof item.call_id === "string" ? item.call_id : "headroom_response_output";
		const messages = [
			{ role: "user", content: "Compress OpenAI Responses tool output for token-efficient reasoning." },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: callId, type: "function", function: { name: "response_tool", arguments: "{}" } }],
			},
			{ role: "tool", content: output, tool_call_id: callId },
		];
		try {
			const result = await compressOpenAiMessages(messages, normalizeModel(payloadWithTool, ctx), undefined, PROVIDER_TIMEOUT_MS, state, { targeted: true });
			const compressed = result?.messages?.at?.(-1)?.content;
			if (typeof compressed === "string" && compressed.length < output.length) {
				return { item: { ...item, output: compressed }, result, output, compressed };
			}
		} catch {
			// A failed item keeps its original output; other items still compress.
			failures += 1;
		}
		return { item };
	};
	const settled = new Array(input.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(RESPONSES_COMPRESS_CONCURRENCY, Math.max(1, input.length)) }, async () => {
			while (cursor < input.length) {
				const index = cursor++;
				settled[index] = await compressItem(input[index]);
			}
		}),
	);
	if (state) state.lastError = failures > 0 ? `responses compress: ${failures} item(s) failed` : "";
	const nextInput = [];
	for (const entry of settled) {
		nextInput.push(entry.item);
		if (!entry.result) continue;
		recordCompression(state, "provider", entry.result, ctx);
		void persistCcrOriginal(entry.result, entry.output, entry.compressed, state, ctx);
		changed = true;
	}
	return changed ? { ...payloadWithTool, input: nextInput } : payloadWithTool;
}

function recordCompression(state, kind, result, ctx) {
	const saved = Math.max(0, asNumber(result?.tokensSaved));
	if (saved <= 0) return;
	// hasUI=false → subagent or pre-initialize main. Use MODULE-LEVEL counters
	// (not state.foreignSelf*) because the factory creates a separate state per
	// call, but Bun caches the module — so _sharedForeign* is visible to both
	// the main's compactStatsLine and the subagent's recordCompression.
	if (ctx && !isMainSession(ctx)) {
		if (kind === "provider") _sharedForeignProvider += 1;
		if (kind === "tool") _sharedForeignTool += 1;
		return;
	}
	state.tokensSaved += saved;
	state.tokensBefore += Math.max(0, asNumber(result?.tokensBefore));
	state.tokensAfter += Math.max(0, asNumber(result?.tokensAfter));
	if (kind === "provider") state.providerCompressions += 1;
	if (kind === "tool") state.toolCompressions += 1;
}

// Cold-start mitigation: the first /v1/compress after proxy start pays a ~6s
// penalty loading the local sentence-transformer (hybrid relevance tier);
// warm calls are ~20ms. Without this, a large first request can exceed the
// before_provider_request timeout and skip compression (counters stay 0).
// Fire one tiny throwaway compress at session start so the model is resident
// before the first real request. Best-effort; never throws; bypasses per-project
// routing (skipProject) so it warms the model without polluting the session bucket.
let prewarmed = false;
async function prewarmCompression(state) {
	if (prewarmed || !state.proxyReady) return;
	prewarmed = true;
	try {
		const filler = "warmup ".repeat(Math.ceil((MIN_TOOL_TEXT_CHARS + 100) / 7));
		const messages = [
			{ role: "user", content: "warmup" },
			{ role: "assistant", content: null, tool_calls: [{ id: "warm", type: "function", function: { name: "warm", arguments: "{}" } }] },
			{ role: "tool", content: filler, tool_call_id: "warm" },
		];
		await compressOpenAiMessages(messages, "gpt-4o-mini", undefined, 30_000, state, { skipProject: true });
	} catch {
		prewarmed = false; // allow a retry on the next session_start
	}
}

function renderWidget(ctx, state) {
	if (!ctx?.hasUI) return;
	const ready = state.enabled && state.proxyReady;
	// Rainbow + dashboard link IS the "ready" cue; when not ready the title
	// goes gray and the problem (truncated) rides next to it in the border.
	const titleStyled = ready ? link(DASHBOARD_URL, rainbow("Headroom", state.rainbowPhase)) : color(90, "Headroom");
	let problem = "";
	if (!state.enabled) problem = "off";
	else if (state.installState) problem = `${state.installState}…`;
	else if (state.proxyStarting) problem = "starting…";
	else if (!state.proxyReady) problem = clip(state.lastError || "offline", 28);
	const topLeftRaw = `─ Headroom ${problem ? `· ${problem} ` : ""}`;
	const topLeftStyled = `─ ${titleStyled} ${problem ? `${color(state.enabled ? 33 : 90, `· ${problem}`)} ` : ""}`;
	// Session short id, right-aligned in the top border.
	const sid = String(state.sessionId || "").slice(0, 8);
	let topRightRaw = sid ? ` ${sid} ─` : "";
	let topRightStyled = sid ? ` ${color(90, sid)} ─` : "";
	// Bottom border: session savings · lifetime savings (left), session input cost (right).
	const ps = sessionProxyStats(state);
	const sessionUsd = asNumber(ps?.compression_savings_usd);
	const lifeUsd = proxyLifetimeUsd(state);
	const ctxUsd = asNumber(ps?.total_input_cost_usd);
	const botLeftRaw = `─ ${formatUsd(sessionUsd)} · ${formatUsd(lifeUsd)} `;
	const botLeftStyled = `─ ${color(32, formatUsd(sessionUsd))}${color(90, ` · ${formatUsd(lifeUsd)}`)} `;
	let botRightRaw = ctxUsd > 0 ? ` ctx ${formatUsd(ctxUsd)} ─` : "";
	let botRightStyled = ctxUsd > 0 ? ` ${color(90, `ctx ${formatUsd(ctxUsd)}`)} ─` : "";
	const ctxLine = ` ${localCompressionLine(state)}`;
	const activityLine = ` ${compactStatsLine(state)}`;
	const archiveLine = archiveAttemptLine(state);
	const updateLine = state.installState
		? ` headroom ${state.installState}…`
		: isNewer(state.latest, state.version)
			? ` v${state.version} → v${state.latest}`
			: "";
	const inner = computeInner(
		Math.max(
			topLeftRaw.length + topRightRaw.length + 1,
			botLeftRaw.length + botRightRaw.length + 1,
			ctxLine.length,
			activityLine.length,
			archiveLine.length,
			updateLine.length,
		) + 1,
	);
	// Narrow caps: the right border segments are decoration — drop them before
	// letting a border row overflow the box width.
	if (topLeftRaw.length + topRightRaw.length + 1 > inner) { topRightRaw = ""; topRightStyled = ""; }
	if (botLeftRaw.length + botRightRaw.length + 1 > inner) { botRightRaw = ""; botRightStyled = ""; }
	const rows = [row(ctxLine, inner), row(activityLine, inner)];
	if (archiveLine) rows.push(row(archiveLine, inner));
	if (updateLine) rows.push(row(updateLine, inner));
	const lines = [
		borderLine(inner, "╭", "╮", topLeftRaw, topLeftStyled, topRightRaw, topRightStyled),
		...rows,
		borderLine(inner, "╰", "╯", botLeftRaw, botLeftStyled, botRightRaw, botRightStyled),
	];
	ctx.ui.setWidget(EXTENSION_KEY, lines, { placement: WIDGET_PLACEMENT, priority: WIDGET_PRIORITY });
	ctx.ui.setStatus(EXTENSION_KEY, undefined);
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
	if (!force && state.statsFetchedAt && now - state.statsFetchedAt < STATS_MIN_INTERVAL_MS) return state.stats;
	if (state.statsInFlight) return state.statsInFlight;
	const inFlight = (async () => {
		try {
		// Per-project: read from /p/<sessionId>/stats so each OMP instance has its
		// own stats bucket. Fall back to global /stats for lifetime totals.
		const project = state.sessionId ? `/p/${state.sessionId}` : "";
		const response = await fetch(proxyPath(`${project}/stats`), { method: "GET", signal: AbortSignal.timeout(3000) });
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
			void systemdCtl("start").then(result => {
				if (result.code !== 0) {
					state.proxyStarting = false;
					state.lastError = `systemctl start failed: ${clip(result.err.trim(), 200)}`;
				}
			});
			ctx?.ui?.notify?.(`Starting Headroom proxy via ${SYSTEMD_UNIT}…`, "info");
		} else {
			const proxyEnv = { ...process.env, HEADROOM_TELEMETRY: "off" };
			if (CODE_AWARE) proxyEnv.HEADROOM_CODE_AWARE_ENABLED ??= "1";
			proxyEnv.HEADROOM_NO_SUBSCRIPTION_TRACKING ??= "1";
			proxyEnv.HEADROOM_PROXY_EXTENSIONS ??= "omp_stats";
			state.proxyProcess = spawn(
				HEADROOM_BIN,
				["proxy", "--host", "127.0.0.1", "--port", String(proxyPort()), "--no-telemetry", ...PROXY_EXTRA_ARGS],
				{ env: proxyEnv, stdio: "ignore" },
			);
			state.proxyProcess.unref();
			state.proxyProcess.once("error", error => {
				state.lastError = String(error?.message || error);
				state.proxyStarting = false;
				state.proxyProcess = undefined;
			});
			state.proxyProcess.once("exit", code => {
				state.proxyStarting = false;
				state.proxyProcess = undefined;
				if (code !== null && code !== 0) state.lastError = `Headroom proxy exited with code ${code}`;
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

async function retrieveViaProxy(hash, query, signal) {
	const response = await fetch(proxyPath("/v1/retrieve"), {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Client": "omp" },
		body: JSON.stringify(query ? { hash, query } : { hash }),
		signal: signal ?? AbortSignal.timeout(TOOL_TIMEOUT_MS),
	});
	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}
	if (!response.ok) return { error: data?.error || `HTTP ${response.status}`, hash };
	return data;
}

function stringifyRetrieveResult(data, hash, fallback = false) {
	let body;
	if (!isRecord(data)) body = String(data);
	else if (typeof data.original_content === "string") body = data.original_content;
	else if (Array.isArray(data.results)) body = JSON.stringify(data.results, null, 2);
	else body = JSON.stringify(data, null, 2);
	const note = fallback ? "; local fallback (full original)" : "";
	return `${RETRIEVED_MARKER}hash=${hash || "?"}${note}; original content — do not re-compress]\n${body}`;
}

function commandSummary(state) {
	const stats = state.stats;
	const comp = stats?.summary?.compression;
	const summaryCost = stats?.summary?.cost;
	// Session figures: prefer the proxy per-session stats (accurate, matches the
	// widget + dashboard). tool/ccr have no proxy equivalent (extension-internal),
	// so they stay in-memory and reset per process.
	const ps = sessionProxyStats(state);
	const saved = (ps && asNumber(ps.tokens_saved) > 0) ? asNumber(ps.tokens_saved) : Math.max(0, asNumber(state.tokensSaved));
	const pct = (ps && asNumber(ps.savings_percent ?? ps.compression_pct) > 0) ? asNumber(ps.savings_percent ?? ps.compression_pct) : (state.tokensBefore > 0 ? (state.tokensSaved / state.tokensBefore) * 100 : 0);
	// Lifetime proxy totals, shown separately and clearly labelled (not session).
	const lifeSaved = asNumber(
		stats?.tokens?.saved ?? comp?.totalTokensRemoved ?? comp?.total_tokens_removed ?? comp?.total_tokens_saved_with_cli_filtering ?? 0,
	);
	const lifeCost = stats?.cost?.savingsUsd ?? summaryCost?.totalSavedUsd ?? summaryCost?.total_saved_usd;
	const lines = [
		`Headroom: ${state.enabled ? "enabled" : "disabled"}`,
		`Proxy: ${state.proxyReady ? "ready" : state.proxyStarting ? "starting" : "offline"} (${PROXY_URL})`,
		`Version: ${state.version || "unknown"}${isNewer(state.latest, state.version) ? ` (latest ${state.latest} available)` : ""}`,
		`Session (proxy): saved ${formatInt(saved)}${pct ? ` (${formatPct(pct)})` : ""} · req ${formatInt((ps && asNumber(ps.requests) > 0) ? asNumber(ps.requests) : state.providerCompressions)}`,
		`This process: provider=${formatInt(state.providerCompressions)}, tool=${formatInt(state.toolCompressions)}, ccr=${formatInt(state.ccrHashes)}, archive=${formatInt(state.sessionArchiveCompactions)} (${formatInt(state.sessionArchiveCharsSaved)}ch saved)`,
		`Archive: ${state.lastSessionArchive?.reason || "none"} · compactions=${formatInt(state.sessionArchiveCompactions)} · saved=${formatInt(state.sessionArchiveCharsSaved)}ch · prefix=${formatInt(state.lastSessionArchive?.prefixChars || 0)}ch${state.lastSessionArchive?.prefixShare ? `/${formatPct(state.lastSessionArchive.prefixShare * 100)}` : ""}`,
		`Proxy lifetime (all sessions): ${formatInt(lifeSaved)} tok${asNumber(lifeCost) > 0 ? ` · ${formatUsd(lifeCost)}` : ""}`,
	];
	if (stats?.summary?.mcp) {
		lines.push(
			`Headroom MCP: compressions=${formatInt(stats.summary.mcp.compressions)}, retrievals=${formatInt(stats.summary.mcp.retrievals)}, removed=${formatInt(stats.summary.mcp.tokensRemoved)} tok`,
		);
	}
	if (state.lastError) lines.push(`Last error: ${state.lastError}`);
	return lines.join("\n");
}

export default function headroomExtension(pi) {
	// pi.zod IS the zod module object (loader sets `readonly zod = z`), so
	// `pi.zod.object` exists directly. Older shims exposed it as `{ z }`. Accept
	// either, and never throw at registration when it is absent.
	const z = pi.zod?.object ? pi.zod : pi.zod?.z;
	pi.setLabel?.("Headroom");
	let latestCtx;
	let rainbowTimer;
	let widgetOnScreen = true; // updated by widget_layout event

	function startRainbowTimer() {
		if (rainbowTimer) return;
		rainbowTimer = setInterval(() => {
			if (!latestCtx || !state.enabled || !widgetOnScreen) return;
			const isMainUi = isMainSession(latestCtx);
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
				if (t.provider !== state.foreignProvider || t.tool !== state.foreignTool || t.ccr !== state.foreignCcr) {
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
				void fetchStats(state).then(() => { try { renderWidget(latestCtx, state); } catch {} });
			}
			if (dirty) renderWidget(latestCtx, state);
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



	const state = {
		enabled: process.env.OMP_HEADROOM_DISABLED !== "1",
		toolCompression: process.env.OMP_HEADROOM_TOOL_RESULTS !== "0",
		proxyReady: false,
		proxyStarting: false,
		proxyProcess: undefined,
		proxyCheckedAt: 0,
		statsFetchedAt: 0,
		statsInFlight: undefined,
		stats: undefined,
		lastError: "",
		installState: "",
		version: "",
		latest: "",
		providerCompressions: 0,
		toolCompressions: 0,
		ccrHashes: 0,
		tokensSaved: 0,
		tokensBefore: 0,
		tokensAfter: 0,
		sessionArchiveCompactions: 0,
		sessionArchiveCharsBefore: 0,
		sessionArchiveCharsAfter: 0,
		sessionArchiveCharsSaved: 0,
		lastSessionArchive: undefined,
		rainbowPhase: 0,
		// Aggregated subagent totals the main UI session displays as (+N).
		foreignProvider: 0,
		foreignTool: 0,
		foreignCcr: 0,
		foreignReadAt: 0,
		// This instance's own subagent totals (written to its foreign file).
		foreignSelfProvider: 0,
		foreignSelfTool: 0,
		foreignSelfCcr: 0,
		// Set once the main UI session has captured latestCtx + cleared foreign files.
		foreignCleared: false,
		// OMP session ID for per-project proxy routing (/p/<sessionId>/...).
		sessionId: "",
	};

	// Capture the main UI session's render target + clear foreign files exactly once.
	// session_start may fire BEFORE OMP wires the UI (hasUI=false then), so we also
	// call this from the active hooks, where the main session's ctx has hasUI=true.
	function ensureMainCaptured(ctx) {
		if (!isMainSession(ctx)) return;
		latestCtx = ctx;
		if (!_sharedForeignCleared) {
			_sharedForeignCleared = true;
			// Retroactive: pre-initialize compressions incremented the shared
			// foreign counters. Move them back to THIS state's main counters.
			state.providerCompressions += _sharedForeignProvider;
			state.toolCompressions += _sharedForeignTool;
			state.ccrHashes += _sharedForeignCcr;
			_sharedForeignProvider = 0;
			_sharedForeignTool = 0;
			_sharedForeignCcr = 0;
		}
	}

	pi.registerFlag("headroom", { description: "Enable Headroom token compression", type: "boolean", default: true });
	pi.registerFlag("headroom-tool-results", {
		description: "Compress large tool results with Headroom",
		type: "boolean",
		default: true,
	});

	pi.on("session_start", async (_event, ctx) => {
		// Capture the OMP session ID for per-project proxy routing. Each session
		// gets its own stats bucket at /p/<sessionId>/stats so multi-instance
		// OMP sessions don't pollute each other's widget data.
		const sid = ctx?.sessionManager?.getSessionId?.();
		if (typeof sid === "string" && sid) state.sessionId = sid;
		// CRITICAL: only the main UI session (hasUI===true) may capture latestCtx.
		if (isMainSession(ctx)) {
			latestCtx = ctx;
		} else if (typeof sid === "string" && sid) {
			// Subagent/advisor session — record its ID so the main can read its
			// proxy per_project bucket and render it as (+N).
			_subagentSessionIds.add(sid);
		}
		// ensureMainCaptured(ctx), called from before_provider_request and
		// tool_result. We do NOT set foreignCleared here — doing so would skip
		// the retroactive conversion of pre-initialize compressions.
		state.enabled = pi.getFlag?.("headroom") !== false && process.env.OMP_HEADROOM_DISABLED !== "1";
		state.toolCompression = pi.getFlag?.("headroom-tool-results") !== false && process.env.OMP_HEADROOM_TOOL_RESULTS !== "0";
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
			void cleanupCcrFallback();
			void prewarmCompression(state); // load the embedding model now, off the critical path
		})();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopRainbowTimer();
		// The proxy is a shared daemon (systemd unit or adopted orphan) serving
		// other agent sessions — never tear it down on session exit.
		ctx?.ui?.setWidget?.(EXTENSION_KEY, undefined, { placement: WIDGET_PLACEMENT });
		ctx?.ui?.setStatus?.(EXTENSION_KEY, undefined);
	});
	pi.on("widget_layout", (e) => {
		if (e.key !== EXTENSION_KEY) return;
		widgetOnScreen = e.visible;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!state.enabled) return;
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
		if (!isRecord(payload) || (!Array.isArray(payload.messages) && !Array.isArray(payload.input))) return;

		// DEBUG: ground-truth what the hook sees, to diagnose req=0. Toggle with
		// OMP_HEADROOM_DEBUG=1. Writes one JSON line per request to debug.log.
		if (process.env.OMP_HEADROOM_DEBUG === "1") {
			try {
				const shape = Array.isArray(payload.input) ? "responses(input)" : "messages";
				const prov = (() => { try { return effectiveProviderFormat(payload, ctx); } catch { return "?"; } })();
				let detail = {};
				if (Array.isArray(payload.input)) {
					const types = {};
					let big = 0;
					for (const it of payload.input) {
						const t = isRecord(it) ? String(it.type) : typeof it;
						types[t] = (types[t] || 0) + 1;
						const o = responseOutputText(it);
						if (typeof o === "string" && o.length >= MIN_TOOL_TEXT_CHARS) big++;
					}
					detail = { items: payload.input.length, types, itemsOverThreshold: big, threshold: MIN_TOOL_TEXT_CHARS };
				} else if (Array.isArray(payload.messages)) {
					detail = { messages: payload.messages.length, model: payload.model || ctx?.model?.id };
				}
				appendFileSync(join(homedir(), ".headroom-debug.log"),
					JSON.stringify({ ts: new Date().toISOString(), shape, prov, ready: state.proxyReady, ...detail }) + "\n");
			} catch { /* never break the hook on debug */ }
		}

		try {
			if (Array.isArray(payload.input)) {
				const ready = await ensureProxy(ctx, state, 1_000);
				const nextPayload = await compressResponsesPayload(payload, ctx, state, { providerReady: ready });
				if (ready) refreshStatsAndRender(ctx, state);
				else renderWidget(ctx, state);
				return nextPayload;
			}

			const provider = effectiveProviderFormat(payload, ctx);
			if (provider === "anthropic") {
				const session = await applyAnthropicSessionCompaction(payload, state, ctx);
				const workingPayload = session.payload;
				if (!providerPayloadHasCompressionCandidate(workingPayload)) {
					state.lastError = "";
					renderWidget(ctx, state);
					if (session.compacted || payloadHasCompressedMarker(workingPayload)) return withRetrieveTool(workingPayload, "anthropic");
					return;
				}
				const ready = await ensureProxy(ctx, state, 1_000);
				if (!ready) return session.compacted ? withRetrieveTool(workingPayload, "anthropic") : undefined;
				const nextPayload = await compressAnthropicPayload(workingPayload, ctx, state);
				state.lastError = "";
				refreshStatsAndRender(ctx, state);
				return nextPayload;
			}

			const session = await applyOpenAiSessionCompaction(payload, state, ctx);
			const payloadWithTool = session.payload;
			if (!providerPayloadHasCompressionCandidate(payloadWithTool)) {
				state.lastError = "";
				renderWidget(ctx, state);
				if (session.compacted || payloadHasCompressedMarker(payloadWithTool)) return payloadWithTool;
				return;
			}
			const ready = await ensureProxy(ctx, state, 1_000);
			if (!ready) return session.compacted ? payloadWithTool : undefined;
			const result = await compressOpenAiMessages(session.messages, normalizeModel(payloadWithTool, ctx), contextWindow(ctx), PROVIDER_TIMEOUT_MS, state);
			recordCompression(state, "provider", result, ctx);
			countNewCcr(session.messages, result, state, ctx);
			state.lastError = "";
			refreshStatsAndRender(ctx, state);
			if (!result?.compressed || asNumber(result.tokensSaved) <= 0) return payloadWithTool;
			return fromOpenAiPayloadMessages(payloadWithTool, result.messages, session.hadSystem);
		} catch (error) {
			state.lastError = String(error?.message || error);
			pi.logger?.warn?.(`headroom before_provider_request failed: ${state.lastError}`);
			renderWidget(ctx, state);
			return;
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!state.enabled || !state.toolCompression || event.isError) return;
		ensureMainCaptured(ctx);
		if ([RETRIEVE_TOOL, COMPRESS_TOOL, STATS_TOOL].includes(event.toolName)) return;
		if (SKIP_TOOLS.has(String(event.toolName || "").toLowerCase())) return;
		const blocks = getTextBlocks(event.content);
		if (blocks.length === 0 || blocks.length !== event.content.length) return;
		if (textContentLength(event.content) < adaptiveMinChars(MIN_TOOL_TEXT_CHARS, contextUsageRatio(ctx))) return;
		if (blocks.some(block => block.text.includes(COMPRESSED_MARKER) || block.text.includes(RETRIEVED_MARKER))) return;

		const ready = await ensureProxy(ctx, state, 2_000);
		if (!ready) return;

		try {
			const rawText = blocks.map(block => block.text).join("\n");
			const callId = `headroom_${event.toolCallId || "tool"}`;
			// Prefix the tool name so headroom's DEFAULT_EXCLUDE_TOOLS (built for
			// Claude Code's Read/Bash/Grep edit workflow) does not veto compression:
			// OMP uses hashline edits, keeps canonical history itself, and we persist
			// originals to the local CCR fallback store. SKIP_TOOLS above is the
			// OMP-specific safety list.
			const routedName = `omp_${event.toolName}`;
			const messages = [
				{ role: "user", content: `Compress ${routedName} tool result for token-efficient reasoning.` },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: callId, type: "function", function: { name: routedName, arguments: JSON.stringify(event.input || {}) } },
					],
				},
				{ role: "tool", content: rawText, tool_call_id: callId },
			];
		const result = await compressOpenAiMessages(messages, normalizeModel(undefined, ctx), undefined, TOOL_TIMEOUT_MS, state, { targeted: true });
			const compressed = result?.messages?.at?.(-1)?.content;
			if (typeof compressed !== "string" || compressed.length >= rawText.length) return;
			recordCompression(state, "tool", result, ctx);
			void persistCcrOriginal(result, rawText, compressed, state, ctx);
			state.lastError = "";
			refreshStatsAndRender(ctx, state);
			return { content: [{ type: "text", text: compressed }] };
		} catch (error) {
			state.lastError = String(error?.message || error);
			pi.logger?.warn?.(`headroom tool_result failed: ${state.lastError}`);
			renderWidget(ctx, state);
			return;
		}
	});

	// Tool registration needs zod for parameter schemas. If zod is unavailable
	// (older host), skip the tools but never let it abort the whole extension —
	// the widget + compression hooks must still load.
	if (z) {
	pi.registerTool({
		name: RETRIEVE_TOOL,
		label: "Headroom Retrieve",
		description: RETRIEVE_DESCRIPTION,
		parameters: z.object({
			hash: z.string().describe("Hash key from a Headroom compression marker."),
			query: z.string().optional().describe("Optional search query to filter original content."),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureProxy(ctx, state, 5_000);
			let data;
			try {
				data = await retrieveViaProxy(params.hash, params.query, signal);
			} catch (error) {
				data = { error: String(error?.message || error), hash: params.hash };
			}
			let fallback = false;
			if (data.error) {
				const original = await readCcrFallback(params.hash);
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

	pi.registerTool({
		name: COMPRESS_TOOL,
		label: "Headroom Compress",
		description:
			"Compress large content to save context window space. The original is stored by Headroom and can be retrieved later with headroom_retrieve when a hash is present.",
		parameters: z.object({ content: z.string().describe("Text, JSON, logs, code, or search results to compress.") }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureProxy(ctx, state, 10_000);
			const callId = "headroom_manual_compress";
			const messages = [
				{ role: "user", content: "Compress this content for token-efficient reasoning." },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: callId, type: "function", function: { name: COMPRESS_TOOL, arguments: "{}" } }],
				},
				{ role: "tool", content: params.content, tool_call_id: callId },
			];
		const result = await compressOpenAiMessages(messages, normalizeModel(undefined, ctx), contextWindow(ctx), TOOL_TIMEOUT_MS, state, { targeted: true });
			const compressed = result?.messages?.at?.(-1)?.content || params.content;
			recordCompression(state, "tool", result, ctx);
			void persistCcrOriginal(result, params.content, compressed, state, ctx);
			state.lastError = "";
			refreshStatsAndRender(ctx, state);
			return {
				content: [{ type: "text", text: compressed }],
				details: {
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
					tokensSaved: result.tokensSaved,
					ccrHashes: result.ccrHashes,
				},
			};
		},
	});

	pi.registerTool({
		name: STATS_TOOL,
		label: "Headroom Stats",
		description: "Show Headroom compression statistics for this OMP session and proxy.",
		parameters: z.object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await ensureProxy(ctx, state, 3_000);
			await fetchStats(state, true);
			renderWidget(ctx, state);
			return { content: [{ type: "text", text: commandSummary(state) }], details: state.stats || {} };
		},
	});
	}

	pi.registerCommand("headroom", {
		description: "Manage Headroom token compression: stats, on, off, start, stop, restart, update",
		handler: async (args, ctx) => {
			const action = String(args || "stats").trim().split(/\s+/, 1)[0]?.toLowerCase() || "stats";
			if (action === "on") {
				state.enabled = true;
				await ensureProxy(ctx, state, 25_000);
				ctx.ui.notify("Headroom enabled.", "info");
			} else if (action === "off") {
				state.enabled = false;
				ctx.ui.notify("Headroom compression disabled for this OMP session.", "info");
			} else if (action === "start") {
				await ensureProxy(ctx, state, 25_000);
				ctx.ui.notify(state.proxyReady ? "Headroom proxy ready." : "Headroom proxy is still starting.", "info");
			} else if (action === "stop") {
				if (await systemdUnitAvailable()) await systemdCtl("stop");
				if (state.proxyProcess) state.proxyProcess.kill("SIGTERM");
				state.proxyProcess = undefined;
				state.proxyReady = false;
				state.proxyStarting = false;
				ctx.ui.notify("Headroom proxy stopped.", "info");
			} else if (action === "restart") {
				await restartProxy(ctx, state);
				ctx.ui.notify(state.proxyReady ? "Headroom proxy restarted." : "Headroom proxy is still starting.", "info");
			} else if (action === "update") {
				state.lastError = "";
				await maintainInstall(ctx, state, true);
				if (state.lastError) {
					ctx.ui.notify(`Headroom update failed: ${state.lastError}`, "error");
				} else {
					const upToDate = state.version && !isNewer(state.latest, state.version);
					ctx.ui.notify(`Headroom ${state.version || "?"}${upToDate ? " (up to date)" : ""}`, "info");
				}
			} else {
				await ensureProxy(ctx, state, 3_000);
				await fetchStats(state, true);
				ctx.ui.notify(commandSummary(state), "info");
			}
			renderWidget(ctx, state);
		},
	});
}
