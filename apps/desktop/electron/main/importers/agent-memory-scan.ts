import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type MemorySourceKind = "workbuddy-user";

export type MemoryCandidate = {
  source: MemorySourceKind;
  sourcePath: string;
  id: string;
  title: string;
  content: string;
  bytes: number;
  updatedAt: string;
  warnings: string[];
};

export type MemorySourceReport = {
  kind: MemorySourceKind;
  path: string;
  exists: boolean;
  error?: string;
  count: number;
};

export type MemoryScanResult = {
  candidates: MemoryCandidate[];
  sources: MemorySourceReport[];
};

export type MemoryScanOptions = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

const MAX_MEMORY_BYTES = 32 * 1024;
const MAX_CANDIDATES = 128;

function workbuddyRoot(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.WORKBUDDY_HOME;
  return override && override.trim() ? override : path.join(home, ".workbuddy");
}

function titleFromMarkdown(text: string, fallback: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  return heading || fallback;
}

function idFromPath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return `workbuddy-${base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "memory"}`;
}

async function readCandidate(filePath: string): Promise<MemoryCandidate | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEMORY_BYTES) return null;
    const content = (await fs.readFile(filePath, "utf8")).trim();
    if (!content) return null;
    return {
      source: "workbuddy-user",
      sourcePath: filePath,
      id: idFromPath(filePath),
      title: titleFromMarkdown(content, path.basename(filePath, path.extname(filePath))),
      content,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      warnings: [],
    };
  } catch {
    return null;
  }
}

export async function scanExternalMemory(options: MemoryScanOptions = {}): Promise<MemoryScanResult> {
  const home = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const root = workbuddyRoot(home, env);
  const memoryDir = path.join(root, "memory");
  const report: MemorySourceReport = {
    kind: "workbuddy-user",
    path: root,
    exists: false,
    count: 0,
  };
  const candidates: MemoryCandidate[] = [];

  try {
    const rootStat = await fs.stat(root);
    report.exists = rootStat.isDirectory();
  } catch {
    return { candidates, sources: [report] };
  }

  const files: string[] = [path.join(root, "MEMORY.md")];
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path.join(memoryDir, entry.name));
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") report.error = `${code ?? "ERR"}: unable to read memory directory`;
  }

  const seen = new Set<string>();
  for (const filePath of files.sort()) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const candidate = await readCandidate(filePath);
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    candidates.push(candidate);
  }
  report.count = candidates.length;
  return { candidates, sources: [report] };
}
