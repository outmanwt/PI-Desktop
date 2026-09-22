import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { access, readFile, readdir } from "node:fs/promises";
import type { RemoteHostSshProfile } from "@pi-desktop/shared";

const execFile = promisify(execFileCallback);
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const SAFE_VALUE = /^[^\0\r\n\t ]{1,512}$/;
const SAFE_ALIAS = /^[A-Za-z0-9._:@%+-]{1,128}$/;

type ParsedHost = {
  alias: string;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  configPath?: string;
};

function safeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_VALUE.test(trimmed) && !trimmed.startsWith("-") ? trimmed : undefined;
}

function safeAlias(value: unknown): string | undefined {
  const alias = safeValue(value);
  return alias && SAFE_ALIAS.test(alias) && !alias.includes("*") ? alias : undefined;
}

function parsePort(value: unknown): number | undefined {
  const text = safeValue(value);
  if (!text || !/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function parseHostLine(line: string): [string, string] | undefined {
  const match = line.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/);
  if (!match) return undefined;
  return [match[1].toLowerCase(), match[2].trim()];
}

/** Parse one already-expanded SSH config file without reading any key material. */
export function parseSshConfig(content: string, configPath?: string): RemoteHostSshProfile[] {
  const result = new Map<string, ParsedHost>();
  let current: ParsedHost | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "").replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const pair = parseHostLine(line);
    if (!pair) continue;
    const [key, rawValue] = pair;
    if (key === "host") {
      current = undefined;
      for (const token of rawValue.split(/\s+/)) {
        const alias = safeAlias(token);
        if (!alias || token.startsWith("!") || /[*?]/.test(token)) continue;
        current = result.get(alias) ?? { alias, configPath };
        if (!current.configPath && configPath) current.configPath = configPath;
        result.set(alias, current);
      }
      continue;
    }
    if (!current) continue;
    // SSH uses the first obtained value for most options. Preserve that
    // behavior while still allowing a later Host block to add missing fields.
    if (key === "hostname" && !current.host) current.host = safeValue(rawValue);
    else if (key === "user" && !current.user) current.user = safeValue(rawValue);
    else if (key === "port" && current.port === undefined) current.port = parsePort(rawValue);
    else if (key === "identityfile" && !current.identityFile) current.identityFile = safeValue(rawValue);
  }
  return [...result.values()].map(toProfile).filter((profile): profile is RemoteHostSshProfile => profile !== undefined);
}

function toProfile(parsed: ParsedHost): RemoteHostSshProfile | undefined {
  const alias = safeAlias(parsed.alias);
  if (!alias) return undefined;
  const host = safeValue(parsed.host) ?? alias;
  return {
    alias,
    host,
    ...(safeValue(parsed.user) ? { user: parsed.user } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
    ...(safeValue(parsed.identityFile) ? { identityFile: parsed.identityFile } : {}),
    ...(safeValue(parsed.configPath) ? { configPath: parsed.configPath } : {}),
  };
}

function hasGlob(value: string): boolean {
  return /[*?[]/.test(value);
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "");
}

async function expandInclude(pattern: string, sourcePath: string): Promise<string[]> {
  const expanded = pattern.replace(/^~/, homedir());
  const candidate = isAbsolute(expanded) ? expanded : join(homedir(), ".ssh", expanded);
  if (!hasGlob(candidate)) return [candidate];
  const rootMatch = candidate.match(/^[^*?[]*/)?.[0] ?? dirname(candidate);
  const root = rootMatch.endsWith("\\") || rootMatch.endsWith("/") ? rootMatch : dirname(rootMatch);
  const suffix = candidate.slice(root.length).replace(/^[/\\]/, "");
  const matcher = globRegex(suffix.replaceAll("\\", "/"));
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const relative = full.slice(root.length).replaceAll("\\", "/").replace(/^\//, "");
      if (entry.isFile() && matcher.test(relative)) files.push(full);
      else if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(full);
    }
  }
  await visit(root || dirname(sourcePath));
  return files.sort();
}

async function readConfigFiles(path: string, seen = new Set<string>(), count = { value: 0 }): Promise<string> {
  const normalized = resolve(path);
  if (seen.has(normalized) || count.value >= MAX_FILES) return "";
  seen.add(normalized);
  let content: string;
  try {
    await access(normalized);
    content = await readFile(normalized, "utf8");
  } catch {
    return "";
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return "";
  count.value += 1;
  const lines: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^include\s+(.*)$/i);
    if (!match) {
      lines.push(rawLine);
      continue;
    }
    for (const pattern of match[1].split(/\s+/)) {
      if (!pattern || pattern.startsWith("-")) continue;
      for (const included of await expandInclude(pattern, normalized)) {
        lines.push(await readConfigFiles(included, seen, count));
      }
    }
  }
  return lines.join("\n");
}

function parseSshG(output: string, profile: RemoteHostSshProfile): RemoteHostSshProfile {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^\s]+)\s+(.+)$/);
    if (match && !values.has(match[1].toLowerCase())) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const host = safeValue(values.get("hostname"));
  const user = safeValue(values.get("user"));
  const port = parsePort(values.get("port"));
  const identityFile = safeValue(values.get("identityfile"));
  return {
    ...profile,
    ...(host ? { host } : {}),
    ...(user ? { user } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

async function resolveWithSshG(profile: RemoteHostSshProfile, configPath: string): Promise<RemoteHostSshProfile> {
  try {
    const args = ["-G", "-F", configPath, profile.alias];
    const result = await execFile("ssh", args, { timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 });
    return parseSshG(result.stdout, profile);
  } catch {
    return profile;
  }
}

/** Scan the user's SSH config and return only safe, renderer-facing metadata. */
export async function scanSshConfig(): Promise<RemoteHostSshProfile[]> {
  const configPath = process.env.SSH_CONFIG_FILE?.trim() || join(homedir(), ".ssh", "config");
  const content = await readConfigFiles(configPath);
  if (!content) return [];
  const parsed = parseSshConfig(content, configPath);
  const resolved: RemoteHostSshProfile[] = [];
  for (const profile of parsed) resolved.push(await resolveWithSshG(profile, configPath));
  return resolved;
}

export function sshIdentityBasename(profile: RemoteHostSshProfile): string | undefined {
  return profile.identityFile ? basename(profile.identityFile) : undefined;
}
