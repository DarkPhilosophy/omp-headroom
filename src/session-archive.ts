import { createHash } from "node:crypto";
import {
  SESSION_ARCHIVE_ENABLED,
  SESSION_ARCHIVE_MAX_MESSAGE_CHARS,
  SESSION_LIVE_MESSAGES,
  SESSION_PREFIX_MIN_CHARS,
  SESSION_PREFIX_MIN_SHARE,
} from "./config.ts";
import { collectProviderTextCandidates } from "./provider.ts";
import { isRecord, stableJson, truncateMiddle } from "./util.ts";

export const SESSION_ARCHIVE_MARKER = "[Headroom session archive]";

export interface SessionArchiveOptions {
  enabled?: boolean;
  liveMessages?: number;
  minPrefixChars?: number;
  minPrefixShare?: number;
  archiveMaxMessageChars?: number;
}

export interface SessionArchiveCandidate {
  compacted: true;
  reason: "compacted";
  messages: unknown[];
  hash: string;
  originalText: string;
  prefixCount: number;
  liveCount: number;
  prefixChars: number;
  totalChars: number;
  prefixShare: number;
  archiveChars: number;
}

export interface SessionArchivePassThrough {
  compacted: false;
  reason: string;
  messages: unknown[];
  prefixChars?: number;
  totalChars?: number;
  prefixShare?: number;
  prefixCount?: number;
  liveCount?: number;
}

export type SessionArchiveResult = SessionArchiveCandidate | SessionArchivePassThrough;

function passThrough(
  messages: unknown[],
  reason: string,
  details: Omit<SessionArchivePassThrough, "compacted" | "reason" | "messages"> = {},
): SessionArchivePassThrough {
  return { compacted: false, reason, messages, ...details };
}

function messageApproxChars(message: unknown): number {
  if (!isRecord(message)) return String(message ?? "").length;
  const texts: string[] = [];
  collectProviderTextCandidates(message, texts);
  return Math.max(
    texts.reduce((sum, text) => sum + text.length, 0),
    stableJson(message).length,
  );
}

function messageHasSessionArchive(message: unknown): boolean {
  const texts: string[] = [];
  collectProviderTextCandidates(message, texts);
  return texts.some((text) => text.includes(SESSION_ARCHIVE_MARKER));
}

function messageToolCallIds(message: unknown): string[] {
  if (!isRecord(message)) return [];
  const ids: string[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (isRecord(call) && typeof call.id === "string") ids.push(call.id);
    }
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string") {
        ids.push(block.id);
      }
    }
  }
  if (
    (message.type === "function_call" || message.type === "custom_tool_call") &&
    typeof message.call_id === "string"
  ) {
    ids.push(message.call_id);
  }
  return ids;
}

function messageToolResultIds(message: unknown): string[] {
  if (!isRecord(message)) return [];
  const ids: string[] = [];
  if (message.role === "tool" && typeof message.tool_call_id === "string") {
    ids.push(message.tool_call_id);
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        ids.push(block.tool_use_id);
      }
    }
  }
  if (
    (message.type === "function_call_output" || message.type === "custom_tool_call_output") &&
    typeof message.call_id === "string"
  ) {
    ids.push(message.call_id);
  }
  return ids;
}

function safeSessionCut(messages: unknown[], requestedCut: number): number {
  let cut = Math.max(0, Math.min(messages.length, requestedCut));
  let changed = true;
  while (changed && cut > 0) {
    changed = false;
    const liveToolResults = new Set<string>();
    for (let index = cut; index < messages.length; index++) {
      for (const id of messageToolResultIds(messages[index])) liveToolResults.add(id);
    }
    if (liveToolResults.size === 0) break;
    for (let index = cut - 1; index >= 0; index--) {
      if (messageToolCallIds(messages[index]).some((id) => liveToolResults.has(id))) {
        cut = index;
        changed = true;
        break;
      }
    }
  }
  return cut;
}

function archiveLineForMessage(message: unknown, index: number, maxChars: number): string {
  if (!isRecord(message)) return `- ${index}: ${String(message)}`;
  const role = String(message.role || message.type || "unknown");
  const ids = [
    ...messageToolCallIds(message).map((id) => `tool_call=${id}`),
    ...messageToolResultIds(message).map((id) => `tool_result=${id}`),
  ];
  const texts: string[] = [];
  collectProviderTextCandidates(message, texts);
  const text = truncateMiddle(texts.join("\n\n").trim(), maxChars);
  const suffix = ids.length ? ` (${ids.join(", ")})` : "";
  return `- ${index}: ${role}${suffix}${text ? ` — ${text}` : ""}`;
}

function buildSessionArchiveText(
  prefixMessages: unknown[],
  hash: string,
  options: SessionArchiveOptions,
): string {
  const maxChars = Math.max(
    120,
    Number(options.archiveMaxMessageChars ?? SESSION_ARCHIVE_MAX_MESSAGE_CHARS),
  );
  const lines = [
    SESSION_ARCHIVE_MARKER,
    `Earlier stable conversation prefix compacted: ${prefixMessages.length} messages.`,
    `Full original prefix: Retrieve more: hash=${hash}`,
    "Recent live messages after this archive are verbatim and authoritative.",
    "Archive index:",
  ];
  prefixMessages.forEach((message, index) => {
    lines.push(archiveLineForMessage(message, index, maxChars));
  });
  return lines.join("\n");
}

export function createSessionCompaction(
  messages: unknown[],
  options: SessionArchiveOptions = {},
): SessionArchiveResult {
  if (options.enabled === false || !SESSION_ARCHIVE_ENABLED) {
    return passThrough(messages, "disabled");
  }
  if (!Array.isArray(messages) || messages.length < 4) {
    return passThrough(messages, "too_few_messages");
  }

  let headCount = 0;
  while (headCount < messages.length) {
    const message = messages[headCount];
    if (!isRecord(message) || !["system", "developer"].includes(String(message.role || ""))) break;
    headCount += 1;
  }
  const head = messages.slice(0, headCount);
  const body = messages.slice(headCount);
  const liveMessages = Math.max(1, Number(options.liveMessages ?? SESSION_LIVE_MESSAGES));
  const cut = safeSessionCut(body, Math.max(0, body.length - liveMessages));
  if (cut <= 0) return passThrough(messages, "no_safe_prefix");
  for (let index = cut; index < body.length; index++) {
    if (messageHasSessionArchive(body[index])) return passThrough(messages, "existing_archive");
  }

  const prefix = body.slice(0, cut);
  const live = body.slice(cut);
  const prefixChars = prefix.reduce<number>((sum, message) => sum + messageApproxChars(message), 0);
  const totalChars = body.reduce<number>((sum, message) => sum + messageApproxChars(message), 0);
  const minPrefixChars = Math.max(0, Number(options.minPrefixChars ?? SESSION_PREFIX_MIN_CHARS));
  const minPrefixShare = Math.max(0, Number(options.minPrefixShare ?? SESSION_PREFIX_MIN_SHARE));
  const prefixShare = totalChars > 0 ? prefixChars / totalChars : 0;
  const details = {
    prefixChars,
    totalChars,
    prefixShare,
    prefixCount: prefix.length,
    liveCount: live.length,
  };
  if (prefixChars < minPrefixChars) return passThrough(messages, "prefix_too_small", details);
  if (prefixShare < minPrefixShare) return passThrough(messages, "share_too_small", details);

  const hash = createHash("sha256").update(stableJson(prefix)).digest("hex").slice(0, 24);
  const originalText = JSON.stringify(prefix, null, 2);
  const archiveText = buildSessionArchiveText(prefix, hash, options);
  const projected = [...head, { role: "user", content: archiveText }, ...live];
  if (JSON.stringify(projected).length >= JSON.stringify(messages).length) {
    return passThrough(messages, "not_beneficial", details);
  }
  return {
    compacted: true,
    reason: "compacted",
    messages: projected,
    hash,
    originalText,
    ...details,
    archiveChars: archiveText.length,
  };
}

export async function applySessionArchive(
  messages: unknown[],
  options: SessionArchiveOptions,
  persist: (candidate: SessionArchiveCandidate) => Promise<boolean>,
): Promise<SessionArchiveResult> {
  const candidate = createSessionCompaction(messages, options);
  if (!candidate.compacted) return candidate;
  try {
    if (await persist(candidate)) return candidate;
  } catch {
    // Persistence failure must keep the complete original provider payload.
  }
  return passThrough(messages, "persistence_failed");
}

function asResponsesArchiveItem(message: unknown): unknown {
  if (!isRecord(message) || typeof message.content !== "string") return message;
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.content }],
  };
}

export function createResponsesSessionCompaction(
  input: unknown[],
  options: SessionArchiveOptions = {},
): SessionArchiveResult & { input: unknown[] } {
  const candidate = createSessionCompaction(input, options);
  if (!candidate.compacted) return { ...candidate, input };
  return {
    ...candidate,
    input: candidate.messages.map((message) =>
      messageHasSessionArchive(message) ? asResponsesArchiveItem(message) : message,
    ),
  };
}

export function asAnthropicArchiveMessage(message: unknown): unknown {
  if (
    !messageHasSessionArchive(message) ||
    !isRecord(message) ||
    typeof message.content !== "string"
  ) {
    return message;
  }
  return { ...message, content: [{ type: "text", text: message.content }] };
}

export function expandSessionArchiveText(
  originalText: string,
  readHash: (hash: string) => string,
): string {
  try {
    const messages = JSON.parse(originalText);
    if (!Array.isArray(messages)) return originalText;
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      if (!messageHasSessionArchive(message)) continue;
      const texts: string[] = [];
      collectProviderTextCandidates(message, texts);
      for (const text of texts) {
        const hash = text.match(/Full original prefix: Retrieve more: hash=([0-9a-f]{8,})/)?.[1];
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        const ancestor = readHash(hash);
        if (ancestor) {
          parts.push(`--- chained session archive hash=${hash} (full original) ---\n${ancestor}`);
        }
      }
    }
    return parts.length ? `${originalText}\n\n${parts.join("\n\n")}` : originalText;
  } catch {
    return originalText;
  }
}
