import { spawn } from "node:child_process";
import process from "node:process";

const forwardedArgs = process.argv.slice(2);

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

function quoteForCmd(value) {
  const text = String(value);
  if (text.length === 0) return "\"\"";
  if (!/[\s"&|<>^%]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const builderArgs = ["exec", "electron-builder", ...args];
    // Node 24 rejects spawn("pnpm.cmd") with EINVAL. Resolve pnpm through
    // cmd.exe and pass one already-quoted command line (no shell:true).
    const child = process.platform === "win32"
      ? spawn(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", ["pnpm", ...builderArgs].map(quoteForCmd).join(" ")],
          { stdio: "inherit", windowsHide: true },
        )
      : spawn("pnpm", builderArgs, { stdio: "inherit" });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

if (target === "win") {
  await runBuilder([
    "--win",
    "nsis",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=installed",
  ]);
  await runBuilder([
    "--win",
    "zip",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=zip",
  ]);
} else {
  await runBuilder([
    `--${target}`,
    "--publish",
    "never",
    ...forwardedArgs,
  ]);
}
