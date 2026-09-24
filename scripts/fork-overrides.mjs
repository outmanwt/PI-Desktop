import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const owner = "outmanwt";
const repo = "PI-Desktop";
const releasesUrl = `https://github.com/${owner}/${repo}/releases/latest`;

const packagePath = path.join(root, "apps/desktop/package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const publish = packageJson.build?.publish;
if (!Array.isArray(publish) || publish.length === 0 || publish[0]?.provider !== "github") {
  throw new Error("Expected apps/desktop/package.json to define a GitHub publish target");
}
publish[0].owner = owner;
publish[0].repo = repo;
packageJson.homepage = `https://github.com/${owner}/${repo}`;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

const updaterPath = path.join(root, "apps/desktop/electron/main/updater.ts");
let updater = await readFile(updaterPath, "utf8");
const releaseUrlPattern = /export const RELEASES_URL = "[^"]+";/;
if (!releaseUrlPattern.test(updater)) {
  throw new Error("Expected RELEASES_URL in apps/desktop/electron/main/updater.ts");
}
updater = updater.replace(
  releaseUrlPattern,
  `export const RELEASES_URL = "${releasesUrl}";`,
);
await writeFile(updaterPath, updater, "utf8");
const sharedPath = path.join(root, "packages/shared/src/github-feedback.ts");
let shared = await readFile(sharedPath, "utf8");
const sharedRepoPattern = /export const GITHUB_REPO = "[^"]+";/;
if (!sharedRepoPattern.test(shared)) {
  throw new Error("Expected GITHUB_REPO in packages/shared/src/github-feedback.ts");
}
shared = shared.replace(sharedRepoPattern, `export const GITHUB_REPO = "${owner}/${repo}";`);
await writeFile(sharedPath, shared, "utf8");

const protocolPath = path.join(root, "packages/shared/src/protocol.ts");
let protocol = await readFile(protocolPath, "utf8");
if (!protocol.includes("remoteHostSshScan:")) {
  protocol = protocol.replace(
    'remoteHostBootstrap: "pi-desktop/remoteHost/bootstrap",',
    'remoteHostBootstrap: "pi-desktop/remoteHost/bootstrap",\n    remoteHostSshScan: "pi-desktop/remoteHost/sshScan",',
  );
}
if (!protocol.includes("memoryImportScan:")) {
  protocol = protocol.replace(
    'skillImportRun: "pi-desktop/skill/importRun",',
    'skillImportRun: "pi-desktop/skill/importRun",\n    memoryImportScan: "pi-desktop/memory/importScan",\n    memoryImportRun: "pi-desktop/memory/importRun",',
  );
}
await writeFile(protocolPath, protocol, "utf8");

for (const relativePath of [
  "apps/desktop/test/remote-host-pi-host-release.test.mjs",
  "apps/desktop/test/remote-host-ssh-bootstrap.test.mjs",
  "apps/desktop/test/remote-host-bootstrap-script.test.mjs",
]) {
  const testFile = path.join(root, relativePath);
  const source = await readFile(testFile, "utf8");
  const rewritten = source.replaceAll(
    "https://github.com/vastsa/PI-Desktop/releases/download/",
    `https://github.com/${owner}/${repo}/releases/download/`,
  );
  await writeFile(testFile, rewritten, "utf8");
}

for (const relativePath of ["README.md", "README.zh-CN.md"]) {
  const readmePath = path.join(root, relativePath);
  const readme = await readFile(readmePath, "utf8");
  const rewritten = readme
    .replaceAll("https://img.shields.io/github/v/release/vastsa/PI-Desktop", `https://img.shields.io/github/v/release/${owner}/${repo}`)
    .replaceAll("https://img.shields.io/github/downloads/vastsa/PI-Desktop", `https://img.shields.io/github/downloads/${owner}/${repo}`)
    .replaceAll("https://github.com/vastsa/PI-Desktop/releases/latest", releasesUrl)
    .replaceAll(
      "https://github.com/vastsa/PI-Desktop/releases",
      `https://github.com/${owner}/${repo}/releases`,
    );
  await writeFile(readmePath, rewritten, "utf8");
}

const testPath = path.join(root, "apps/desktop/test/auto-update.test.mjs");
let test = await readFile(testPath, "utf8");
test = test.replace(
  /\/github\\\.com\\\/[^/]+\\\/PI-Desktop\\\/releases\//,
  `/github\\.com\\/${owner}\\/PI-Desktop\\/releases/`,
);
test = test.replace(
  /assert\.equal\(pkg\.build\.publish\[0\]\.owner, "[^"]+"\);/,
  `assert.equal(pkg.build.publish[0].owner, "${owner}");`,
);
if (!test.includes(`pkg.build.publish[0].owner, "${owner}"`)) {
  throw new Error("Could not update the updater owner contract test");
}
await writeFile(testPath, test, "utf8");

const localesDir = path.join(root, "packages/i18n/src/locales");
try {
  const localeDirs = await readdir(localesDir, { withFileTypes: true });
  for (const entry of localeDirs) {
    if (!entry.isDirectory()) continue;
    const localeFile = path.join(localesDir, entry.name, "index.ts");
    try {
      let content = await readFile(localeFile, "utf8");
      if (content.includes("remoteHosts: {") && !content.includes("sshProfiles:")) {
        content = content.replace(
          "remoteHosts: {",
          `remoteHosts: {\n      sshProfiles: "SSH config",\n      scanningSsh: "Scanning…",\n      scanSsh: "Scan SSH config",\n      sshConnect: "Install & connect",\n      noSshProfiles: "No SSH host aliases found.",`,
        );
      }
      if (!content.includes("importAgentScanSourceWorkBuddy:")) {
        content = content.replace(
          /importAgentScanSourceClaudeProject:\s*"[^"]*",/,
          `importAgentScanSourceClaudeProject: "Claude project",\n    importAgentScanSourceWorkBuddy: "WorkBuddy",\n    settingsImportMemoryKeys: "Memory",\n    importMemoryDesc: "Import WorkBuddy Markdown memory into the selected project. Existing entries are preserved and duplicate content is skipped.",\n    importMemoryTarget: "Target project: {{path}}",\n    importMemoryFound: "Found {{count}} memory files",\n    importMemoryResult: "Memory import done: {{imported}} imported, {{skipped}} skipped, {{failed}} failed",\n    importMemorySourceWorkBuddy: "WorkBuddy",\n    importMemory: "Memory",`,
        );
      }
      if (!content.includes("importSourceWorkBuddy:")) {
        content = content.replace(
          /importSourcePi:\s*"[^"]*",/,
          `importSourcePi: "Pi",\n    importSourceWorkBuddy: "WorkBuddy",`,
        );
      }
      await writeFile(localeFile, content, "utf8");
    } catch {}
  }
} catch {}

const remoteHostsPagePath = path.join(root, "apps/desktop/src/components/settings/RemoteHostsPage.tsx");
try {
  let content = await readFile(remoteHostsPagePath, "utf8");
  let modified = false;
  if (!content.includes('import { SshProfilesPanel } from "./SshProfilesPanel";')) {
    content = content.replace(
      'import { api } from "../../lib/api";',
      'import { api } from "../../lib/api";\nimport { SshProfilesPanel } from "./SshProfilesPanel";',
    );
    modified = true;
  }
  if (!content.includes("<SshProfilesPanel onConnected={refresh} />")) {
    content = content.replace(
      '<section className="settings-card-block">',
      '<SshProfilesPanel onConnected={refresh} />\n      <section className="settings-card-block">',
    );
    modified = true;
  }
  if (modified) {
    await writeFile(remoteHostsPagePath, content, "utf8");
  }
} catch {}

console.log(`Fork overrides applied: ${owner}/${repo}`);
