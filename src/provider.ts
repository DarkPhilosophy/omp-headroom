// Provider-shape detection, registered retrieval-tool lookup, compression
// markers, and text-candidate collection.
import {
  COMPRESSED_MARKER,
  PROVIDER_MIN_TEXT_CHARS,
  RETRIEVE_TOOL,
  RETRIEVED_MARKER,
} from "./config.ts";
import { isRecord } from "./util.ts";

export type ProviderFormat = "openai" | "anthropic" | "responses";

export const RETRIEVE_DESCRIPTION =
  "Retrieve original uncompressed content that Headroom compressed to save tokens. Use this when a compression marker/hash indicates more details are available.";

export function responseOutputText(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (
    (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
    typeof item.output === "string"
  ) {
    return item.output;
  }
  return undefined;
}

export function systemToText(system: unknown): string | undefined {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return undefined;
  const parts: string[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (isRecord(item) && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    parts.push(JSON.stringify(item));
  }
  return parts.join("\n");
}

export function inferProviderFormat(payload: unknown): ProviderFormat {
  if (!isRecord(payload)) return "openai";
  if (payload.system !== undefined) return "anthropic";
  if (Array.isArray(payload.input)) return "responses";
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  for (const tool of tools) {
    if (isRecord(tool) && "input_schema" in tool) return "anthropic";
  }
  return "openai";
}

export function effectiveProviderFormat(
  payload: unknown,
  ctx: { model?: { provider?: string } } | null | undefined,
): ProviderFormat {
  const inferred = inferProviderFormat(payload);
  if (inferred !== "openai") return inferred;
  const provider = ctx?.model?.provider;
  if (provider === "anthropic") return "anthropic";
  return inferred;
}

export function hasRetrieveTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!isRecord(tool)) return false;
    if (tool.name === RETRIEVE_TOOL) return true;
    if (isRecord(tool.function) && tool.function.name === RETRIEVE_TOOL) return true;
    return false;
  });
}

export function textHasCompressedMarker(text: unknown): boolean {
  return (
    typeof text === "string" &&
    (text.includes(COMPRESSED_MARKER) || text.includes(RETRIEVED_MARKER))
  );
}

export function collectProviderTextCandidates(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProviderTextCandidates(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.text === "string") out.push(value.text);
  if (typeof value.content === "string") out.push(value.content);
  else if (Array.isArray(value.content)) collectProviderTextCandidates(value.content, out);
  if (typeof value.output === "string") out.push(value.output);
}

export function isProviderCompressionCandidate(
  text: unknown,
  minChars = PROVIDER_MIN_TEXT_CHARS,
): boolean {
  return (
    typeof text === "string" && !textHasCompressedMarker(text) && text.trim().length >= minChars
  );
}

export function providerPayloadHasCompressionCandidate(
  payload: unknown,
  minChars = PROVIDER_MIN_TEXT_CHARS,
): boolean {
  if (!isRecord(payload)) return false;
  const topLevelTexts: string[] = [];
  collectProviderTextCandidates(payload.system, topLevelTexts);
  if (topLevelTexts.some((text) => isProviderCompressionCandidate(text, minChars))) return true;
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const texts: string[] = [];
    collectProviderTextCandidates(item.content, texts);
    const output = responseOutputText(item);
    if (typeof output === "string") texts.push(output);
    if (texts.some((text) => isProviderCompressionCandidate(text, minChars))) return true;
  }
  return false;
}
