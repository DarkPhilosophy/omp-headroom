export interface Invocation {
  command: string;
  args: string[];
}

export interface VenvInvocationOptions {
  useUv: boolean;
  uv: string;
  python: string;
  venvDir: string;
}

export interface PipInstallInvocationOptions {
  useUv: boolean;
  uv: string;
  venvPython: string;
  packages: string[];
}

export function venvInvocation(options: VenvInvocationOptions): Invocation {
  if (options.useUv) {
    return { command: options.uv, args: ["venv", options.venvDir] };
  }

  return { command: options.python, args: ["-m", "venv", options.venvDir] };
}

export function pipInstallInvocation(options: PipInstallInvocationOptions): Invocation {
  if (options.useUv) {
    return {
      command: options.uv,
      args: ["pip", "install", "-p", options.venvPython, "--no-progress", ...options.packages],
    };
  }

  return {
    command: options.venvPython,
    args: [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--progress-bar",
      "off",
      ...options.packages,
    ],
  };
}
