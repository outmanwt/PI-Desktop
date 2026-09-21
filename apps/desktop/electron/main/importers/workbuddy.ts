import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionSummary,
  ImportedSession,
  ImportedUiMessage,
  SessionImporter,
} from "./types";
import { importedSessionId, toIso, truncateTitle } from "./types";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

interface WorkBuddyBlock {
  type?: string;
  text?: string;
}

interface WorkBuddyLine {
  type?: string;
  role?: string;
  timestamp?: number | string;
  cwd?: string;
  sessionId?: string;
  id?: string;
  parentId?: string;
  content?: string | WorkBuddyBlock[];
  callId?: string;
  name?: string;
  arguments?: string;
  status?: string;
  output?: WorkBuddyBlock | WorkBuddyBlock[];
  aiTitle?: string;
  providerData?: { model?: string };
}

const TEXT_BLOCKS = new Set(["text", "input_text", "output_text"]);
const INJECTED_BLOCK =
  /<(system-reminder|cb_summary|conversation_history_summary)\b[\s\S]*?<\/\1>/gi;
const UNCLOSED_BLOCK =
  /<(system-reminder|cb_summary|conversation_history_summary)\b[\s\S]*$/i;
const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/i;
const PERSISTED_OUTPUT = /<persisted-output>[\s\S]*?Full output saved to:\s*(\S+)/i;

function workbuddyProjectsDir(env: NodeJS.ProcessEnv): string {
  const root = env.WORKBUDDY_HOME?.trim();
  return root ? path.join(root, "projects") : path.join(os.homedir(), ".workbuddy", "projects");
}

async function readLines(filePath: string): Promise<WorkBuddyLine[]> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];
  const raw = await fs.readFile(filePath, "utf8");
  const out: WorkBuddyLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as WorkBuddyLine);
      }
    } catch {
      // Skip malformed records while preserving the rest of the transcript.
    }
  }
  return out;
}

function blockText(content: string | WorkBuddyBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => TEXT_BLOCKS.has(block.type ?? "") && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function stripInjected(text: string): string {
  const paired = text.replace(INJECTED_BLOCK, "");
  const query = paired.match(USER_QUERY);
  if (query) return query[1].trim();
  return paired.replace(UNCLOSED_BLOCK, "").trim();
}

function resultText(output: WorkBuddyBlock | WorkBuddyBlock[] | undefined): string {
  if (!output) return "";
  if (Array.isArray(output)) return blockText(output);
  return typeof output.text === "string" ? output.text.trim() : "";
}

function persistedPath(text: string): string | null {
  return text.match(PERSISTED_OUTPUT)?.[1] ?? null;
}

async function resolveResultText(
  output: WorkBuddyBlock | WorkBuddyBlock[] | undefined,
  projectsDir: string,
): Promise<string> {
  const text = resultText(output);
  const external = persistedPath(text);
  if (!external) return text;
  const root = path.resolve(projectsDir);
  const resolved = path.resolve(external);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return text;
  try {
    const full = await fs.readFile(resolved, "utf8");
    return full.trim() || text;
  } catch {
    return text;
  }
}

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isConversationLine(line: WorkBuddyLine): boolean {
  return line.type === "message" && (line.role === "user" || line.role === "assistant");
}

export const workbuddyImporter: SessionImporter = {
  source: "workbuddy",

  async scan(): Promise<ExternalSessionSummary[]> {
    const projectsDir = workbuddyProjectsDir(process.env);
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.readdir(projectsDir);
    } catch {
      return [];
    }
    const summaries: ExternalSessionSummary[] = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dirPath, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const lines = await readLines(filePath);
          const convo = lines.filter(isConversationLine);
          if (convo.length === 0) continue;
          const externalId = path.basename(file, ".jsonl");
          const aiTitle = lines.filter((line) => line.type === "ai-title" && line.aiTitle).at(-1)?.aiTitle;
          const firstUser = convo.find((line) => line.role === "user" && stripInjected(blockText(line.content)));
          const model = convo.find((line) => line.role === "assistant" && line.providerData?.model)?.providerData?.model ?? null;
          summaries.push({
            source: "workbuddy",
            externalId,
            title: truncateTitle(aiTitle ?? "") || truncateTitle(stripInjected(blockText(firstUser?.content))) || externalId,
            projectPath: lines.find((line) => line.cwd)?.cwd ?? null,
            model,
            createdAt: toIso(lines[0]?.timestamp),
            updatedAt: toIso(lines.at(-1)?.timestamp),
            messageCount: convo.length,
            filePath,
          });
        } catch {
          // Unreadable, oversized, or malformed files are omitted from the scan.
        }
      }
    }
    return summaries;
  },

  async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
    const projectsDir = workbuddyProjectsDir(process.env);
    const lines = await readLines(summary.filePath);
    const messages: ImportedUiMessage[] = [];
    const pendingTools = new Map<string, { name: string; args: unknown }>();

    for (const line of lines) {
      if (line.type === "function_call" && line.callId) {
        pendingTools.set(line.callId, { name: line.name ?? "tool", args: parseArgs(line.arguments) });
        continue;
      }
      if (line.type === "function_call_result" && line.callId) {
        const pending = pendingTools.get(line.callId);
        pendingTools.delete(line.callId);
        const text = await resolveResultText(line.output, projectsDir);
        const failed = line.status === "error" || line.status === "failed";
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          content: text,
          createdAt: toIso(line.timestamp),
          toolName: line.name ?? pending?.name,
          toolCallId: line.callId,
          toolStatus: failed ? "error" : "success",
          toolArgs: pending?.args,
          toolResult: text,
          isError: failed || undefined,
          status: "complete",
        });
        continue;
      }
      if (!isConversationLine(line)) continue;
      const createdAt = toIso(line.timestamp);
      const text = line.role === "user" ? stripInjected(blockText(line.content)) : blockText(line.content);
      if (!text) continue;
      messages.push({
        id: crypto.randomUUID(),
        role: line.role as "user" | "assistant",
        content: text,
        createdAt,
        ...(line.role === "assistant" ? { status: "complete" } : {}),
      });
    }

    return {
      session: {
        id: importedSessionId("workbuddy", summary.externalId),
        title: summary.title,
        projectPath: summary.projectPath,
        modelId: summary.model,
        providerId: null,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  },
};
