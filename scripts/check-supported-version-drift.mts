import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_APP_VERSIONS } from "../src/supported-app-versions.mts";
import { SUPPORTED_WINDOWS_APP_VERSIONS } from "../src/supported-windows-app-versions.mts";

type VersionBuild = {
  key: string;
  version: string;
  build: string;
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceVersions = Object.keys(SUPPORTED_APP_VERSIONS).map(parseVersionKey);
const windowsVersionKeys = Object.keys(SUPPORTED_WINDOWS_APP_VERSIONS);

function parseVersionKey(key: string): VersionBuild {
  const [version, build] = key.split("+");
  if (!version || !build) {
    throw new Error(`Invalid supported version key: ${key}`);
  }
  return { key, version, build };
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function parseCompatibilityMatrixKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\| `([^`]+)` \| `([^`]+)` \| `supported` \|/);
    if (match) {
      keys.add(`${match[1]}+${match[2]}`);
    }
  }
  return keys;
}

function assertSetEquals(name: string, actual: Set<string>, expected: Set<string>): void {
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  if (missing.length > 0) {
    console.error(`${name} is missing: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    console.error(`${name} has extra entries: ${extra.join(", ")}`);
  }
  process.exitCode = 1;
}

function assertReadmeMentions(path: string, versions: VersionBuild[]): void {
  const content = readRepoFile(path);
  for (const { key, version, build } of versions) {
    if (!content.includes(version) || !content.includes(build)) {
      console.error(`${path} does not mention supported build ${key}`);
      process.exitCode = 1;
    }
  }
}

const expectedKeys = new Set(sourceVersions.map((entry) => entry.key));
const matrixKeys = parseCompatibilityMatrixKeys(readRepoFile("docs/compatibility-matrix.md"));

assertSetEquals("docs/compatibility-matrix.md", matrixKeys, expectedKeys);
assertReadmeMentions("README.md", sourceVersions);
assertReadmeMentions("README.zh-CN.md", sourceVersions);

for (const path of ["README.windows.md", "docs/windows-compatibility.md"]) {
  const content = readRepoFile(path);
  for (const key of windowsVersionKeys) {
    const separatorIndex = key.lastIndexOf("+");
    const packageName = key.slice(0, separatorIndex);
    const version = key.slice(separatorIndex + 1);
    if (!packageName || !version || !content.includes(packageName) || !content.includes(version)) {
      console.error(`${path} does not mention supported Windows package ${key}`);
      process.exitCode = 1;
    }
  }
}

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log(
  `supported-version drift check passed (${sourceVersions.length} macOS builds, ${windowsVersionKeys.length} Windows package versions)`,
);
