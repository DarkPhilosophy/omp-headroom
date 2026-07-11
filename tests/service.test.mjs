import { describe, expect, test } from "bun:test";

import { parseServiceAction, renderHeadroomUserService } from "../src/service.ts";

const serviceLines = (unit) => unit.split("\n");

function execStartLine(unit) {
  const matches = serviceLines(unit).filter((line) => line.startsWith("ExecStart="));
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("renderHeadroomUserService", () => {
  test("renders the exact executable, loopback bind, and port as service arguments", () => {
    const headroomBin = "/srv/headroom/bin/head room";
    const port = 43123;
    const unit = renderHeadroomUserService(headroomBin, port);

    // systemd requires an executable containing whitespace to be quoted or escaped.
    expect(execStartLine(unit)).toMatch(
      /^ExecStart=(?:"\/srv\/headroom\/bin\/head room"|\/srv\/headroom\/bin\/head\\x20room) proxy --host 127\.0\.0\.1 --port 43123 --no-telemetry$/,
    );
  });

  test("rejects line-breaking paths and escapes systemd percent specifiers", () => {
    expect(() => renderHeadroomUserService("/tmp/headroom\nEnvironment=INJECTED=1", 8787)).toThrow(
      "control characters",
    );
    expect(execStartLine(renderHeadroomUserService("/opt/head%room/bin/headroom", 8787))).toContain(
      "/opt/head%%room/bin/headroom",
    );
  });

  test("sets the existing Headroom environment for the user service", () => {
    const lines = serviceLines(renderHeadroomUserService("/opt/headroom/bin/headroom", 8787));
    const environment = lines.filter((line) => line.startsWith("Environment="));

    expect(new Set(environment)).toEqual(
      new Set([
        "Environment=HEADROOM_TELEMETRY=off",
        "Environment=HEADROOM_CODE_AWARE_ENABLED=1",
        "Environment=HEADROOM_NO_SUBSCRIPTION_TRACKING=1",
        "Environment=HEADROOM_PROXY_EXTENSIONS=omp_stats",
      ]),
    );
  });

  test("always restarts and installs into the user default target", () => {
    const lines = serviceLines(renderHeadroomUserService("/opt/headroom/bin/headroom", 8787));

    expect(lines).toContain("Restart=always");
    expect(lines).toContain("WantedBy=default.target");
  });
});

describe("parseServiceAction", () => {
  test("normalizes supported actions by trimming and lowercasing", () => {
    const cases = [
      ["install", "install"],
      ["  INSTALL  ", "install"],
      ["\tuninstall\n", "uninstall"],
      [" StAtUs ", "status"],
    ];

    for (const [input, expected] of cases) {
      expect(parseServiceAction(input)).toBe(expected);
    }
  });

  test("rejects unsupported strings and non-string values", () => {
    const invalidValues = [
      undefined,
      null,
      "",
      "start",
      " install-now ",
      "install status",
      1,
      {},
      ["status"],
    ];

    for (const value of invalidValues) {
      expect(parseServiceAction(value)).toBeUndefined();
    }
  });
});
