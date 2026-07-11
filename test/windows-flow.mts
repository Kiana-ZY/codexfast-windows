import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsSuite } from "./suites/windows-suite.mts";
import { runInspectCliSuite } from "./suites/inspect-cli-suite.mts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await runWindowsSuite(rootDir);
await runInspectCliSuite(rootDir);
