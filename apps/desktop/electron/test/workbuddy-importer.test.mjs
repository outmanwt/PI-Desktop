import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));
const { workbuddyImporter } = await import("../main/importers/workbuddy.ts");

async function withWorkBuddyHome(home, callback) {
  const previous = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = previous;
  }
}

test("scans and converts WorkBuddy JSONL with injected user context and tool records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbuddy-import-"));
  try {
    const projects = join(root, "projects", "encoded-project");
    await mkdir(projects, { recursive: true });
    const file = join(projects, "session-1.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "C:\\project" }),
        JSON.stringify({ type: "message", role: "user", timestamp: "2026-01-01T00:00:01Z", content: [{ type: "text", text: "<system-reminder>secret prompt</system-reminder><user_query>Fix the bug</user_query>" }] }),
        JSON.stringify({ type: "function_call", callId: "call-1", name: "read", arguments: "{\"path\":\"src/a.ts\"}" }),
        JSON.stringify({ type: "function_call_result", callId: "call-1", status: "completed", output: [{ type: "text", text: "file content" }] }),
        JSON.stringify({ type: "message", role: "assistant", timestamp: "2026-01-01T00:00:02Z", providerData: { model: "model-x" }, content: [{ type: "output_text", text: "Done" }] }),
        JSON.stringify({ type: "ai-title", aiTitle: "Fix the bug" }),
        "{malformed",
      ].join("\n"),
    );

    await withWorkBuddyHome(root, async () => {
      const summaries = await workbuddyImporter.scan();
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].title, "Fix the bug");
      assert.equal(summaries[0].model, "model-x");
      const imported = await workbuddyImporter.convert(summaries[0]);
      assert.equal(imported.session.id, "import-workbuddy-session-1");
      assert.equal(imported.session.projectPath, "C:\\project");
      assert.deepEqual(imported.messages.map((message) => [message.role, message.content]), [
        ["user", "Fix the bug"],
        ["tool", "file content"],
        ["assistant", "Done"],
      ]);
      assert.deepEqual(imported.messages[1].toolArgs, { path: "src/a.ts" });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not read persisted tool output outside the configured WorkBuddy root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbuddy-boundary-"));
  try {
    const projects = join(root, "projects", "encoded-project");
    const outside = join(root, "outside.txt");
    await mkdir(projects, { recursive: true });
    await writeFile(outside, "secret outside output");
    const file = join(projects, "session-2.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "message", role: "user", content: "hello" }),
        JSON.stringify({ type: "function_call_result", callId: "call-2", status: "completed", output: [{ type: "text", text: `<persisted-output>Full output saved to: ${outside}</persisted-output>` }] }),
      ].join("\n"),
    );

    await withWorkBuddyHome(root, async () => {
      const [summary] = await workbuddyImporter.scan();
      const imported = await workbuddyImporter.convert(summary);
      assert.equal(imported.messages.at(-1).content, `<persisted-output>Full output saved to: ${outside}</persisted-output>`);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
