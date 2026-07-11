import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import headroomExtension, { normalizeCompressionResult } from "../src/index.ts";

const fakeZod = new Proxy(function z() {}, {
  get: () => fakeZod,
  apply: () => fakeZod,
});

function installExtension() {
  const commands = new Map();
  const handlers = new Map();
  headroomExtension({
    zod: fakeZod,
    setLabel() {},
    logger: { warn() {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool() {},
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    registerFlag() {},
  });
  return {
    command: commands.get("headroom"),
    input: handlers.get("input"),
    toolResult: handlers.get("tool_result"),
  };
}

function makeCommandContext(
  compact,
  { newSession = async () => ({ cancelled: false }), reload = async () => {} } = {},
) {
  const notifications = [];
  const previews = [];
  return {
    hasUI: true,
    compact,
    newSession,
    reload,
    ui: {
      setWidget() {},
      setStatus() {},
      notify(message, level) {
        notifications.push({ message, level });
      },
      custom(factory, options) {
        previews.push({ factory, options });
        return Promise.resolve(undefined);
      },
    },
    notifications,
    previews,
  };
}

test("does not rewrite automatic tool results in the visible transcript", () => {
  const { toolResult } = installExtension();

  expect(toolResult).toBeUndefined();
});
test("/headroom service warns when the action is unsupported", async () => {
  const { command } = installExtension();
  const ctx = makeCommandContext(async () => {});

  await command.handler("service nonsense", ctx);

  const warning = ctx.notifications.at(-1);
  expect(warning).toEqual(
    expect.objectContaining({
      level: "warn",
      message: expect.stringContaining("install"),
    }),
  );
  expect(warning?.message).toContain("uninstall");
  expect(warning?.message).toContain("status");
});

describe("/headroom compaction commands", () => {
  test("compact delegates the session boundary to OMP with Headroom CCR enabled", async () => {
    const { command } = installExtension();
    const calls = [];
    const ctx = makeCommandContext(async (options) => {
      calls.push(options);
    });

    await command.handler("compact", ctx);

    expect(calls).toEqual([undefined]);
    expect(ctx.notifications[0]).toEqual(
      expect.objectContaining({
        level: "info",
        message: "Headroom compaction started…",
      }),
    );
  });

  test("passes Headroom proxy compression markers through unchanged (no added branding)", () => {
    const hash = "0123456789abcdef01234567";
    const raw = `[245 items compressed to 17. Retrieve more: hash=${hash}]`;
    const result = normalizeCompressionResult(
      {
        messages: [{ role: "tool", content: raw }],
        tokens_before: 245,
        tokens_after: 17,
      },
      [{ role: "tool", content: "original content ".repeat(100) }],
    );

    expect(result.messages[0].content).toBe(raw);
    expect(result.messages[0].content).not.toContain("[Headroom CCR archive]");
  });

  test("reports a synchronous OMP compaction failure without crashing the command", async () => {
    const { command } = installExtension();
    const ctx = makeCommandContext(() => {
      throw new Error("native compaction unavailable");
    });

    await command.handler("compact", ctx);

    expect(ctx.notifications.at(-1)).toEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("native compaction unavailable"),
      }),
    );
  });

  test("delegates slash commands to OMP so command-only session APIs are available", () => {
    const { input } = installExtension();

    expect(input).toBeUndefined();
  });

  test("creates a Headroom Compress transcript only after the proxy returns a real compression", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-tool-test-"));
    const repo = `${import.meta.dir}/..`;
    const script = `
            process.env.HOME = process.argv[1];
            const server = Bun.serve({
                port: 0,
                fetch: async request => {
                    const url = new URL(request.url);
                    if (url.pathname === "/livez") {
                        return Response.json({ status: "healthy", version: "test" });
                    }
                    if (url.pathname !== "/v1/compress") return new Response("not found", { status: 404 });
                    const body = await request.json();
                    const messages = body.messages.map((message, index) =>
                        index === body.messages.length - 1
                            ? { ...message, content: "[245 items compressed to 17. Retrieve more: hash=0123456789abcdef01234567]" }
                            : message,
                    );
                    return Response.json({
                        messages,
                        tokens_before: 245,
                        tokens_after: 17,
                        tokens_saved: 228,
                        ccr_hashes: ["0123456789abcdef01234567"],
                    });
                },
            });
            process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
            const mod = await import(process.argv[2] + "/src/index.ts");
            const z = new Proxy(function(){}, { get: () => z, apply: () => z });
            const commands = new Map(), messages = [];
            mod.default({
                zod: z, setLabel(){}, logger: { warn() {} }, on(){}, registerTool(){},
                registerCommand(name, spec) { commands.set(name, spec); }, registerFlag(){},
            });
            const ctx = {
                hasUI: true,
                getContextUsage() { return { contextWindow: 128000, tokens: 0 }; },
                sessionManager: { getSessionId() { return "test-session-tool"; } },
                ui: { setWidget(){}, setStatus(){}, notify(message, level) { throw new Error(level + ": " + message); } },
                async newSession({ setup }) {
                    await setup({
                        appendMessage(message) { messages.push(message); return "entry-" + messages.length; },
                        setSessionName(){},
                    });
                    return { cancelled: false };
                },
                async reload() {},
            };
            await commands.get("headroom").handler("test tool", ctx);
            await server.stop(true);
            if (messages.length !== 2) throw new Error("expected an assistant call and a tool result");
            if (messages[0].content?.[0]?.name !== "headroom_compress") throw new Error(JSON.stringify(messages[0]));
            if (messages[1].toolName !== "headroom_compress") throw new Error(JSON.stringify(messages[1]));
            const text = messages[1].content?.[0]?.text || "";
            if (!text.includes('Retrieve more: hash=0123456789abcdef01234567')) {
                throw new Error(text);
            }
            if (text.includes('[Headroom CCR archive]')) {
                throw new Error('marker branding must not be added: ' + text);
            }
        `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script, root, repo], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (result.status !== 0)
        throw new Error(result.stderr || result.stdout || `child exited ${result.status}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seeds a native compaction entry without injecting Headroom markers into the summary", async () => {
    const { command } = installExtension();
    const messages = [];
    const compactions = [];
    const ctx = makeCommandContext(async () => {}, {
      newSession: async ({ setup }) => {
        await setup({
          appendMessage(message) {
            messages.push(message);
            return `entry-${messages.length}`;
          },
          appendCompaction(...args) {
            compactions.push(args);
            return "compaction-entry";
          },
          setSessionName() {},
        });
        return { cancelled: false };
      },
    });

    await command.handler("test compaction", ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ role: "user" }));
    expect(compactions).toHaveLength(1);
    expect(compactions[0][0]).not.toContain("[Headroom CCR archive]");
    expect(compactions[0][0]).not.toContain("Retrieve more: hash=");
    expect(ctx.previews).toHaveLength(0);
    expect(ctx.notifications).toHaveLength(0);
  });
  test("compact connects OMP compaction, CCR persistence, and its completion notice", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-compact-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`;
    const script = `
			process.env.OMP_HEADROOM_BIN = process.argv[1];
			delete process.env.OMP_HEADROOM_COMPACT_PROVIDER;
			const mod = await import(process.argv[2] + "/src/index.ts");
			const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
			const handlers = new Map(), commands = new Map(), notices = [];
			const ctx = {
				hasUI: true,
				sessionManager: { getSessionId() { return "test-session-compact"; } },
				ui: {
					setWidget(){}, setStatus(){},
					notify(message, level){ notices.push({ message, level }); },
				},
				async compact(options) {
					if (options !== undefined) throw new Error("compact must not receive options");
					const result = await handlers.get("session.compacting")(
						{ messages: [{ role: "user", content: "retain src/app.ts:42 and issue H-17" }] },
						ctx,
					);
					if (!result?.preserveData?.headroomArchived) throw new Error("missing CCR archive result");
				},
			};
			mod.default({
				zod: fakeZod, setLabel(){}, logger:{warn(){}},
				on(event, handler){ handlers.set(event, handler); },
				registerTool(){}, registerCommand(name, spec){ commands.set(name, spec); }, registerFlag(){},
			});
			await commands.get("headroom").handler("compact", ctx);
			const completion = notices.at(-1);
			const hash = completion?.message?.match(/^Headroom archive ready: ([a-f0-9]{24})\\.$/)?.[1];
			if (completion?.level !== "info" || !hash) throw new Error(JSON.stringify(notices));
			const fs = require("node:fs"), path = require("node:path");
			const archive = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), "headroom-ccr", "test-session-compact", hash + ".txt");
			if (!fs.existsSync(archive)) throw new Error("missing CCR artifact");
		`;
    const result = spawnSync("bun", ["-e", script, binPath, repo], { encoding: "utf8" });
    try {
      if (result.status !== 0)
        throw new Error(`child exited ${result.status}\\n${result.stderr || result.stdout}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
