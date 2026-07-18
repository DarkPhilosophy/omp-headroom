import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Responses aggregate tool-output compression", () => {
  test("batches individually-small outputs and persists each retrievable original", () => {
    const root = mkdtempSync(join(tmpdir(), "headroom-responses-batch-"));
    const repo = `${import.meta.dir}/..`;
    const script = `
      process.env.OMP_HEADROOM_BIN = process.argv[1] + "/venv/bin/headroom";
      const hashes = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(24));
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          requests++;
          const body = await request.json();
          let toolIndex = 0;
          const messages = body.messages.map((message) => {
            if (message.role !== "tool") return message;
            const index = toolIndex++;
            return {
              ...message,
              content: "[compressed " + index + ". Retrieve more: hash=" + hashes[index] + "]",
            };
          });
          return Response.json({
            messages,
            tokens_before: 4000,
            tokens_after: 400,
            tokens_saved: 3600,
            ccr_hashes: [],
          });
        },
      });
      process.env.OMP_HEADROOM_URL = "http://127.0.0.1:" + server.port;
      const { compressResponsesPayload } = await import(process.argv[2] + "/src/index.ts");
      const originals = Array.from({ length: 4 }, (_, call) =>
        Array.from({ length: 70 }, (_, line) =>
          "build " + line + ": module=" + call + " status=success diagnostic=context-preserved"
        ).join("\\n")
      );
      if (!originals.every((output) => output.length < 12000)) process.exit(10);
      if (originals.reduce((total, output) => total + output.length, 0) < 12000) process.exit(11);
      const payload = {
        model: "test",
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [{ type: "function", name: "headroom_retrieve" }],
          },
          ...originals.map((output, index) => ({
            type: "function_call_output",
            call_id: "call_" + index,
            output,
          })),
        ],
      };
      const state = {
        sessionId: "responses-batch-fidelity",
        tokensSaved: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        providerCompressions: 0,
        toolCompressions: 0,
        ccrHashes: 0,
      };
      const result = await compressResponsesPayload(payload, { hasUI: true }, state);
      await server.stop(true);
      if (requests !== 1) process.exit(2);
      const outputs = result.input.filter((item) => item.type === "function_call_output");
      if (outputs.length !== originals.length) process.exit(3);
      const fs = require("node:fs"), path = require("node:path");
      for (let index = 0; index < outputs.length; index++) {
        if (!outputs[index].output.includes("hash=" + hashes[index])) process.exit(4);
        const file = path.join(
          process.argv[1],
          "headroom-ccr",
          "responses-batch-fidelity",
          hashes[index] + ".txt",
        );
        if (!fs.existsSync(file)) process.exit(5);
        if (fs.readFileSync(file, "utf8") !== originals[index]) process.exit(6);
      }
      if (state.providerCompressions !== 1) process.exit(7);
      if (state.ccrHashes !== originals.length) process.exit(8);
      if (state.tokensSaved !== 3600) process.exit(9);
    `;
    const result = spawnSync("bun", ["-e", script, root, repo], { encoding: "utf8" });
    try {
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
