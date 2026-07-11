import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyOpenAiCompressionResult, normalizeCompressionResult } from "../src/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN-FIDELITY CONTRACT
//
// The extension MUST reduce tokens, NEVER increase them, and keep user prose
// verbatim. `normalizeCompressionResult` is the single gate all provider paths
// funnel through, so these deterministic edge cases (synthetic proxy responses)
// pin the guarantee without a live proxy.
// ─────────────────────────────────────────────────────────────────────────────

const bigAssistant = "assistant analysis detail ".repeat(400);

describe("token-fidelity — never increase tokens", () => {
  test("proxy reporting a token INCREASE is rejected even when strings look shorter", () => {
    const original = [
      { role: "user", content: "keep this instruction" },
      { role: "assistant", content: bigAssistant },
    ];
    // Proxy claims it "compressed" but reports MORE tokens out than in — the
    // hash markers are token-dense. This must never be accepted.
    const proxy = {
      tokens_before: 100,
      tokens_after: 140,
      messages: [
        { role: "user", content: "keep this instruction" },
        { role: "assistant", content: "[compressed]" },
      ],
    };
    const result = normalizeCompressionResult(proxy, original);
    expect(result.compressed).toBe(false);

    const payload = { model: "test", messages: original };
    expect(applyOpenAiCompressionResult(result, payload, false)).toBe(payload);
  });

  test("missing token metrics are rejected even when the payload is shorter", () => {
    const original = [{ role: "assistant", content: bigAssistant }];
    const result = normalizeCompressionResult(
      { messages: [{ role: "assistant", content: "short" }] },
      original,
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(original);
  });

  test("equal token counts are rejected because compression must reduce tokens", () => {
    const original = [{ role: "assistant", content: bigAssistant }];
    const result = normalizeCompressionResult(
      {
        tokens_before: 100,
        tokens_after: 100,
        messages: [{ role: "assistant", content: "short" }],
      },
      original,
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(original);
  });

  test("fractional token metrics are rejected as untrustworthy", () => {
    const original = [{ role: "assistant", content: bigAssistant }];
    const result = normalizeCompressionResult(
      {
        tokens_before: 100.5,
        tokens_after: 50.25,
        messages: [{ role: "assistant", content: "short" }],
      },
      original,
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(original);
  });

  test("a genuine reduction of non-user content is accepted", () => {
    const original = [
      { role: "user", content: "summarize the log" },
      { role: "assistant", content: bigAssistant },
    ];
    const proxy = {
      tokens_before: 4000,
      tokens_after: 1200,
      messages: [
        { role: "user", content: "summarize the log" },
        { role: "assistant", content: "short summary" },
      ],
    };
    const result = normalizeCompressionResult(proxy, original);
    expect(result.compressed).toBe(true);
    expect(result.charsSaved).toBeGreaterThan(0);
  });
});

describe("token-fidelity — user prose stays verbatim", () => {
  test("an unchanged user turn stays exact while non-user content shrinks", () => {
    const userText = "USER INSTRUCTION that must survive verbatim ".repeat(30);
    const original = [
      { role: "user", content: userText },
      { role: "assistant", content: bigAssistant },
    ];
    const proxy = {
      tokens_before: 5000,
      tokens_after: 900,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: "short" },
      ],
    };
    const result = normalizeCompressionResult(proxy, original);
    expect(result.messages[0].content).toBe(userText); // verbatim
    expect(result.messages[1].content).toBe("short"); // assistant compressed
    expect(result.compressed).toBe(true);
  });

  test("a proxy-mutated user turn rejects the whole result", () => {
    const original = [
      { role: "user", content: "keep this exact instruction" },
      { role: "assistant", content: bigAssistant },
    ];
    const result = normalizeCompressionResult(
      {
        tokens_before: 5000,
        tokens_after: 900,
        messages: [
          { role: "user", content: "changed instruction" },
          { role: "assistant", content: "short" },
        ],
      },
      original,
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(original);
  });

  test("a changed message count rejects the result because user alignment is unprovable", () => {
    const original = [
      { role: "user", content: "first" },
      { role: "assistant", content: bigAssistant },
      { role: "user", content: "last" },
    ];
    const result = normalizeCompressionResult(
      {
        tokens_before: 5000,
        tokens_after: 900,
        messages: [{ role: "assistant", content: "short" }],
      },
      original,
    );

    expect(result.compressed).toBe(false);
    expect(result.messages).toBe(original);
  });
  test("when only user turns were 'compressed', nothing is accepted (no real savings)", () => {
    const original = [
      { role: "user", content: "first user instruction ".repeat(50) },
      { role: "user", content: "second user instruction ".repeat(50) },
    ];
    // The proxy shortened user turns, so the whole response is rejected.
    const proxy = {
      messages: [
        { role: "user", content: "[c1]" },
        { role: "user", content: "[c2]" },
      ],
    };
    const result = normalizeCompressionResult(proxy, original);
    expect(result.messages[0].content).toBe(original[0].content);
    expect(result.messages[1].content).toBe(original[1].content);
    expect(result.compressed).toBe(false);
    expect(result.charsSaved).toBe(0);
  });
});

describe("token-fidelity — charsSaved reflects the real sent payload", () => {
  test("charsSaved measures the accepted payload with unchanged user turns", () => {
    const userText = "X".repeat(2000);
    const original = [
      { role: "user", content: userText },
      { role: "assistant", content: "Y".repeat(2000) },
    ];
    // Token metrics remain valid because the proxy did not mutate the user turn.
    const proxy = {
      tokens_before: 1000,
      tokens_after: 500,
      messages: [
        { role: "user", content: userText },
        { role: "assistant", content: "small" },
      ],
    };
    const result = normalizeCompressionResult(proxy, original);
    const expected = userText.length + 2000 - (userText.length + "small".length);
    expect(result.charsSaved).toBe(expected);
  });
});

describe("token-fidelity — fragment paths honor the shared token gate", () => {
  test("Responses keeps the original output when the proxy reports token growth", () => {
    const repo = `${import.meta.dir}/..`;
    const script = `
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.json();
          const messages = body.messages.map((message, index) =>
            index === body.messages.length - 1 ? { ...message, content: "short" } : message
          );
          return Response.json({ messages, tokens_before: 100, tokens_after: 140 });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      const { compressResponsesPayload } = await import(process.argv[1] + "/src/index.ts");
      const original = "tool output ".repeat(2000);
      const payload = {
        model: "test",
        input: [{ type: "function_call_output", call_id: "c1", output: original }],
      };
      const state = {
        sessionId: "",
        tokensSaved: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        providerCompressions: 0,
        toolCompressions: 0,
        ccrHashes: 0,
      };
      const result = await compressResponsesPayload(payload, { hasUI: true }, state);
      await server.stop(true);
      if (result.input[0].output !== original) process.exit(2);
      if (Array.isArray(result.tools) && result.tools.length > 0) process.exit(3);
    `;
    const result = spawnSync("bun", ["-e", script, repo], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  test("Responses rejects a token reduction that has no retrievable original", () => {
    const repo = `${import.meta.dir}/..`;
    const script = `
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.json();
          const messages = body.messages.map((message, index) =>
            index === body.messages.length - 1 ? { ...message, content: "short" } : message
          );
          return Response.json({
            messages,
            tokens_before: 1000,
            tokens_after: 100,
            ccr_hashes: ["!!!"],
          });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      const { compressResponsesPayload } = await import(process.argv[1] + "/src/index.ts");
      const original = "tool output ".repeat(2000);
      const payload = {
        model: "test",
        tools: [{ type: "function", name: "headroom_retrieve" }],
        input: [{ type: "function_call_output", call_id: "c1", output: original }],
      };
      const state = {
        sessionId: "",
        tokensSaved: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        providerCompressions: 0,
        toolCompressions: 0,
        ccrHashes: 0,
      };
      const result = await compressResponsesPayload(payload, { hasUI: true }, state);
      await server.stop(true);
      if (result.input[0].output !== original) process.exit(2);
    `;
    const result = spawnSync("bun", ["-e", script, repo], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  test("Responses applies compression only after persisting a retrievable original", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-response-fidelity-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`;
    const script = `
      process.env.OMP_HEADROOM_BIN = process.argv[1];
      const hash = "0123456789abcdef01234567";
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.json();
          const messages = body.messages.map((message, index) =>
            index === body.messages.length - 1
              ? { ...message, content: "[compressed. Retrieve more: hash=" + hash + "]" }
              : message
          );
          return Response.json({
            messages,
            tokens_before: 1000,
            tokens_after: 100,
            ccr_hashes: [hash],
          });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      const { compressResponsesPayload } = await import(process.argv[2] + "/src/index.ts");
      const original = "tool output ".repeat(2000);
      const payload = {
        model: "test",
        tools: [{ type: "function", name: "headroom_retrieve" }],
        input: [{ type: "function_call_output", call_id: "c1", output: original }],
      };
      const state = {
        sessionId: "response-fidelity",
        tokensSaved: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        providerCompressions: 0,
        toolCompressions: 0,
        ccrHashes: 0,
      };
      const result = await compressResponsesPayload(payload, { hasUI: true }, state);
      await server.stop(true);
      if (!result.input[0].output.includes("hash=" + hash)) process.exit(2);
      if (!result.tools?.some(tool => tool.name === "headroom_retrieve")) process.exit(3);
      const fs = require("node:fs"), path = require("node:path");
      const file = path.join(process.argv[3], "headroom-ccr", "response-fidelity", hash + ".txt");
      if (!fs.existsSync(file)) process.exit(4);
      if (fs.readFileSync(file, "utf8") !== original) process.exit(5);
    `;
    const result = spawnSync("bun", ["-e", script, binPath, repo, root], { encoding: "utf8" });
    try {
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("token-fidelity — holistic provider compression is retrieval-gated", () => {
  test("OpenAI passes through when a shorter proxy response has no CCR hash", () => {
    const repo = `${import.meta.dir}/..`;
    const script = `
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/livez") return Response.json({ status: "healthy" });
          const body = await request.json();
          const messages = body.messages.map((message, index) =>
            index === body.messages.length - 1 ? { ...message, content: "short" } : message
          );
          return Response.json({ messages, tokens_before: 1000, tokens_after: 100 });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      process.env.OMP_HEADROOM_MIN_PROVIDER_CHARS = "1";
      const mod = await import(process.argv[1] + "/src/index.ts");
      const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
      const handlers = new Map();
      mod.default({
        zod: fakeZod,
        setLabel(){},
        logger:{ warn(){} },
        on(event, handler){ handlers.set(event, handler); },
        registerTool(){},
        registerCommand(){},
        registerFlag(){},
      });
      const payload = {
        model: "test",
        tools: [{ type: "function", function: { name: "headroom_retrieve" } }],
        messages: [
          { role: "user", content: "keep this exact request" },
          { role: "assistant", content: "assistant context ".repeat(1000) },
        ],
      };
      const result = await handlers.get("before_provider_request")(
        { payload },
        {
          hasUI: true,
          model: { id: "test", provider: "openai" },
          ui: { setWidget(){}, setStatus(){}, notify(){} },
        },
      );
      await server.stop(true);
      if (result !== undefined) process.exit(2);
    `;
    const result = spawnSync("bun", ["-e", script, repo], { encoding: "utf8" });

    expect(result.status).toBe(0);
  });

  test("Anthropic never rewrites user content through a lossy holistic conversion", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-anthropic-fidelity-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`;
    const script = `
      process.env.OMP_HEADROOM_BIN = process.argv[1];
      process.env.OMP_HEADROOM_MIN_PROVIDER_CHARS = "1";
      const hash = "0123456789abcdef01234567";
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/livez") return Response.json({ status: "healthy" });
          const body = await request.json();
          const messages = body.messages.map((message, index) =>
            index === body.messages.length - 1
              ? { ...message, content: "[compressed. Retrieve more: hash=" + hash + "]" }
              : message
          );
          return Response.json({
            messages,
            tokens_before: 1000,
            tokens_after: 100,
            ccr_hashes: [hash],
          });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      const mod = await import(process.argv[2] + "/src/index.ts");
      const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
      const handlers = new Map();
      mod.default({
        zod: fakeZod,
        setLabel(){},
        logger:{ warn(){} },
        on(event, handler){ handlers.set(event, handler); },
        registerTool(){},
        registerCommand(){},
        registerFlag(){},
      });
      const userText = "keep this exact Anthropic request";
      const userContent = [{ type: "text", text: userText }, { type: "text", text: "" }];
      const payload = {
        model: "claude-test",
        system: "system",
        tools: [{ name: "headroom_retrieve", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: userContent },
          {
            role: "assistant",
            content: [{ type: "text", text: "assistant context ".repeat(1000) }],
          },
        ],
      };
      const result = await handlers.get("before_provider_request")(
        { payload },
        {
          hasUI: true,
          model: { id: "claude-test", provider: "anthropic" },
          ui: { setWidget(){}, setStatus(){}, notify(){} },
        },
      );
      await server.stop(true);
      if (JSON.stringify(result?.messages?.[0]?.content) !== JSON.stringify(userContent)) process.exit(2);
    `;
    const result = spawnSync("bun", ["-e", script, binPath, repo], { encoding: "utf8" });
    try {
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
