import {
  ADAPTIVE_FLOOR_RATIO,
  ADAPTIVE_FULL_RATIO,
  ADAPTIVE_START_RATIO,
  ADAPTIVE_THRESHOLDS,
} from "./config.ts";
import { messageChars } from "./messages.ts";
import { collectProviderTextCandidates } from "./provider.ts";
import { asNumber, isRecord, stableJson } from "./util.ts";

export interface CompressionResult {
  messages: unknown[];
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  charsSaved: number;
  compressionRatio: number;
  transformsApplied: unknown[];
  transformsSummary: unknown;
  ccrHashes: unknown[];
  compressed: boolean;
}

export function payloadCharTotal(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  let total = 0;
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  for (const item of items) {
    if (!isRecord(item)) {
      total += String(item).length;
      continue;
    }
    const texts: string[] = [];
    collectProviderTextCandidates(item.content, texts);
    if (typeof item.output === "string") texts.push(item.output);
    total += texts.reduce((sum, text) => sum + text.length, 0);
  }
  if (typeof payload.system === "string") total += payload.system.length;
  else if (Array.isArray(payload.system)) {
    const texts: string[] = [];
    collectProviderTextCandidates(payload.system, texts);
    total += texts.reduce((sum, text) => sum + text.length, 0);
  }
  return total;
}

export function adaptiveMinChars(
  base: unknown,
  usageRatio: unknown,
  { enabled = ADAPTIVE_THRESHOLDS }: { enabled?: boolean } = {},
): number {
  const value = Math.max(0, asNumber(base));
  if (!enabled) return value;
  const start = Number.isFinite(ADAPTIVE_START_RATIO)
    ? Math.min(0.95, Math.max(0, ADAPTIVE_START_RATIO))
    : 0.5;
  const full = Math.min(
    1,
    Math.max(start + 0.01, Number.isFinite(ADAPTIVE_FULL_RATIO) ? ADAPTIVE_FULL_RATIO : 0.9),
  );
  const floorRatio = Number.isFinite(ADAPTIVE_FLOOR_RATIO)
    ? Math.min(1, Math.max(0.05, ADAPTIVE_FLOOR_RATIO))
    : 0.25;
  const ratio = Math.min(1, Math.max(0, asNumber(usageRatio)));
  if (ratio <= start) return value;
  const progress = Math.min(1, (ratio - start) / (full - start));
  const floor = value * floorRatio;
  return Math.round(value - progress * (value - floor));
}

export function normalizeCompressionResult(
  data: unknown,
  fallbackMessages: unknown[],
): CompressionResult {
  const source = isRecord(data) ? data : {};
  const before = asNumber(source.tokens_before ?? source.tokensBefore);
  const after = asNumber(source.tokens_after ?? source.tokensAfter);
  const tokenReduced =
    Number.isInteger(before) &&
    Number.isInteger(after) &&
    before > 0 &&
    after >= 0 &&
    after < before;
  const saved = tokenReduced ? before - after : 0;
  const ccrHashes = source.ccr_hashes ?? source.ccrHashes;
  const returnedMessages = Array.isArray(source.messages) ? source.messages : undefined;
  // The proxy's token metrics describe exactly the message array it returned.
  // Rewriting a compressed user turn back into that array would invalidate
  // tokens_after, so reject the entire response instead. This keeps every user
  // message byte-for-byte stable while preserving trustworthy token accounting.
  const aligned =
    returnedMessages !== undefined && returnedMessages.length === fallbackMessages.length;
  const usersPreserved =
    aligned &&
    fallbackMessages.every(
      (original, index) =>
        !isRecord(original) ||
        original.role !== "user" ||
        stableJson(original) === stableJson(returnedMessages[index]),
    );
  const candidateMessages = aligned && usersPreserved ? returnedMessages : undefined;
  const inputChars = messageChars(fallbackMessages);
  const charsDelta = candidateMessages ? inputChars - messageChars(candidateMessages) : 0;
  const charsSaved = Math.max(0, charsDelta);
  const accepted = tokenReduced && charsDelta > 0 && candidateMessages !== undefined;
  const messages: unknown[] = accepted ? candidateMessages : fallbackMessages;
  const transformsCandidate = source.transforms_applied ?? source.transformsApplied;
  const transformsApplied: unknown[] = Array.isArray(transformsCandidate)
    ? transformsCandidate
    : [];
  return {
    messages,
    tokensBefore: before,
    tokensAfter: after,
    tokensSaved: saved,
    charsSaved,
    compressionRatio: before > 0 ? after / before : 1,
    transformsApplied,
    transformsSummary: source.transforms_summary ?? source.transformsSummary,
    ccrHashes: Array.isArray(ccrHashes) ? ccrHashes : [],
    compressed: accepted,
  };
}

export function isBeneficialCompressionResult(
  result: CompressionResult | null | undefined,
): result is CompressionResult {
  return Boolean(
    result?.compressed &&
      result.tokensBefore > 0 &&
      result.tokensAfter >= 0 &&
      result.tokensAfter < result.tokensBefore &&
      result.tokensSaved === result.tokensBefore - result.tokensAfter &&
      result.charsSaved > 0,
  );
}
