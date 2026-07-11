import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectReport } from "../../src/cli-inspect.mts";
import { createFinishedAsar } from "../helpers/create-finished-asar.mts";

type FileSnapshot = {
  sha256: string;
  size: number;
  mtimeMs: number;
};

const inspectReportKeys = [
  "schemaVersion",
  "ok",
  "command",
  "tool",
  "platform",
  "scope",
  "selection",
  "package",
  "paths",
  "compatibility",
  "snapshots",
  "resourcePaths",
  "targets",
  "error",
] as const;

const expectedTargets = [
  ["speed-setting-destructured-option-count", "Speed setting", "windows-fast-targets.js"],
  ["speed-service-tier-allowance-26601", "Speed service tier allowance", "windows-fast-targets.js"],
  ["speed-service-tier-request-allowance-26707", "Speed service tier request allowance", "windows-fast-targets.js"],
  ["speed-service-tier-conversation-fallback-26707", "Speed service tier conversation fallback", "windows-fast-targets.js"],
  ["intelligence-speed-menu-options-boolean-code", "Composer Intelligence Speed menu", "windows-fast-targets.js"],
  ["service-tier-slash-command", "Fast slash command", "windows-fast-targets.js"],
  ["gpt5x-model-list-options", "GPT-5.x model list", "windows-model-targets.js"],
  ["gpt56-model-query-selector", "GPT-5.6 model query selector", "windows-model-targets.js"],
] as const;

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} keys changed without a schema-version update`,
  );
}

function snapshot(path: string): FileSnapshot {
  const stat = statSync(path);
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function inspectEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  delete environment.CODEXFAST_APP_BUNDLE;
  delete environment.CODEXFAST_APP_EXECUTABLE;
  delete environment.CODEXFAST_APP_USER_MODEL_ID;
  return { ...environment, ...overrides };
}

function runGeneratedCli(
  rootDir: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, [
    join(rootDir, "bin", "codexfast"),
    ...args,
  ], {
    cwd: rootDir,
    encoding: "utf8",
    env: environment,
  });
}

async function createFakeInspectPackage(
  rootDir: string,
  tempRoot: string,
  publisherId: string,
  includeModelTargets: boolean,
) {
  const packageDirectory =
    `OpenAI.Codex_26.707.3748.0_x64__${publisherId}`;
  const bundle = join(
    tempRoot,
    "Program Files",
    "WindowsApps",
    packageDirectory,
  );
  const resources = join(bundle, "app", "resources");
  const asarSource = join(tempRoot, `asar-source-${publisherId}`);
  const asarAssets = join(asarSource, "webview", "assets");
  mkdirSync(resources, { recursive: true });
  mkdirSync(asarAssets, { recursive: true });
  writeFileSync(
    join(bundle, "AppxManifest.xml"),
    readFileSync(
      join(rootDir, "test", "fixtures", "windows", "AppxManifest.xml"),
    ),
  );
  writeFileSync(join(bundle, "app", "ChatGPT.exe"), "fake executable");
  writeFileSync(join(bundle, "AppxSignature.p7x"), "fake signature");
  writeFileSync(join(asarSource, "webview", "index.html"), "<html></html>");
  writeFileSync(
    join(asarAssets, "windows-fast-targets.js"),
    readFileSync(
      join(rootDir, "test", "fixtures", "windows", "fast-targets.js"),
    ),
  );
  if (includeModelTargets) {
    writeFileSync(
      join(asarAssets, "windows-model-targets.js"),
      readFileSync(
        join(rootDir, "test", "fixtures", "windows", "model-targets.js"),
      ),
    );
  }
  const appAsar = join(resources, "app.asar");
  await createFinishedAsar(asarSource, appAsar);
  return {
    bundle,
    appAsar,
    appxManifest: join(bundle, "AppxManifest.xml"),
    appxSignature: join(bundle, "AppxSignature.p7x"),
    environment: inspectEnvironment({
      CODEXFAST_APP_BUNDLE: bundle,
      CODEXFAST_APP_EXECUTABLE: "app\\ChatGPT.exe",
      CODEXFAST_APP_USER_MODEL_ID: `OpenAI.Codex_${publisherId}!App`,
    }),
  };
}

function parseReport(stdout: string): InspectReport {
  return JSON.parse(stdout) as InspectReport;
}

export async function runInspectCliSuite(rootDir: string): Promise<void> {
  const invalid = runGeneratedCli(
    rootDir,
    ["inspect", "--json", "--bogus"],
    inspectEnvironment(),
  );
  assert.equal(invalid.status, 1, invalid.stderr || invalid.stdout);
  assert.equal(invalid.stderr, "");
  const invalidReport = parseReport(invalid.stdout);
  assertExactKeys(invalidReport, inspectReportKeys, "invalid report");
  assert.equal(invalidReport.ok, false);
  assert.equal(invalidReport.error.code, "INVALID_ARGUMENTS");
  assert.equal(invalidReport.error.stage, "arguments");

  const duplicateJson = runGeneratedCli(
    rootDir,
    ["inspect", "--json", "--json"],
    inspectEnvironment(),
  );
  assert.equal(
    duplicateJson.status,
    1,
    duplicateJson.stderr || duplicateJson.stdout,
  );
  assert.equal(duplicateJson.stderr, "");
  const duplicateJsonReport = parseReport(duplicateJson.stdout);
  assert.equal(duplicateJsonReport.ok, false);
  assert.equal(duplicateJsonReport.error.code, "INVALID_ARGUMENTS");
  assert.match(duplicateJsonReport.error.message, /at most once/);

  if (process.platform !== "win32") {
    const unsupported = runGeneratedCli(
      rootDir,
      ["inspect", "--json"],
      inspectEnvironment(),
    );
    assert.equal(unsupported.status, 1, unsupported.stderr || unsupported.stdout);
    assert.equal(unsupported.stderr, "");
    const report = parseReport(unsupported.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.error.code, "UNSUPPORTED_PLATFORM");
    console.log("generated inspect CLI suite passed");
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "codexfast-inspect-cli-"));
  try {
    const missing = runGeneratedCli(
      rootDir,
      ["inspect", "--json"],
      inspectEnvironment({
        CODEXFAST_APP_BUNDLE: join(
          tempRoot,
          "Program Files",
          "WindowsApps",
          "OpenAI.Codex_26.707.3748.0_x64__codexfastmissing",
        ),
        CODEXFAST_APP_EXECUTABLE: "app\\ChatGPT.exe",
        CODEXFAST_APP_USER_MODEL_ID: "OpenAI.Codex_codexfastmissing!App",
      }),
    );
    assert.equal(missing.status, 1, missing.stderr || missing.stdout);
    assert.equal(missing.stderr, "");
    const missingReport = parseReport(missing.stdout);
    assertExactKeys(missingReport, inspectReportKeys, "discovery failure report");
    assert.equal(missingReport.ok, false);
    assert.equal(missingReport.error.code, "WINDOWS_APP_DISCOVERY_FAILED");
    assert.equal(missingReport.error.stage, "discovery");
    assert.equal(missingReport.compatibility, null);
    assert.equal(missingReport.snapshots, null);
    assert.deepEqual(missingReport.resourcePaths, []);
    assert.deepEqual(missingReport.targets, []);

    const compatible = await createFakeInspectPackage(
      rootDir,
      tempRoot,
      "codexfasttest",
      true,
    );
    const compatibleSnapshots = {
      manifest: snapshot(compatible.appxManifest),
      asar: snapshot(compatible.appAsar),
      signature: snapshot(compatible.appxSignature),
    };
    const success = runGeneratedCli(
      rootDir,
      ["inspect", "--json"],
      compatible.environment,
    );
    assert.equal(success.status, 0, success.stderr || success.stdout);
    assert.equal(success.stderr, "");
    const report = parseReport(success.stdout);
    assertExactKeys(report, inspectReportKeys, "success report");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ok, true);
    assert.equal(report.command, "inspect");
    assert.equal(report.tool.name, "codexfast-windows");
    assert.ok(report.tool.version.length > 0);
    assert.equal(report.platform, "win32");
    assert.deepEqual(report.scope, {
      readOnly: true,
      codexLaunched: false,
      runtimeVerificationPerformed: false,
      providerConfigurationInspected: false,
    });
    assert.deepEqual(report.selection, {
      overrides: {
        bundle: true,
        executable: true,
        appUserModelId: true,
      },
    });
    assert.ok(report.package);
    assertExactKeys(report.package, [
      "name",
      "packageFullName",
      "version",
      "versionKey",
      "publisher",
      "packageFamilyName",
      "applicationId",
      "appUserModelId",
      "registrationVerified",
      "registeredInstallLocations",
    ], "package report");
    assert.equal(report.package.name, "OpenAI.Codex");
    assert.equal(
      report.package.packageFullName,
      "OpenAI.Codex_26.707.3748.0_x64__codexfasttest",
    );
    assert.equal(report.package.version, "26.707.3748.0");
    assert.equal(
      report.package.versionKey,
      "OpenAI.Codex+26.707.3748.0",
    );
    assert.equal(
      report.package.publisher,
      "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
    );
    assert.equal(report.package.packageFamilyName, "OpenAI.Codex_codexfasttest");
    assert.equal(report.package.applicationId, "App");
    assert.equal(
      report.package.appUserModelId,
      "OpenAI.Codex_codexfasttest!App",
    );
    assert.equal(report.package.registrationVerified, false);
    assert.ok(Array.isArray(report.package.registeredInstallLocations));
    assert.ok(report.paths);
    assert.deepEqual(report.paths, {
      bundle: compatible.bundle,
      resources: join(compatible.bundle, "app", "resources"),
      appxManifest: compatible.appxManifest,
      executable: join(compatible.bundle, "app", "ChatGPT.exe"),
      appAsar: compatible.appAsar,
    });
    assert.equal(report.compatibility.source, "whitelist-signatures");
    assert.equal(report.compatibility.classification, "recorded-static-pass");
    assert.match(
      report.compatibility.description,
      /runtime target patterns statically verified/,
    );
    assert.doesNotMatch(
      report.compatibility.description,
      /signatures verified/,
    );
    assert.equal(report.compatibility.staticGatePassed, true);
    assert.equal(report.compatibility.runtimeVerificationRequired, true);
    assert.equal(report.compatibility.requiredTargetCount, 8);
    assert.equal(report.compatibility.verifiedTargetCount, 8);
    assert.ok(report.snapshots);
    assert.deepEqual(report.snapshots, {
      appxManifest: {
        path: compatible.appxManifest,
        ...compatibleSnapshots.manifest,
      },
      appAsar: {
        path: compatible.appAsar,
        ...compatibleSnapshots.asar,
      },
      appxSignatureFile: {
        path: compatible.appxSignature,
        ...compatibleSnapshots.signature,
      },
    });
    assert.deepEqual(report.resourcePaths, [
      "assets/windows-fast-targets.js",
      "assets/windows-model-targets.js",
    ]);
    assert.equal(report.targets.length, 8);
    assert.equal(new Set(report.targets.map((target: any) => target.id)).size, 8);
    for (const [index, target] of report.targets.entries()) {
      const [id, label, resource] = expectedTargets[index];
      assertExactKeys(target, [
        "id",
        "label",
        "state",
        "archivePath",
        "runtimePath",
        "contentSha256",
        "patchedContentSha256",
      ], `target ${id}`);
      assert.equal(target.id, id);
      assert.equal(target.label, label);
      assert.equal(target.state, "guarded");
      assert.equal(target.archivePath, `webview/assets/${resource}`);
      assert.equal(target.runtimePath, `assets/${resource}`);
      assert.match(target.contentSha256, /^[0-9a-f]{64}$/);
      assert.match(target.patchedContentSha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(report.error, null);
    assert.deepEqual(
      {
        manifest: snapshot(compatible.appxManifest),
        asar: snapshot(compatible.appAsar),
        signature: snapshot(compatible.appxSignature),
      },
      compatibleSnapshots,
    );

    const human = runGeneratedCli(
      rootDir,
      ["inspect"],
      compatible.environment,
    );
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /Action: inspect/);
    assert.match(human.stdout, /Verified runtime target resources:/);
    assert.match(
      human.stdout,
      /Compatibility inspection completed without launching Codex\./,
    );

    const incompatible = await createFakeInspectPackage(
      rootDir,
      tempRoot,
      "codexfasttestbad",
      false,
    );
    const incompatibleSnapshots = {
      manifest: snapshot(incompatible.appxManifest),
      asar: snapshot(incompatible.appAsar),
      signature: snapshot(incompatible.appxSignature),
    };
    const failure = runGeneratedCli(
      rootDir,
      ["inspect", "--json"],
      incompatible.environment,
    );
    assert.equal(failure.status, 1, failure.stderr || failure.stdout);
    assert.equal(failure.stderr, "");
    const failureReport = parseReport(failure.stdout);
    assertExactKeys(failureReport, inspectReportKeys, "compatibility failure report");
    assert.equal(failureReport.ok, false);
    assert.equal(
      failureReport.error.code,
      "WINDOWS_RUNTIME_COMPATIBILITY_FAILED",
    );
    assert.equal(failureReport.error.stage, "compatibility");
    assert.match(failureReport.error.message, /GPT-5\.x model list/);
    assert.equal(failureReport.compatibility, null);
    assert.equal(failureReport.snapshots, null);
    assert.deepEqual(failureReport.resourcePaths, []);
    assert.ok(failureReport.package);
    assert.equal(failureReport.package.name, "OpenAI.Codex");
    assert.equal(failureReport.targets.length, 0);
    assert.deepEqual(
      {
        manifest: snapshot(incompatible.appxManifest),
        asar: snapshot(incompatible.appAsar),
        signature: snapshot(incompatible.appxSignature),
      },
      incompatibleSnapshots,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("generated inspect CLI suite passed");
}
