import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySessionArchive,
  createResponsesSessionCompaction,
  createSessionCompaction,
  expandSessionArchiveText,
} from "../src/session-archive.ts";
import { truncateMiddle } from "../src/util.ts";
import { compactStatsLine, localCompressionLine } from "../src/widget.ts";

const explicitOptions = {
  liveMessages: 2,
  minPrefixChars: 1_000,
  minPrefixShare: 0.2,
  archiveMaxMessageChars: 900,
};

function archiveMessage(messages) {
  return messages.find(
    (message) =>
      typeof message?.content === "string" && message.content.includes("Retrieve more: hash="),
  );
}

function makeDefaultEligibleMessages() {
  const history = Array.from({ length: 35 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `stable-${index} `.repeat(280),
  }));
  const liveTail = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `live-tail-${index}`,
  }));
  return {
    messages: [
      { role: "system", content: "You are a careful coding assistant." },
      ...history,
      ...liveTail,
    ],
    liveTail,
  };
}

describe("automatic provider-path archive projection", () => {
  test("archives an eligible OpenAI message prefix while preserving the default 24-message live tail", async () => {
    const { messages, liveTail } = makeDefaultEligibleMessages();
    const originalChars = JSON.stringify(messages).length;
    const persisted = [];

    const result = await applySessionArchive(messages, {}, async (candidate) => {
      persisted.push(candidate);
      return true;
    });

    expect(result.compacted).toBe(true);
    expect(result.messages).not.toBe(messages);
    expect(JSON.stringify(result.messages).length).toBeLessThan(originalChars);

    const marker = archiveMessage(result.messages);
    expect(marker).toBeDefined();
    expect(marker.content).toContain("[Headroom session archive]");
    expect(marker.content).toMatch(/Retrieve more: hash=[0-9a-f]{24}/);
    expect(marker.content.length).toBeLessThan(result.originalText.length);

    expect(result.messages.slice(-liveTail.length)).toHaveLength(24);
    for (const [index, message] of liveTail.entries()) {
      expect(result.messages.at(-liveTail.length + index)).toBe(message);
    }

    expect(persisted).toHaveLength(1);
    expect(persisted[0].compacted).toBe(true);
    expect(JSON.stringify(persisted[0].messages).length).toBeLessThan(originalChars);
  });

  test("does not project or persist a too-small input", async () => {
    const messages = [
      { role: "user", content: "short request" },
      { role: "assistant", content: "short response" },
      { role: "user", content: "latest" },
    ];
    let persistCalls = 0;

    const result = await applySessionArchive(messages, explicitOptions, async () => {
      persistCalls += 1;
      return true;
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(persistCalls).toBe(0);
    expect(JSON.stringify(result.messages)).not.toContain("Retrieve more: hash=");
  });

  test("fails closed when CCR persistence rejects a beneficial projection", async () => {
    const messages = [
      { role: "system", content: "rules" },
      { role: "user", content: "old context ".repeat(800) },
      { role: "assistant", content: "old answer ".repeat(800) },
      { role: "user", content: "live question" },
      { role: "assistant", content: "live answer" },
    ];
    let persistenceAttempts = 0;
    let accountingUpdates = 0;

    const result = await applySessionArchive(messages, explicitOptions, async (candidate) => {
      persistenceAttempts += 1;
      expect(candidate.compacted).toBe(true);
      expect(JSON.stringify(candidate.messages).length).toBeLessThan(
        JSON.stringify(messages).length,
      );
      const persisted = false;
      if (persisted) accountingUpdates += 1;
      return persisted;
    });

    expect(result).toEqual({ compacted: false, reason: "persistence_failed", messages });
    expect(persistenceAttempts).toBe(1);
    expect(accountingUpdates).toBe(0);
  });

  test("fails closed when CCR persistence throws", async () => {
    const messages = [
      { role: "user", content: "old context ".repeat(800) },
      { role: "assistant", content: "old answer ".repeat(800) },
      { role: "user", content: "live question" },
      { role: "assistant", content: "live answer" },
    ];

    const result = await applySessionArchive(messages, explicitOptions, async () => {
      throw new Error("disk full");
    });

    expect(result).toEqual({ compacted: false, reason: "persistence_failed", messages });
  });
});

describe("archive boundary safety", () => {
  test("keeps Responses archive text valid when truncation meets an astral character", () => {
    const splitPair = `${"a".repeat(39)}😀${"b".repeat(240)}`;
    const result = createResponsesSessionCompaction(
      [
        { type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: splitPair }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "old answer ".repeat(80) }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "latest" }] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "latest answer" }],
        },
      ],
      {
        liveMessages: 2,
        minPrefixChars: 0,
        minPrefixShare: 0,
        archiveMaxMessageChars: 120,
      },
    );

    expect(result.compacted).toBe(true);
    const archive = result.input.find(
      (item) =>
        item?.type === "message" &&
        item?.role === "user" &&
        item?.content?.[0]?.text?.includes("[Headroom session archive]"),
    );
    const archiveText = archive?.content?.[0]?.text;
    expect(archiveText).toBeDefined();
    expect(archiveText.isWellFormed()).toBe(true);
  });

  test("repairs malformed UTF-16 even when no truncation is needed", () => {
    const result = truncateMiddle("before\uDB80after", 100);

    expect(result).toBe("before\uFFFDafter");
    expect(result.isWellFormed()).toBe(true);
  });

  test("keeps the suffix boundary on a complete astral character", () => {
    const splitPair = `${"a".repeat(199)}😀${"b".repeat(39)}`;
    const result = truncateMiddle(splitPair, 120);

    expect(result.isWellFormed()).toBe(true);
    expect(result).toEndWith(`😀${"b".repeat(39)}`);
  });

  test("never leaves an OpenAI Responses function call without its matching output", () => {
    const largeOutput = "tool output ".repeat(900);
    const input = [
      { type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old request ".repeat(900) }],
      },
      { type: "function_call", call_id: "c1", name: "search", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: largeOutput },
      { type: "function_call", call_id: "c2", name: "search", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "recent output" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "latest" }] },
    ];

    const result = createResponsesSessionCompaction(input, explicitOptions);
    expect(result.compacted).toBe(true);

    const liveCallIds = new Set(
      result.input.filter((item) => item.type === "function_call").map((item) => item.call_id),
    );
    const liveOutputIds = new Set(
      result.input
        .filter((item) => item.type === "function_call_output")
        .map((item) => item.call_id),
    );
    expect(liveCallIds).toEqual(liveOutputIds);
    expect(result.originalText).toContain("c1");
    expect(liveCallIds.has("c2")).toBe(true);
    expect(liveOutputIds.has("c2")).toBe(true);
  });

  test("expands a re-compacted archive chain through its CCR ancestor", () => {
    const first = createSessionCompaction(
      [
        { role: "system", content: "rules" },
        { role: "user", content: "first generation ".repeat(800) },
        { role: "assistant", content: "first answer ".repeat(800) },
        { role: "user", content: "live question" },
        { role: "assistant", content: "live answer" },
      ],
      explicitOptions,
    );
    expect(first.compacted).toBe(true);

    const firstMarker = archiveMessage(first.messages);
    expect(firstMarker).toBeDefined();
    const second = createSessionCompaction(
      [
        { role: "system", content: "rules" },
        firstMarker,
        { role: "user", content: "new stable context ".repeat(800) },
        { role: "assistant", content: "new stable answer ".repeat(800) },
        { role: "user", content: "latest question" },
        { role: "assistant", content: "latest answer" },
      ],
      explicitOptions,
    );
    expect(second.compacted).toBe(true);

    const expanded = expandSessionArchiveText(second.originalText, (hash) =>
      hash === first.hash ? first.originalText : "",
    );
    expect(expanded).toContain("first generation first generation");
    expect(expanded).toContain(`chained session archive hash=${first.hash}`);
  });
});

describe("archive widget accounting is independent of OMP compaction", () => {
  test("keeps the archive count beside savings and out of activity", () => {
    const state = {
      sessionId: "session-1",
      stats: undefined,
      providerCompressions: 0,
      toolCompressions: 0,
      ccrHashes: 0,
      sessionArchiveCompactions: 1,
      ompCompactions: 0,
      sessionArchiveCharsBefore: 100_000,
      sessionArchiveCharsAfter: 30_000,
      sessionArchiveCharsSaved: 70_000,
      tokensSaved: 0,
      tokensBefore: 0,
    };

    expect(compactStatsLine(state)).not.toContain("arch ");
    expect(compactStatsLine(state)).not.toContain("com ");
    expect(localCompressionLine(state)).toContain("arch 70.0kch ×1");
  });
});

describe("automatic archive integration", () => {
  test("real before_provider_request archives with proxy unavailable and updates only arch counters", () => {
    const script = `
      process.env.OMP_HEADROOM_BIN = process.argv[1];
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:1";
      process.env.OMP_HEADROOM_SESSION_COMPACTION = "1";
      const mod = await import(process.argv[2] + "/src/index.ts");
      const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
      const handlers = new Map();
      const registeredTools = new Map();
      let widgets = [];
      mod.default({
        zod: fakeZod,
        setLabel(){},
        logger:{warn(){}},
        on:(event, handler)=>handlers.set(event, handler),
        registerTool:(tool)=>{ if (tool && tool.name) registeredTools.set(tool.name, tool); },
        registerCommand(){},
        registerFlag(){},
      });
      const retrieveTool = registeredTools.get("headroom_retrieve");
      if (!retrieveTool) process.exit(2);
      const prefix = Array.from({ length: 50 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "archive-prefix-" + index + " ".repeat(2400),
      }));
      const messages = [
        { role: "system", content: "system rules" },
        ...prefix,
        ...Array.from({ length: 24 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: "live-tail-" + index,
        })),
      ];
      const payload = {
        model: "gpt-4o",
        messages,
        tools: [retrieveTool],
      };
      const ctx = {
        hasUI: true,
        model: { provider: "openai", id: "gpt-4o" },
        ui: {
          setWidget: (_key, lines) => { widgets = lines || []; },
          setStatus(){},
          notify(){},
        },
        sessionManager: { getSessionId: () => "archive-child" },
      };
      const output = await handlers.get("before_provider_request")({ payload }, ctx);
      if (!output || !Array.isArray(output.messages)) process.exit(3);
      const serialized = JSON.stringify(output.messages);
      if (!serialized.includes("[Headroom session archive]")) process.exit(4);
      const match = serialized.match(/Retrieve more: hash=([0-9a-f]{24})/);
      if (!match) process.exit(5);
      const fs = require("fs"), path = require("path");
      const ccrDir = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), "headroom-ccr");
      const ccrPath = path.join(ccrDir, "archive-child", match[1] + ".txt");
      if (!fs.existsSync(ccrPath)) process.exit(6);
      if (!fs.readFileSync(ccrPath, "utf8").includes("archive-prefix-0")) process.exit(7);
      const widgetText = JSON.stringify(widgets);
      if (!widgetText.includes("×1")) process.exit(8);
      if (!/arch [1-9][0-9]*(?:\\.[0-9]+)?[kMB]?ch ×1/.test(widgetText)) process.exit(9);
      if (widgetText.includes("com ")) process.exit(10);
      process.stdout.write("ok");
    `;
    const root = mkdtempSync(join(tmpdir(), "headroom-provider-archive-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`;
    const result = spawnSync("bun", ["-e", script, binPath, repo], { encoding: "utf8" });
    try {
      if (result.status !== 0) {
        throw new Error(
          `child exited ${result.status}\n--- stderr ---\n${result.stderr || "(none)"}`,
        );
      }
      expect(result.stdout).toBe("ok");
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* isolated test cleanup */
      }
    }
  });
});
