import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Windows npm shim check skipped on non-Windows platform");
  process.exit(0);
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const packageVersion = JSON.parse(
  readFileSync(join(rootDir, "package.json"), "utf8"),
).version as string;
const testDir = mkdtempSync(join(tmpdir(), "codexfast-npm-shim-"));
const sourceRoot = mkdtempSync(join(tmpdir(), "codexfast-npm-source-"));
const sourceLink = join(sourceRoot, "codexfast-&-source");

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runWindowsCommand(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandLine = [command, ...args]
    .map(quotePowerShellLiteral)
    .join(" ");
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `& ${commandLine}; exit $LASTEXITCODE`,
  ], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
}

try {
  if (!existsSync(npmCli)) {
    throw new Error(`npm CLI was not found next to Node.js: ${npmCli}`);
  }
  symlinkSync(rootDir, sourceLink, "junction");
  writeFileSync(
    join(testDir, "package.json"),
    JSON.stringify({ private: true }, null, 2),
  );
  const install = spawnSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      sourceLink,
    ],
    {
      cwd: testDir,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (install.status !== 0) {
    throw new Error(
      `npm install failed (${install.status}): ${install.stderr || install.stdout}`,
    );
  }

  const shim = join(testDir, "node_modules", ".bin", "codexfast.cmd");
  if (!existsSync(shim)) {
    throw new Error(`npm did not generate the Windows shim: ${shim}`);
  }
  const shimSource = readFileSync(shim, "utf8");
  if (!shimSource.includes("codexfast")) {
    throw new Error("Generated codexfast.cmd does not reference the package CLI.");
  }

  const version = runWindowsCommand(shim, ["version"], testDir);
  if (
    version.status !== 0 ||
    version.stdout.trim() !== `codexfast ${packageVersion}`
  ) {
    throw new Error(
      `Generated codexfast.cmd failed: ${version.stderr || version.stdout}`,
    );
  }

  const missingBundle = join(
    testDir,
    "Program Files",
    "WindowsApps",
    "OpenAI.Codex_26.707.3748.0_x64__codexfastshimtest",
  );
  const inspect = runWindowsCommand(
    shim,
    ["inspect", "--json"],
    testDir,
    {
      ...process.env,
      CODEXFAST_APP_BUNDLE: missingBundle,
      CODEXFAST_APP_EXECUTABLE: "app\\ChatGPT.exe",
      CODEXFAST_APP_USER_MODEL_ID: "OpenAI.Codex_codexfastshimtest!App",
    },
  );
  if (inspect.status !== 1 || inspect.stderr) {
    throw new Error(
      `Generated codexfast.cmd inspect failure path was not clean: ${inspect.stderr || inspect.stdout}`,
    );
  }
  let inspectReport: { ok?: boolean; error?: { code?: string } };
  try {
    inspectReport = JSON.parse(inspect.stdout);
  } catch (error) {
    throw new Error(
      `Generated codexfast.cmd did not preserve inspect --json arguments: ${String(error)}\n${inspect.stdout}`,
    );
  }
  if (
    inspectReport.ok !== false ||
    inspectReport.error?.code !== "WINDOWS_APP_DISCOVERY_FAILED"
  ) {
    throw new Error(
      `Generated codexfast.cmd returned an unexpected inspect report: ${inspect.stdout}`,
    );
  }
  console.log(`Windows npm shim check passed: codexfast ${packageVersion}`);
} finally {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
}
