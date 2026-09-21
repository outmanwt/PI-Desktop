/**
 * Batch import handlers for third-party AI-tool skills, MCP servers, and memory.
 *
 * Scan handlers wrap the on-disk scanners in the importers directory and turn
 * failures into result rows. Run handlers replay candidates through host-owned
 * RPC one at a time so one bad entry never aborts the batch.
 */
import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import {
  scanExternalMcp,
  type McpCandidate,
  type McpScanResult,
  type McpSourceKind,
} from "../importers/agent-mcp-scan";
import {
  scanExternalMemory,
  type MemoryCandidate,
  type MemoryScanResult,
} from "../importers/agent-memory-scan";
import {
  scanExternalSkills,
  type SkillCandidate,
  type SkillScanResult,
  type SkillSourceKind,
} from "../importers/agent-skill-scan";
import type { IpcRegistrar } from "./types";

export type HostCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export type AgentImportIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  refreshUserMcp?: (projectPath?: string | null) => Promise<unknown>;
  currentWorkspacePath?: () => string | null;
};

export interface SkillImportRunItem {
  source: SkillSourceKind;
  sourcePath: string;
  shape: "file" | "dir";
  rootDir?: string;
  id: string;
  name: string;
  description?: string;
}

export interface SkillImportRunPayload {
  level: "global" | "project";
  projectPath?: string;
  mode?: "copy" | "link";
  items: SkillImportRunItem[];
}

export interface SkillImportRunResult {
  imported: Array<{ item: SkillImportRunItem; skill: unknown }>;
  skipped: Array<{ item: SkillImportRunItem; reason: string }>;
  failed: Array<{ item: SkillImportRunItem; error: string }>;
}

export interface McpImportRunItem {
  source: McpSourceKind;
  sourcePath: string;
  id: string;
  rawKey: string;
  label?: string;
  description?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpImportRunPayload {
  items: McpImportRunItem[];
}

export interface McpImportRunResult {
  imported: Array<{ item: McpImportRunItem; server: unknown }>;
  skipped: Array<{ item: McpImportRunItem; reason: string }>;
  failed: Array<{ item: McpImportRunItem; error: string }>;
}

export type MemoryImportRunItem = Pick<
  MemoryCandidate,
  "source" | "sourcePath" | "id" | "title" | "content"
>;

export type MemoryImportRunPayload = {
  projectPath: string;
  items: MemoryImportRunItem[];
};

export type MemoryImportRunResult = {
  imported: MemoryImportRunItem[];
  skipped: Array<{ item: MemoryImportRunItem; reason: "duplicate" }>;
  failed: Array<{ item: MemoryImportRunItem; error: string }>;
};

/** True when a host error message is the "same name/id already imported" case. */
function isExistsError(message: string): boolean {
  return /already exists/i.test(message);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function normalizeMemoryText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export async function runSkillImport(
  hostCall: HostCall,
  payload: SkillImportRunPayload,
): Promise<SkillImportRunResult> {
  const mode = payload.mode ?? "copy";
  const result: SkillImportRunResult = { imported: [], skipped: [], failed: [] };
  for (const item of payload.items) {
    const path = item.shape === "dir" ? item.rootDir ?? item.sourcePath : item.sourcePath;
    const params: Record<string, unknown> = {
      path,
      id: item.id,
      name: item.name,
      level: payload.level,
      mode,
      shape: item.shape,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(payload.projectPath !== undefined ? { projectPath: payload.projectPath } : {}),
    };
    try {
      const res = await hostCall<{ skill: unknown }>("skills.import", params);
      result.imported.push({ item, skill: res?.skill });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) result.skipped.push({ item, reason: "exists" });
      else result.failed.push({ item, error: message });
    }
  }
  return result;
}

export async function runMcpImport(
  hostCall: HostCall,
  payload: McpImportRunPayload,
): Promise<McpImportRunResult> {
  const result: McpImportRunResult = { imported: [], skipped: [], failed: [] };
  for (const item of payload.items) {
    const server: Record<string, unknown> = {
      id: item.id,
      transport: item.transport,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.command !== undefined ? { command: item.command } : {}),
      ...(item.args !== undefined ? { args: item.args } : {}),
      ...(item.env !== undefined ? { env: item.env } : {}),
      ...(item.url !== undefined ? { url: item.url } : {}),
      ...(item.headers !== undefined ? { headers: item.headers } : {}),
    };
    try {
      const res = await hostCall<{ server: unknown }>("mcp.upsert", { server });
      if (item.disabled === true) {
        try {
          await hostCall("mcp.setEnabled", { id: item.id, enabled: false });
        } catch (error) {
          result.failed.push({ item, error: describeError(error) });
          continue;
        }
      }
      result.imported.push({ item, server: res?.server });
    } catch (error) {
      const message = describeError(error);
      if (isExistsError(message)) result.skipped.push({ item, reason: "exists" });
      else result.failed.push({ item, error: message });
    }
  }
  return result;
}

export async function runMemoryImport(
  hostCall: HostCall,
  payload: MemoryImportRunPayload,
): Promise<MemoryImportRunResult> {
  const result: MemoryImportRunResult = { imported: [], skipped: [], failed: [] };
  const current = await hostCall<{
    memory?: { entries?: Array<{ id: string; title: string; content: string }> };
  }>("project.memory.get", { path: payload.projectPath });
  const entries = Array.isArray(current?.memory?.entries) ? [...current.memory.entries] : [];
  const existing = new Set(entries.map((entry) => normalizeMemoryText(entry.content)));
  for (const item of payload.items) {
    const content = normalizeMemoryText(item.content);
    if (!content || existing.has(content)) {
      result.skipped.push({ item, reason: "duplicate" });
      continue;
    }
    entries.push({ id: item.id, title: item.title, content });
    existing.add(content);
    result.imported.push(item);
  }
  if (result.imported.length > 0) {
    try {
      await hostCall("project.memory.set", { path: payload.projectPath, entries });
    } catch (error) {
      result.failed.push(...result.imported.map((item) => ({ item, error: describeError(error) })));
      result.imported = [];
    }
  }
  return result;
}

type ScanErrorReport = {
  candidates: [];
  sources: [{ kind: "error"; path: string; exists: false; error: string; count: 0 }];
};

function scanErrorReport(error: unknown): ScanErrorReport {
  return {
    candidates: [],
    sources: [{ kind: "error", path: "", exists: false, error: describeError(error), count: 0 }],
  };
}

export function registerAgentImportIpc({
  registrar,
  getHost,
  sendToRenderer,
  refreshUserMcp,
  currentWorkspacePath,
}: AgentImportIpcDependencies): void {
  registrar.handle(IPC.invoke.skillImportScan, async ({ projectPath }: { projectPath?: string } = {}) => {
    try {
      return await scanExternalSkills({ projectPath });
    } catch (error) {
      return scanErrorReport(error);
    }
  });

  registrar.handle(IPC.invoke.skillImportRun, async (payload: SkillImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await runSkillImport((method, params) => host.call(method, params), payload);
    if (result.imported.length) sendToRenderer(IPC.event.pluginChanged, { reason: "skill" });
    return result;
  });

  registrar.handle(IPC.invoke.mcpImportScan, async ({ projectPath }: { projectPath?: string } = {}) => {
    try {
      return await scanExternalMcp({ projectPath });
    } catch (error) {
      return scanErrorReport(error);
    }
  });

  registrar.handle(IPC.invoke.mcpImportRun, async (payload: McpImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const result = await runMcpImport((method, params) => host.call(method, params), payload);
    if (result.imported.length) {
      if (refreshUserMcp && currentWorkspacePath) await refreshUserMcp(currentWorkspacePath()).catch(() => undefined);
      sendToRenderer(IPC.event.pluginChanged, { reason: "mcp" });
    }
    return result;
  });

  registrar.handle(IPC.invoke.memoryImportScan, async () => {
    try {
      return await scanExternalMemory();
    } catch (error) {
      return scanErrorReport(error);
    }
  });

  registrar.handle(IPC.invoke.memoryImportRun, async (payload: MemoryImportRunPayload) => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    return runMemoryImport((method, params) => host.call(method, params), payload);
  });
}

export type {
  McpCandidate,
  McpScanResult,
  MemoryCandidate,
  MemoryScanResult,
  SkillCandidate,
  SkillScanResult,
};
