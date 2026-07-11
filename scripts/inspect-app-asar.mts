import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage(): never {
  console.error(
    "Usage: pnpm exec tsx scripts/inspect-app-asar.mts <path-to-app.asar>",
  );
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath || inputPath === "--help" || inputPath === "-h") {
  usage();
}

const appAsar = resolve(inputPath);
if (!existsSync(appAsar) || !statSync(appAsar).isFile()) {
  console.error(`app.asar not found: ${appAsar}`);
  process.exit(1);
}

const packageRoot = dirname(dirname(dirname(appAsar)));
const expectedAppAsar = resolve(packageRoot, "app", "resources", "app.asar");
if (appAsar.toLowerCase() !== expectedAppAsar.toLowerCase()) {
  console.error(
    `Expected an MSIX app/resources/app.asar path, received: ${appAsar}`,
  );
  process.exit(1);
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedCli = join(rootDir, "bin", "codexfast");
if (!existsSync(generatedCli)) {
  console.error("Generated CLI not found. Run `pnpm build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [generatedCli, "inspect"], {
  cwd: rootDir,
  env: {
    ...process.env,
    CODEXFAST_APP_BUNDLE: packageRoot,
  },
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not run codexfast inspect: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
