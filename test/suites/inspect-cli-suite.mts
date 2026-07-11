import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createPackage } from "@electron/asar";
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

type FileSnapshot = {
  sha256: string;
  size: number;
  mtimeMs: number;
};

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
  await createPackage(asarSource, appAsar);
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

function parseReport(stdout: string): Record<string, any> {
  return JSON.parse(stdout) as Record<string, any>;
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
  assert.equal(invalidReport.ok, false);
  assert.equal(invalidReport.error.code, "INVALID_ARGUMENTS");
  assert.equal(invalidReport.error.stage, "arguments");

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
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.ok, true);
    assert.equal(report.platform, "win32");
    assert.equal(report.scope.readOnly, true);
    assert.equal(report.scope.codexLaunched, false);
    assert.equal(report.scope.runtimeVerificationPerformed, false);
    assert.equal(report.scope.providerConfigurationInspected, false);
    assert.equal(report.package.name, "OpenAI.Codex");
    assert.equal(report.package.version, "26.707.3748.0");
    assert.equal(report.package.packageFamilyName, "OpenAI.Codex_codexfasttest");
    assert.equal(
      report.package.appUserModelId,
      "OpenAI.Codex_codexfasttest!App",
    );
    assert.equal(report.compatibility.source, "whitelist-signatures");
    assert.equal(report.compatibility.classification, "recorded-static-pass");
    assert.equal(report.compatibility.staticGatePassed, true);
    assert.equal(report.compatibility.runtimeVerificationRequired, true);
    assert.equal(report.compatibility.requiredTargetCount, 8);
    assert.equal(report.compatibility.verifiedTargetCount, 8);
    assert.equal(report.targets.length, 8);
    assert.equal(new Set(report.targets.map((target: any) => target.id)).size, 8);
    for (const target of report.targets) {
      assert.ok(target.label);
      assert.ok(target.archivePath);
      assert.ok(target.runtimePath);
      assert.match(target.contentSha256, /^[0-9a-f]{64}$/);
      assert.match(target.patchedContentSha256, /^[0-9a-f]{64}$/);
    }
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
    assert.equal(failureReport.ok, false);
    assert.equal(
      failureReport.error.code,
      "WINDOWS_RUNTIME_COMPATIBILITY_FAILED",
    );
    assert.equal(failureReport.error.stage, "compatibility");
    assert.match(failureReport.error.message, /GPT-5\.x model list/);
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
