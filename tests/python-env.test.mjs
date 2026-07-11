import { describe, expect, test } from "bun:test";

import { pipInstallInvocation, venvInvocation } from "../src/python-env.ts";

describe("Python environment command selection", () => {
  test("uses uv when it is available", () => {
    expect(
      venvInvocation({ useUv: true, uv: "/opt/uv", python: "python3", venvDir: "/tmp/venv" }),
    ).toEqual({ command: "/opt/uv", args: ["venv", "/tmp/venv"] });

    expect(
      pipInstallInvocation({
        useUv: true,
        uv: "/opt/uv",
        venvPython: "/tmp/venv/bin/python",
        packages: ["--upgrade", "headroom-ai[all]"],
      }),
    ).toEqual({
      command: "/opt/uv",
      args: [
        "pip",
        "install",
        "-p",
        "/tmp/venv/bin/python",
        "--no-progress",
        "--upgrade",
        "headroom-ai[all]",
      ],
    });
  });

  test("falls back to stdlib venv and its pip without changing package options", () => {
    expect(
      venvInvocation({ useUv: false, uv: "uv", python: "/usr/bin/python3", venvDir: "/tmp/venv" }),
    ).toEqual({ command: "/usr/bin/python3", args: ["-m", "venv", "/tmp/venv"] });

    expect(
      pipInstallInvocation({
        useUv: false,
        uv: "uv",
        venvPython: "/tmp/venv/bin/python",
        packages: ["torch==2.9.1+rocm6.4", "--index-url", "https://example.invalid/rocm"],
      }),
    ).toEqual({
      command: "/tmp/venv/bin/python",
      args: [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--progress-bar",
        "off",
        "torch==2.9.1+rocm6.4",
        "--index-url",
        "https://example.invalid/rocm",
      ],
    });
  });
});
