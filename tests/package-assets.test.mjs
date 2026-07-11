import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PACKAGE_ROOT, STATS_PLUGIN_DIR, SYSTEMD_TEMPLATE_PATH } from "../src/config.ts";

describe("package-owned Headroom assets", () => {
  test("resolves the package root containing package.json", () => {
    expect(existsSync(join(PACKAGE_ROOT, "package.json"))).toBe(true);
  });

  test("resolves the packaged stats plugin source", () => {
    expect(existsSync(join(STATS_PLUGIN_DIR, "pyproject.toml"))).toBe(true);
  });

  test("resolves the packaged systemd service template", () => {
    expect(existsSync(SYSTEMD_TEMPLATE_PATH)).toBe(true);
  });
});
