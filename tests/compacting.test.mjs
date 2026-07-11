import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test: proves the extension REGISTERS the session.compacting
// handler under the correct OMP event name and that invoking it returns an
// additive { context, preserveData } shape with NO raw compression markers,
// writing the original conversation to the CCR store.
//
// NONEMPTY handler invocations run ONLY in an isolated child process whose
// OMP_HEADROOM_BIN points at a temp root — so persistCcrByHash writes inside
// the temp CCR_DIR, never the user's real ~/.omp/agent/headroom-ccr. The
// parent process only checks registration + empty-message fail-closed (no
// persistence path reached).

const fakeZod = new Proxy(function z() {}, {
  get: () => fakeZod,
  apply: () => fakeZod,
});

function makeFakePi() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    zod: fakeZod,
    setLabel: () => {},
    logger: { warn: () => {} },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    registerTool: () => {},
    registerCommand: (name, opts) => {
      commands.set(name, opts);
    },
    registerFlag: () => {},
  };
  return { pi, handlers, commands };
}

const { default: headroomExtension } = await import("../src/index.ts");

describe("session.compacting wiring (hybrid headroom compaction)", () => {
  test('extension registers a handler for "session.compacting"', () => {
    const { pi, handlers } = makeFakePi();
    headroomExtension(pi);
    expect(handlers.has("session.compacting")).toBe(true);
    expect(typeof handlers.get("session.compacting")).toBe("function");
  });

  test("handler returns undefined (fail-closed) when there are no messages", async () => {
    // Empty messages → returns undefined BEFORE any CCR write (no persistence).
    const { pi, handlers } = makeFakePi();
    headroomExtension(pi);
    const handler = handlers.get("session.compacting");
    const result = await handler({ messages: [] }, { hasUI: true });
    expect(result).toBeUndefined();
  });

  test("vanilla OMP compaction does not activate Headroom archival", async () => {
    const { pi, handlers } = makeFakePi();
    headroomExtension(pi);
    const result = await handlers.get("session.compacting")(
      { messages: [{ role: "user", content: "ordinary OMP compaction" }] },
      { hasUI: true },
    );

    expect(result).toBeUndefined();
  });

  test("Headroom context carries a retrievable hash + CCR artifact (isolated child)", () => {
    // Isolated child: OMP_HEADROOM_BIN set before module load so the module-level
    // CCR_DIR resolves inside our temp root. bun -e exposes trailing args as
    // argv[1], argv[2], ... (argv[0] is the bun exe).
    // Exit codes: 0=ok, 2=no CCR file, 3=CCR file missing content,
    // 4=result shape wrong, 5=missing/unsafe retrieval guidance.
    const script = `
			process.env.OMP_HEADROOM_BIN = process.argv[1];
			const mod = await import(process.argv[2] + '/src/index.ts');
			const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
			const handlers = new Map(), commands = new Map();
			mod.default({ zod: fakeZod, setLabel(){}, logger:{warn(){}}, on:(e,h)=>handlers.set(e,h), registerTool(){}, registerCommand:(n,s)=>commands.set(n,s), registerFlag(){} });
			let r;
			const ctx = {
				hasUI: true,
				sessionManager: { getSessionId() { return 'test-session-archive'; } },
				ui: { setWidget(){}, setStatus(){}, notify(){} },
				compact: async () => {
					r = await handlers.get('session.compacting')(
						{ messages: [{role:'user',content:'fix src/app.ts:42'}] },
						ctx,
					);
				},
			};
			// /headroom compact is the ONLY path that arms Headroom CCR archival.
			await commands.get('headroom').handler('compact', ctx);
			if (!r || !Array.isArray(r.context) || r.context.length === 0) process.exit(4);
			if (!r.preserveData || r.preserveData.headroomArchived !== true) process.exit(4);
			if (typeof r.preserveData.headroomCcrHash !== 'string') process.exit(4);
			const hash = r.preserveData.headroomCcrHash;
			if (!r.context.some(line => line.includes('Retrieve more: hash=' + hash))) process.exit(5);
			if (r.context.some(line => /<ccr:|\\[\\d+ items compressed/.test(line))) process.exit(5);
			const fs = require('fs'), path = require('path');
			const ccrDir = path.join(path.dirname(path.dirname(path.dirname(process.argv[1]))), 'headroom-ccr');
			const file = path.join(ccrDir, 'test-session-archive', r.preserveData.headroomCcrHash + '.txt');
			if (!fs.existsSync(file)) process.exit(2);
			if (!fs.readFileSync(file,'utf8').includes('fix src/app.ts:42')) process.exit(3);
			process.stdout.write(r.preserveData.headroomCcrHash);
		`;
    const root = mkdtempSync(join(tmpdir(), "headroom-ccr-iso-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`; // tests/ → repo root (omp-headroom)
    const r = spawnSync("bun", ["-e", script, binPath, repo], { encoding: "utf8" });
    try {
      if (r.status !== 0)
        throw new Error(`child exited ${r.status}\n--- stderr ---\n${r.stderr || "(none)"}`);
      expect(r.stdout.length).toBe(24); // the hash
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* isolated test cleanup */
      }
    }
  });

  test("native and /headroom compactions increment only the OMP counter (isolated child)", () => {
    // Drive both paths through the registered handlers. The plain OMP path
    // never arms Headroom archival; /headroom compact does archive its full
    // source for CCR recovery, but that archive must not become an `arch`
    // widget counter (provider-path prefix archives own that counter).
    const script = `
			process.env.OMP_HEADROOM_BIN = process.argv[1];
			const mod = await import(process.argv[2] + '/src/index.ts');
			const fakeZod = new Proxy(function(){}, { get:()=>fakeZod, apply:()=>fakeZod });
			const handlers = new Map(), commands = new Map(); let widgets = [];
			mod.default({ zod: fakeZod, setLabel(){}, logger:{warn(){}}, on:(e,h)=>handlers.set(e,h), registerTool(){}, registerCommand:(n,s)=>commands.set(n,s), registerFlag(){} });
			const messages = [{role:'user',content:'retain src/app.ts:42 and issue H-17'},{role:'assistant',content:'noted'}];
			const ctx = {
				hasUI: true,
				sessionManager: { getSessionId() { return 'test-session-counters'; } },
				ui: { setWidget:(k,lines)=>{ widgets = lines || []; }, setStatus(){}, notify(){} },
				compact: async () => {
					const archive = await handlers.get('session.compacting')({ messages }, ctx);
					if (!archive?.preserveData?.headroomArchived) throw new Error('missing CCR archive result');
					await handlers.get('session_compact')({
						compactionEntry: { preserveData: archive.preserveData, summary: 'short summary' },
					}, ctx);
				},
			};
			await handlers.get('session_compact')({
				compactionEntry: { summary: 'plain OMP summary' },
			}, ctx);
			const plain = widgets.slice();
			await commands.get('headroom').handler('compact', ctx);
			process.stdout.write(JSON.stringify({ plain, headroom: widgets }));
		`;
    const root = mkdtempSync(join(tmpdir(), "headroom-compaction-counters-"));
    const binPath = join(root, "venv", "bin", "headroom");
    const repo = `${import.meta.dir}/..`;
    const r = spawnSync("bun", ["-e", script, binPath, repo], { encoding: "utf8" });
    try {
      if (r.status !== 0)
        throw new Error(`child exited ${r.status}\n--- stderr ---\n${r.stderr || "(none)"}`);
      const rendered = JSON.parse(r.stdout);
      const plainText = rendered.plain.join("\n");
      const headroomText = rendered.headroom.join("\n");
      expect(plainText).toContain("com 1");
      expect(plainText).not.toContain("arch ");
      expect(headroomText).toContain("com 2");
      expect(headroomText).not.toContain("arch ");
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* isolated test cleanup */
      }
    }
  });
});
