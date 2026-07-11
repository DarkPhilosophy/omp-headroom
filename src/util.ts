// Pure helpers shared across the extension: type guards, number/string
// formatting, ANSI/OSC widget primitives, and stable JSON serialization.
import { RAINBOW_CODES } from "./config.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The ONLY reliable discriminator between the main UI session and a
// subagent/advisor: ctx.hasUI. OMP sets hasUI=true only for the real
// interactive session; subagents are created with hasUI:false and a
// `noOpUIContext` whose `setWidget` IS a (no-op) function — so checking
// `typeof ctx.ui.setWidget === "function"` WRONGLY classifies subagents as
// main. Never use the setWidget fallback for this decision.
export function isMainSession(ctx: { hasUI?: boolean } | null | undefined): boolean {
  return ctx?.hasUI === true;
}

export function safeSessionId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : "";
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function formatInt(value: unknown): string {
  return Math.round(asNumber(value)).toLocaleString();
}

export function formatPct(value: unknown): string {
  const n = asNumber(value);
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

export function formatUsd(value: unknown): string {
  const n = asNumber(value);
  return n > 0 ? `$${n.toFixed(2)}` : "$0.00";
}

// Compact large widget counters: 1,234,567,890 -> "1.2B", 16,468,518 -> "16.5M".
export function formatCompactTokens(value: unknown): string {
  const n = Math.max(0, asNumber(value));
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function computeInner(contentWidth = 0): number {
  const cols = process.stdout.columns || 102;
  const envMax = Number(process.env.OMP_HEADROOM_WIDGET_MAX_WIDTH || 0);
  const envMin = Number(process.env.OMP_HEADROOM_WIDGET_MIN_WIDTH || 0);
  const min = Number.isFinite(envMin) && envMin >= 12 ? envMin : 18;
  const autoMax = Math.max(min, Math.min(52, Math.floor(cols * 0.45) - 2));
  const cap = Number.isFinite(envMax) && envMax >= min ? envMax : autoMax;
  return Math.max(min, Math.min(cap, Math.max(min, contentWidth)));
}

export function color(code: string | number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function rainbow(text: string, phase: number): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += color(`38;5;${RAINBOW_CODES[(i + phase) % RAINBOW_CODES.length]}`, text[i] as string);
  }
  return out;
}

// OSC 8 terminal hyperlink (zero visible width): makes the rainbow title a
// Ctrl/Cmd-clickable link to the dashboard. Renderers without OSC 8 ignore
// the escapes and show plain text, so it degrades cleanly.
export function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function clip(text: unknown, max: number): string {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

export function row(text: string, inner: number): string {
  const value = clip(text, Math.max(0, inner - 1));
  return `│${value}${" ".repeat(Math.max(0, inner - value.length))}│`;
}

// Border line with content embedded in the frame. Raw strings carry the
// visible width (ANSI/OSC escapes in styled strings are zero-width).
export function borderLine(
  inner: number,
  open: string,
  close: string,
  leftRaw: string,
  leftStyled: string,
  rightRaw = "",
  rightStyled = "",
): string {
  const fill = Math.max(1, inner + 2 - 2 - leftRaw.length - rightRaw.length);
  return `${open}${leftStyled}${"─".repeat(fill)}${rightStyled}${close}`;
}

export function getTextBlocks(content: unknown): Array<{ type: string; text: string }> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is { type: string; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) out[key] = v[key];
    return out;
  });
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const half = Math.max(20, Math.floor((maxChars - 40) / 2));
  return `${text.slice(0, half)}\n… [${text.length - half * 2} chars archived; retrieve full prefix by hash] …\n${text.slice(-half)}`;
}

// True when `candidate` is a strictly newer dotted version than `current`.
export function isNewer(candidate: unknown, current: unknown): boolean {
  if (!candidate || !current) return false;
  const a = String(candidate)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const b = String(current)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}
