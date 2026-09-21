import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { scanExternalMemory } = await import("../main/importers/agent-memory-scan.ts");

test("scans WorkBuddy MEMORY.md and memory markdown files while ignoring backups and JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-scan-"));
  const home = join(root, "home");
  try {
    await mkdir(join(home, ".workbuddy", "memory"), { recursive: true });
    await writeFile(join(home, ".workbuddy", "MEMORY.md"), "# Global memory\n\nRemember the API boundary.\n");
    await writeFile(join(home, ".workbuddy", "memory", "abc_memory.md"), "# Project hint\n\nUse the staging project.\n");
    await writeFile(join(home, ".workbuddy", "memory", "abc_memory.md.bak"), "# Old\n\nDo not import this.\n");
    await writeFile(join(home, ".workbuddy", "memory", "session.jsonl"), "{\"content\":\"not memory\"}\n");

    const result = await scanExternalMemory({ homeDir: home, env: {} });
    assert.equal(result.sources[0].exists, true);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map((entry) => entry.title), ["Global memory", "Project hint"]);
    assert.ok(result.candidates.every((entry) => entry.source === "workbuddy-user"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WORKBUDDY_HOME overrides the default memory root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-override-"));
  try {
    const override = join(root, "custom");
    await mkdir(override, { recursive: true });
    await writeFile(join(override, "MEMORY.md"), "# Custom\n\nCustom memory.\n");
    const result = await scanExternalMemory({ homeDir: join(root, "home"), env: { WORKBUDDY_HOME: override } });
    assert.equal(result.sources[0].path, override);
    assert.equal(result.candidates[0].title, "Custom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
