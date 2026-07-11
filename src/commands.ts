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
  { label: "config", description: "Show current configuration" },
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
