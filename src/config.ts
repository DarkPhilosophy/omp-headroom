// Headroom extension configuration: constants, ~/.omp/agent/headroom.yml loading,
// and env-var overrides. Env vars (OMP_HEADROOM_*) always take priority over the
// YAML file; unknown keys are ignored; a malformed file falls back to env-only.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Declarative settings registry: one table drives the
// effective-config listing (`/headroom config`), key completion, validation,
// and persistence (`/headroom set <key> <value>`). Env always wins over YAML,
// YAML wins over the default.
export interface HeadroomSetting {
  /** Flat YAML key in ~/.omp/agent/headroom.yml (e.g. "min_tool_chars"). */
  key: string;
  env: string;
  kind: "number" | "boolean" | "string";
  def: string | number | boolean;
  description: string;
}

export const HEADROOM_SETTINGS: readonly HeadroomSetting[] = [
  {
    key: "bin",
    env: "OMP_HEADROOM_BIN",
    kind: "string",
    def: DEFAULT_HEADROOM_BIN,
    description: "Headroom proxy binary path",
  },
  {
    key: "min_tool_chars",
    env: "OMP_HEADROOM_MIN_TOOL_CHARS",
    kind: "number",
    def: 12_000,
    description: "Responses per-item compression threshold (chars)",
  },
  {
    key: "anthropic_min_tool_chars",
    env: "OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS",
    kind: "number",
    def: 8_000,
    description: "Anthropic tool_result compression threshold (chars)",
  },
  {
    key: "min_provider_chars",
    env: "OMP_HEADROOM_MIN_PROVIDER_CHARS",
    kind: "number",
    def: 1_000,
    description: "Minimum text size considered a compression candidate (chars)",
  },
  {
    key: "adaptive",
    env: "OMP_HEADROOM_ADAPTIVE",
    kind: "boolean",
    def: true,
    description: "Scale thresholds down as context usage grows",
  },
  {
    key: "adaptive_start",
    env: "OMP_HEADROOM_ADAPTIVE_START",
    kind: "number",
    def: 0.5,
    description: "Context usage ratio where adaptive scaling starts",
  },
  {
    key: "adaptive_full",
    env: "OMP_HEADROOM_ADAPTIVE_FULL",
    kind: "number",
    def: 0.9,
    description: "Context usage ratio where thresholds reach the floor",
  },
  {
    key: "adaptive_floor",
    env: "OMP_HEADROOM_ADAPTIVE_FLOOR",
    kind: "number",
    def: 0.25,
    description: "Lowest threshold multiplier under adaptive scaling",
  },
  {
    key: "debug_sizing",
    env: "OMP_HEADROOM_DEBUG_SIZING",
    kind: "boolean",
    def: false,
    description: "Write per-request sizing/diagnostic JSONL logs",
  },
  {
    key: "session_archive",
    env: "OMP_HEADROOM_SESSION_COMPACTION",
    kind: "boolean",
    def: true,
    description: "Archive stable transcript prefixes into retrievable summaries",
  },
  {
    key: "session_live_messages",
    env: "OMP_HEADROOM_LIVE_MESSAGES",
    kind: "number",
    def: 24,
    description: "Recent messages always kept out of the session archive",
  },
  {
    key: "session_prefix_min_chars",
    env: "OMP_HEADROOM_PREFIX_MIN_CHARS",
    kind: "number",
    def: 30_000,
    description: "Minimum archivable prefix size (chars)",
  },
  {
    key: "session_prefix_min_share",
    env: "OMP_HEADROOM_PREFIX_MIN_SHARE",
    kind: "number",
    def: 0.45,
    description: "Minimum archivable prefix share of the payload",
  },
  {
    key: "session_archive_max_message_chars",
    env: "OMP_HEADROOM_ARCHIVE_MAX_MESSAGE_CHARS",
    kind: "number",
    def: 900,
    description: "Per-message excerpt cap inside the session archive",
  },
  {
    key: "archive_stats_dir",
    env: "OMP_HEADROOM_ARCHIVE_STATS_DIR",
    kind: "string",
    def: join(dirname(VENV_DIR), "headroom-archive-stats"),
    description: "Directory for durable per-session archive counters",
  },
];

export type SettingSource = "env" | "yaml" | "default";

export function settingSource(
  setting: HeadroomSetting,
  cfg: Record<string, unknown> = _cfg,
  env: Record<string, string | undefined> = process.env,
): SettingSource {
  if (env[setting.env] !== undefined) return "env";
  if (setting.key in cfg) return "yaml";
  return "default";
}

export function effectiveSettingValue(
  setting: HeadroomSetting,
  cfg: Record<string, unknown> = _cfg,
  env: Record<string, string | undefined> = process.env,
): string | number | boolean {
  const raw =
    env[setting.env] !== undefined
      ? env[setting.env]
      : setting.key in cfg
        ? cfg[setting.key]
        : undefined;
  if (raw === undefined) return setting.def;
  if (setting.kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : setting.def;
  }
  if (setting.kind === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return true;
    if (["0", "false", "off", "no"].includes(s)) return false;
    return setting.def;
  }
  return String(raw);
}

/**
 * Returns the raw override text when an env/yaml value cannot be parsed for
 * its kind (so callers can warn instead of silently using the default), or
 * undefined when the override is absent or valid.
 */
export function invalidSettingValue(
  setting: HeadroomSetting,
  cfg: Record<string, unknown> = _cfg,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw =
    env[setting.env] !== undefined
      ? env[setting.env]
      : setting.key in cfg
        ? cfg[setting.key]
        : undefined;
  if (raw === undefined) return undefined;
  if (setting.kind === "number") {
    return Number.isFinite(Number(raw)) ? undefined : String(raw);
  }
  if (setting.kind === "boolean") {
    if (typeof raw === "boolean") return undefined;
    const s = String(raw).toLowerCase();
    return ["1", "true", "on", "yes", "0", "false", "off", "no"].includes(s)
      ? undefined
      : String(raw);
  }
  return undefined;
}

/** Parse and validate a user-supplied value for one setting. Throws on invalid input. */
export function parseSettingValue(
  setting: HeadroomSetting,
  value: string,
): string | number | boolean {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`"${setting.key}" requires a value`);
  if (setting.kind === "number") {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) throw new Error(`"${setting.key}" expects a number, got "${trimmed}"`);
    return n;
  }
  if (setting.kind === "boolean") {
    const s = trimmed.toLowerCase();
    if (["1", "true", "on", "yes"].includes(s)) return true;
    if (["0", "false", "off", "no"].includes(s)) return false;
    throw new Error(`"${setting.key}" expects on/off, got "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Persist one setting to headroom.yml atomically (temp file + rename). Other
 * keys — including unknown ones — are preserved verbatim. The in-memory
 * constants are computed at import, so a change takes effect on the next
 * session or /reload-plugins.
 */
export async function saveHeadroomConfigKey(
  key: string,
  value: string | number | boolean,
  path = HEADROOM_CONFIG_PATH,
): Promise<void> {
  const root = loadHeadroomConfig(path);
  root[key] = value;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.headroom.yml.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, Bun.YAML.stringify(root), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
