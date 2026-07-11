import { describe, expect, test } from "bun:test";

import { localCompressionLine } from "../src/index.ts";

describe("widget savings formatting", () => {
  test("keeps archive count beside abbreviated archive savings", () => {
    expect(
      localCompressionLine({
        sessionId: "session-1",
        stats: {
          savings: {
            per_project: {
              "session-1": {
                tokens_saved: 11_214_666,
                savings_percent: 2.9,
              },
            },
          },
        },
        tokensSaved: 0,
        tokensBefore: 0,
        sessionArchiveCharsBefore: 301_489,
        sessionArchiveCharsSaved: 283_400,
        sessionArchiveCompactions: 3,
      }),
    ).toBe("saved 11.2M · proxy 2.9% · arch 283.4kch ×3");
  });

  test("uses billions instead of expanding to thousands of millions", () => {
    expect(
      localCompressionLine({
        sessionId: "",
        stats: undefined,
        tokensSaved: 1_234_567_890,
        tokensBefore: 2_000_000_000,
        sessionArchiveCharsSaved: 0,
      }),
    ).toBe("saved 1.2B · 62%");
  });
});
