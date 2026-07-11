// Stable serialized size of provider message arrays.
import { stableJson } from "./util.ts";

// Captures every field (roles, content blocks, tool IDs), not only visible text.
// A result is accepted only when this size shrinks and proxy token counts prove
// a strict reduction.
export function messageChars(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  try {
    return stableJson(messages).length;
  } catch {
    return 0;
  }
}
