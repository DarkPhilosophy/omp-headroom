// Headroom extension configuration: constants, ~/.omp/agent/headroom.yml loading,
// and env-var overrides. Env vars (OMP_HEADROOM_*) always take priority over the
// YAML file; unknown keys are ignored; a malformed file falls back to env-only.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_KEY = "headroom";
export const RETRIEVE_TOOL = "headroom_retrieve";
export const COMPRESS_TOOL = "headroom_compress";
export const STATS_TOOL = "headroom_stats";

const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
export const HEADROOM_CONFIG_PATH = join(homedir(), ".omp", "agent", "headroom.yml");
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STATS_PLUGIN_DIR =
  process.env.OMP_HEADROOM_STATS_PLUGIN_DIR ?? join(PACKAGE_ROOT, "plugins", "headroom-omp-stats");
export const SYSTEMD_TEMPLATE_PATH = join(PACKAGE_ROOT, "systemd", "headroom-proxy.service.in");

export function loadHeadroomConfig(path = HEADROOM_CONFIG_PATH): Record<string, unknown> {
  try {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (!text.trim()) return {};
    const parsed = typeof Bun?.YAML?.parse === "function" ? Bun.YAML.parse(text) : {};
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export const _cfg = loadHeadroomConfig();

function cfgStr(yamlKey: string, envKey: string, def: string): string {
  if (process.env[envKey] !== undefined) return process.env[envKey] as string;
  if (yamlKey in _cfg) return String(_cfg[yamlKey]);
  return def;
}
function cfgNum(yamlKey: string, envKey: string, def: number): number {
  const v =
    process.env[envKey] !== undefined
      ? process.env[envKey]
      : yamlKey in _cfg
        ? _cfg[yamlKey]
        : undefined;
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function cfgBool(yamlKey: string, envKey: string, truthy: boolean): boolean {
  const v =
    process.env[envKey] !== undefined
      ? process.env[envKey]
      : yamlKey in _cfg
        ? _cfg[yamlKey]
        : undefined;
  if (v === undefined) return truthy;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["1", "true", "on", "yes"].includes(s)) return true;
  if (["0", "false", "off", "no"].includes(s)) return false;
  return truthy;
}
function cfgBoolOff(yamlKey: string, envKey: string): boolean {
  const v =
    process.env[envKey] !== undefined
      ? process.env[envKey]
      : yamlKey in _cfg
        ? _cfg[yamlKey]
        : undefined;
  if (v === undefined) return true;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["0", "false", "off", "no"].includes(s)) return false;
  return true;
}

const DEFAULT_HEADROOM_BIN = join(homedir(), ".omp", "agent", "headroom-venv", "bin", "headroom");
export const WIDGET_PLACEMENT = process.env.OMP_HEADROOM_WIDGET_PLACEMENT || "rightEditor";

export const PROXY_URL = (process.env.OMP_HEADROOM_URL || DEFAULT_PROXY_URL).replace(/\/+$/, "");
export const DASHBOARD_URL = `${PROXY_URL}/dashboard`;
export const HEADROOM_BIN = cfgStr("bin", "OMP_HEADROOM_BIN", DEFAULT_HEADROOM_BIN);
export const MIN_TOOL_TEXT_CHARS = cfgNum("min_tool_chars", "OMP_HEADROOM_MIN_TOOL_CHARS", 12_000);
export const ANTHROPIC_MIN_TOOL_TEXT_CHARS = cfgNum(
  "anthropic_min_tool_chars",
  "OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS",
  8_000,
);
export const PROVIDER_MIN_TEXT_CHARS = cfgNum(
  "min_provider_chars",
  "OMP_HEADROOM_MIN_PROVIDER_CHARS",
  1_000,
);
export const ADAPTIVE_THRESHOLDS = cfgBoolOff("adaptive", "OMP_HEADROOM_ADAPTIVE");
export const ADAPTIVE_START_RATIO = cfgNum("adaptive_start", "OMP_HEADROOM_ADAPTIVE_START", 0.5);
export const ADAPTIVE_FULL_RATIO = cfgNum("adaptive_full", "OMP_HEADROOM_ADAPTIVE_FULL", 0.9);
export const ADAPTIVE_FLOOR_RATIO = cfgNum("adaptive_floor", "OMP_HEADROOM_ADAPTIVE_FLOOR", 0.25);
export const DEBUG_SIZING = cfgBool("debug_sizing", "OMP_HEADROOM_DEBUG_SIZING", false);
export const SESSION_ARCHIVE_ENABLED = cfgBoolOff(
  "session_archive",
  "OMP_HEADROOM_SESSION_COMPACTION",
);
export const SESSION_LIVE_MESSAGES = cfgNum(
  "session_live_messages",
  "OMP_HEADROOM_LIVE_MESSAGES",
  24,
);
export const SESSION_PREFIX_MIN_CHARS = cfgNum(
  "session_prefix_min_chars",
  "OMP_HEADROOM_PREFIX_MIN_CHARS",
  30_000,
);
export const SESSION_PREFIX_MIN_SHARE = cfgNum(
  "session_prefix_min_share",
  "OMP_HEADROOM_PREFIX_MIN_SHARE",
  0.45,
);
export const SESSION_ARCHIVE_MAX_MESSAGE_CHARS = cfgNum(
  "session_archive_max_message_chars",
  "OMP_HEADROOM_ARCHIVE_MAX_MESSAGE_CHARS",
  900,
);

export const PROVIDER_TIMEOUT_MS = Number(process.env.OMP_HEADROOM_TIMEOUT_MS || 12_000);
export const TOOL_TIMEOUT_MS = Number(process.env.OMP_HEADROOM_TOOL_TIMEOUT_MS || 20_000);
export const ANTHROPIC_COMPRESSION_ENABLED = process.env.OMP_HEADROOM_ANTHROPIC_PROVIDER !== "off";
export const RAINBOW_MS = Number(process.env.OMP_HEADROOM_RAINBOW_MS || 180);
export const RAINBOW_CODES = [196, 202, 226, 46, 51, 39, 129, 201];
export const READY_TTL_MS = Number(process.env.OMP_HEADROOM_READY_TTL_MS || 30_000);
export const STATS_MIN_INTERVAL_MS = Number(process.env.OMP_HEADROOM_STATS_INTERVAL_MS || 2_500);
export const WIDGET_PRIORITY = Number(process.env.OMP_HEADROOM_PRIORITY) || -1050;
export const COMPRESSED_MARKER = "Retrieve more: hash=";
export const RETRIEVED_MARKER = "[headroom:retrieved ";

export const VENV_DIR = dirname(dirname(HEADROOM_BIN));
export const LOGS_DIR = join(dirname(dirname(VENV_DIR)), "logs", "headroom");
export const ARCHIVE_STATS_DIR = cfgStr(
  "archive_stats_dir",
  "OMP_HEADROOM_ARCHIVE_STATS_DIR",
  join(dirname(VENV_DIR), "headroom-archive-stats"),
);
export const VENV_PYTHON = join(VENV_DIR, "bin", "python");
export const AUTOUPDATE = process.env.OMP_HEADROOM_AUTOUPDATE !== "0";
export const UPDATE_INTERVAL_MS = Number(
  process.env.OMP_HEADROOM_UPDATE_INTERVAL_MS || 24 * 3_600_000,
);
const EXTRAS = process.env.OMP_HEADROOM_EXTRAS ?? "all";
export const PACKAGE_SPEC = EXTRAS ? `headroom-ai[${EXTRAS}]` : "headroom-ai";
export const UPDATE_STATE_FILE = join(dirname(VENV_DIR), ".headroom-update.json");
export const UPDATE_LOCK_FILE = join(dirname(VENV_DIR), ".headroom-update.lock");
export const CCR_DIR = join(dirname(VENV_DIR), "headroom-ccr");
export const CODE_AWARE = process.env.OMP_HEADROOM_CODE_AWARE !== "0";
export const PROXY_EXTRA_ARGS = (process.env.OMP_HEADROOM_PROXY_ARGS || "")
  .split(/\s+/)
  .filter(Boolean);
export const RESPONSES_COMPRESS_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.OMP_HEADROOM_RESPONSES_CONCURRENCY || 3) || 3),
);
export const PYPI_JSON_URL = "https://pypi.org/pypi/headroom-ai/json";
