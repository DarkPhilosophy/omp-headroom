import { expect, test } from "bun:test";
import headroomExtension from "../src/index.ts";

// OMP 17 exposes extension tools as deferred/discoverable devices by default,
// which removes them from the outbound provider payload. The compression and
// archive gates require `headroom_retrieve` to already be present in
// `payload.tools`, so that one tool MUST register as `essential` (top-level)
// or every compression fails closed and all counters stay at zero.

const fakeZod = new Proxy(function z() {}, {
  get: () => fakeZod,
  apply: () => fakeZod,
});

function registeredTools() {
  const tools = new Map();
  headroomExtension({
    zod: fakeZod,
    setLabel() {},
    logger: { warn() {} },
    on() {},
    registerTool(definition) {
      if (definition?.name) tools.set(definition.name, definition);
    },
    registerCommand() {},
    registerFlag() {},
  });
  return tools;
}

test("headroom_retrieve stays a top-level provider tool on deferred-tool hosts", () => {
  const tools = registeredTools();
  expect(tools.get("headroom_retrieve")?.loadMode).toBe("essential");
});

test("manual compress and stats tools stay discoverable", () => {
  const tools = registeredTools();
  expect(tools.get("headroom_compress")?.loadMode).toBeUndefined();
  expect(tools.get("headroom_stats")?.loadMode).toBeUndefined();
});

test("provider hook passes through untouched when the retrieve tool is absent", async () => {
  // Control arm for the archive gate: same archivable payload as the
  // archive-projection test, but WITHOUT headroom_retrieve in payload.tools.
  const handlers = new Map();
  headroomExtension({
    zod: fakeZod,
    setLabel() {},
    logger: { warn() {} },
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerFlag() {},
  });
  const prefix = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `archive-prefix-${index}${" ".repeat(2400)}`,
  }));
  const payload = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "system rules" },
      ...prefix,
      ...Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `live-tail-${index}`,
      })),
    ],
    tools: [{ type: "function", function: { name: "read_file" } }],
  };
  const ctx = {
    hasUI: true,
    model: { provider: "openai", id: "gpt-4o" },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "gate-negative-arm", getBranch: () => [] },
  };
  const output = await handlers.get("before_provider_request")({ payload }, ctx);
  expect(output).toBeUndefined();
});
