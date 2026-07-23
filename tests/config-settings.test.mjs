import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeHeadroomCommand } from "../src/commands.ts";
import {
  effectiveSettingValue,
  HEADROOM_SETTINGS,
  loadHeadroomConfig,
  parseSettingValue,
  saveHeadroomConfigKey,
  settingSource,
} from "../src/config.ts";

const numberSetting = HEADROOM_SETTINGS.find((entry) => entry.key === "anthropic_min_tool_chars");
const booleanSetting = HEADROOM_SETTINGS.find((entry) => entry.key === "debug_sizing");

test("settings registry stays unique and fully described", () => {
  const keys = HEADROOM_SETTINGS.map((entry) => entry.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const setting of HEADROOM_SETTINGS) {
    expect(setting.env.startsWith("OMP_HEADROOM_")).toBe(true);
    expect(setting.description.length).toBeGreaterThan(0);
    expect(["number", "boolean", "string"]).toContain(setting.kind);
  }
});

test("source resolution: env beats yaml beats default", () => {
  expect(settingSource(numberSetting, {}, {})).toBe("default");
  expect(settingSource(numberSetting, { anthropic_min_tool_chars: 4000 }, {})).toBe("yaml");
  expect(
    settingSource(
      numberSetting,
      { anthropic_min_tool_chars: 4000 },
      { OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS: "6000" },
    ),
  ).toBe("env");

  expect(effectiveSettingValue(numberSetting, {}, {})).toBe(8000);
  expect(effectiveSettingValue(numberSetting, { anthropic_min_tool_chars: 4000 }, {})).toBe(4000);
  expect(
    effectiveSettingValue(
      numberSetting,
      { anthropic_min_tool_chars: 4000 },
      { OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS: "6000" },
    ),
  ).toBe(6000);
});

test("invalid stored values fall back to the default", () => {
  expect(effectiveSettingValue(numberSetting, { anthropic_min_tool_chars: "abc" }, {})).toBe(8000);
  expect(effectiveSettingValue(booleanSetting, { debug_sizing: "maybe" }, {})).toBe(false);
  expect(effectiveSettingValue(booleanSetting, { debug_sizing: "on" }, {})).toBe(true);
});

test("parseSettingValue validates by kind", () => {
  expect(parseSettingValue(numberSetting, "4000")).toBe(4000);
  expect(() => parseSettingValue(numberSetting, "fast")).toThrow(/expects a number/);
  expect(parseSettingValue(booleanSetting, "on")).toBe(true);
  expect(parseSettingValue(booleanSetting, "0")).toBe(false);
  expect(() => parseSettingValue(booleanSetting, "sometimes")).toThrow(/expects on\/off/);
  expect(() => parseSettingValue(numberSetting, "  ")).toThrow(/requires a value/);
});

test("saveHeadroomConfigKey persists atomically and preserves unknown keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-config-"));
  const path = join(dir, "headroom.yml");
  writeFileSync(path, "debug_sizing: true\ncustom_unknown_key: keep-me\n");

  await saveHeadroomConfigKey("anthropic_min_tool_chars", 4000, path);
  const root = loadHeadroomConfig(path);
  expect(root.anthropic_min_tool_chars).toBe(4000);
  expect(root.debug_sizing).toBe(true);
  expect(root.custom_unknown_key).toBe("keep-me");

  await saveHeadroomConfigKey("debug_sizing", false, path);
  expect(loadHeadroomConfig(path).debug_sizing).toBe(false);
  // No temp files left behind.
  expect(readFileSync(path, "utf8")).not.toContain(".tmp");
});

test("saveHeadroomConfigKey creates the file when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headroom-config-new-"));
  const path = join(dir, "headroom.yml");
  await saveHeadroomConfigKey("session_live_messages", 32, path);
  expect(loadHeadroomConfig(path).session_live_messages).toBe(32);
});

test("set completion offers keys, then values for booleans only", () => {
  const keys = completeHeadroomCommand("set ", []);
  expect(keys?.some((entry) => entry.label === "anthropic_min_tool_chars")).toBe(true);

  const filtered = completeHeadroomCommand("set anthropic", []);
  expect(filtered?.every((entry) => entry.label.startsWith("anthropic"))).toBe(true);

  const boolValues = completeHeadroomCommand("set debug_sizing ", []);
  expect(boolValues?.map((entry) => entry.label).sort()).toEqual(["off", "on"]);

  expect(completeHeadroomCommand("set anthropic_min_tool_chars 40", [])).toBeNull();
});

test("invalidSettingValue flags unparseable overrides only", async () => {
  const { invalidSettingValue } = await import("../src/config.ts");
  expect(invalidSettingValue(numberSetting, {}, {})).toBeUndefined();
  expect(
    invalidSettingValue(numberSetting, { anthropic_min_tool_chars: 4000 }, {}),
  ).toBeUndefined();
  expect(invalidSettingValue(numberSetting, { anthropic_min_tool_chars: "abc" }, {})).toBe("abc");
  expect(
    invalidSettingValue(numberSetting, {}, { OMP_HEADROOM_ANTHROPIC_MIN_TOOL_CHARS: "fast" }),
  ).toBe("fast");
  expect(invalidSettingValue(booleanSetting, { debug_sizing: "maybe" }, {})).toBe("maybe");
  expect(invalidSettingValue(booleanSetting, { debug_sizing: true }, {})).toBeUndefined();
});
