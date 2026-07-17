import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGeneratedCliSuite } from "./suites/generated-cli-suite.mts";
import { runInspectCliSuite } from "./suites/inspect-cli-suite.mts";
import { runRuntimePatchSuite } from "./suites/runtime-patch-suite.mts";
import { runWindowsSuite } from "./suites/windows-suite.mts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform === "darwin") {
  await import("./runtime-launch-flow.mts");
} else {
  runGeneratedCliSuite(rootDir);
  runRuntimePatchSuite();
}

await runWindowsSuite(rootDir);
await runInspectCliSuite(rootDir);
console.log("cross-platform test flow passed");
