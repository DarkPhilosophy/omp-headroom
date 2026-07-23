import type { HeadroomSetting } from "./config.ts";
import { HEADROOM_SETTINGS } from "./config.ts";

export interface HeadroomSubcommand {
  label: string;
  description: string;
}

export interface CommandCompletion extends HeadroomSubcommand {
  value: string;
}

export const SUBCOMMANDS: readonly HeadroomSubcommand[] = [
  { label: "stats", description: "Show compression stats (proxy, archive, CCR)" },
  { label: "on", description: "Enable Headroom for this session" },
  { label: "off", description: "Disable Headroom for this session" },
  { label: "compact", description: "Run OMP semantic compaction with a Headroom CCR archive" },
  { label: "clear", description: "Clear current-session CCR archives and archive counters" },
  {
    label: "test",
    description: "Run a real proxy compression test or open a native OMP compaction fixture",
  },
  { label: "service", description: "Install, remove, or inspect the Headroom user service" },
  { label: "help", description: "List all subcommands with descriptions" },
  { label: "version", description: "Show versions, paths, and running status" },
  { label: "config", description: "Show the effective configuration and its source path" },
  { label: "set", description: "Persist one configuration key to headroom.yml" },
  { label: "debug", description: "Show debug info (logs, sizing)" },
  { label: "start", description: "Start the Headroom proxy" },
  { label: "stop", description: "Stop the Headroom proxy" },
  { label: "restart", description: "Restart the Headroom proxy" },
  { label: "update", description: "Check for and install Headroom updates" },
];

const TEST_SURFACE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  tool: "Run the real Headroom proxy compression path, then open its native Headroom Compress result",
  compaction: "Open a native OMP compaction fixture in an isolated session",
};

export function completeHeadroomCommand(
  prefix: unknown,
  testSurfaces: readonly string[],
): CommandCompletion[] | null {
  const normalized = String(prefix || "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("clear")) {
    const options = [
      {
        value: "clear session",
        label: "session",
        description: "Preview current-session Headroom data deletion",
      },
      {
        value: "clear session confirm",
        label: "session confirm",
        description: "Confirm current-session Headroom data deletion",
      },
    ];
    const suffix = normalized.slice("clear".length).trim();
    const matches = suffix ? options.filter((option) => option.label.startsWith(suffix)) : options;
    return matches.length ? matches : null;
  }

  if (normalized === "set" || normalized.startsWith("set ")) {
    // Use the untrimmed prefix: a trailing space means the key is complete
    // and the user is now entering the value.
    const rest = String(prefix || "")
      .toLowerCase()
      .replace(/^\s*set\s+/, "");
    const [keyPrefix, ...valueParts] = rest.split(/\s+/);
    const setting = HEADROOM_SETTINGS.find((entry) => entry.key === keyPrefix);
    if (setting && (valueParts.length > 0 || rest.endsWith(" "))) {
      if (setting.kind !== "boolean") return null;
      const valuePrefix = valueParts.join(" ");
      const options = ["on", "off"]
        .filter((option) => option.startsWith(valuePrefix))
        .map((option) => ({
          value: `set ${setting.key} ${option}`,
          label: option,
          description: setting.description,
        }));
      return options.length ? options : null;
    }
    const keys = HEADROOM_SETTINGS.filter((entry) => entry.key.startsWith(keyPrefix ?? "")).map(
      (entry) => ({
        value: `set ${entry.key} `,
        label: entry.key,
        description: settingCompletionDescription(entry),
      }),
    );
    return keys.length ? keys : null;
  }

  if (normalized.startsWith("test ")) {
    const surfacePrefix = normalized.slice("test ".length);
    const fixtures = testSurfaces
      .filter((surface) => surface.startsWith(surfacePrefix))
      .map((surface) => ({
        value: `test ${surface}`,
        label: surface,
        description: TEST_SURFACE_DESCRIPTIONS[surface] ?? "Run the Headroom test fixture",
      }));
    return fixtures.length ? fixtures : null;
  }

  const matches = normalized
    ? SUBCOMMANDS.filter((command) => command.label.startsWith(normalized))
    : SUBCOMMANDS;
  return matches.length ? matches.map((command) => ({ ...command, value: command.label })) : null;
}

export function commandHelpLines(): string[] {
  return SUBCOMMANDS.map((command) => `  /headroom ${command.label} — ${command.description}`);
}

function settingCompletionDescription(setting: HeadroomSetting): string {
  const def = typeof setting.def === "boolean" ? (setting.def ? "on" : "off") : String(setting.def);
  return `${setting.description} (${setting.kind}, default ${def})`;
}
