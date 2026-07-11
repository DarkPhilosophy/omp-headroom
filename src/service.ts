import { readFileSync } from "node:fs";
import { SYSTEMD_TEMPLATE_PATH } from "./config.ts";

export type ServiceAction = "install" | "uninstall" | "status";

const SERVICE_ACTIONS = new Set<ServiceAction>(["install", "uninstall", "status"]);

export function parseServiceAction(value: unknown): ServiceAction | undefined {
  if (typeof value !== "string") return undefined;
  const action = value.trim().toLowerCase();
  return SERVICE_ACTIONS.has(action as ServiceAction) ? (action as ServiceAction) : undefined;
}

function quoteSystemdExecArgument(value: string): string {
  if (!value) throw new Error("Headroom executable path is required");
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Headroom executable path must not contain control characters");
  }
  const escaped = value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /[\s"\\]/.test(escaped) ? `"${escaped}"` : escaped;
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid Headroom service port: ${value}`);
  }
  return value;
}

export function renderHeadroomUserService(headroomBin: string, port: number): string {
  const executable = quoteSystemdExecArgument(headroomBin);
  const servicePort = validPort(port);

  const template = readFileSync(SYSTEMD_TEMPLATE_PATH, "utf8");
  if (!template.includes("@HEADROOM_BIN@") || !template.includes("@PORT@")) {
    throw new Error(`Invalid Headroom service template: ${SYSTEMD_TEMPLATE_PATH}`);
  }
  return template
    .replaceAll("@HEADROOM_BIN@", executable)
    .replaceAll("@PORT@", String(servicePort));
}
