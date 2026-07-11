import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinishedAsar } from "../helpers/create-finished-asar.mts";
import { CdpConnection } from "../../src/cli-cdp.mts";
import { ReadOnlyAsarArchive } from "../../src/cli-asar.mts";
import { createCodexfastContext } from "../../src/cli-context.mts";
import {
  activateWindowsApplication,
  applicationActivationPowerShellSource,
  buildWindowsActivationArguments,
  checkWindowsCodexRunning,
  compileWindowsActivationHelper,
  compileWindowsProcessTerminationHelper,
  deriveAppUserModelId,
  launchWindowsCodexProcess,
  loadWindowsAppEnvironment,
  parseAppxManifest,
  parseWindowsPackageCandidates,
  parseTasklistCsv,
  parseWindowsAppsPackagePath,
  queryWindowsProcessIdentity,
  resolveWindowsPowerShell,
  sameWindowsProcessIdentity,
  snapshotWindowsCodexTasks,
  validateWindowsPackageIdentity,
  windowsActivationCommandLine,
  windowsProcessIdentityPowerShellSource,
  windowsProcessTerminationPowerShellSource,
  type WindowsCommandRunner,
  type WindowsPackageCandidate,
  type WindowsProcessIdentity,
} from "../../src/cli-platform-windows.mts";
import {
  runRuntimeLaunch,
  runtimePatchInitialResourcePathsForContext,
  startRuntimePatchSession,
} from "../../src/cli-runtime-launch.mts";
import {
  runtimePatcherSourceForWindows,
  runtimePatchWindowsRequiredInitialLabels,
} from "../../src/cli-runtime-profile.mts";
import { applyRuntimePatchesToResponseBodyWithSource } from "../../src/cli-runtime-patcher.mts";
import {
  applyWindowsRuntimeCompatibility,
  inspectWindowsRuntimeCompatibility,
  verifyWindowsRuntimeCompatibilitySnapshot,
} from "../../src/cli-windows-compatibility.mts";
import { applyRuntimePatchesToBody } from "../../src/patch-engine.mts";

function commandResult(
  status: number,
  stdout = "",
  stderr = "",
): { status: number; stdout: string; stderr: string } {
  return { status, stdout, stderr };
}

function processIdentityResult(
  identities: WindowsProcessIdentity[],
): { status: number; stdout: string; stderr: string } {
  return commandResult(0, JSON.stringify(identities.map((identity) => ({
    Pid: identity.pid,
    ProcessName: identity.processName,
    ExecutablePath: identity.executablePath,
    StartTimeUtc: identity.startTimeUtc,
    CommandLine: identity.commandLine ?? "",
  }))));
}

function filteredPatcherFixtureSource(): string {
  return String.raw`
const TARGET_SPECS = [
  {id: "speed-setting-destructured-option-count", label: "Speed setting", needle: "speed-setting-needle", guardedSignature: /SPEED_SETTING_DISABLED/, patchedSignature: /SPEED_SETTING_ENABLED/, legacyPatchedSignature: null, applyReplacement: "SPEED_SETTING_ENABLED"},
  {id: "speed-service-tier-allowance-26601", label: "Speed service tier allowance", needle: "standalone-allowance-needle", guardedSignature: /\bALLOWANCE_DISABLED\b/, patchedSignature: /\bALLOWANCE_ENABLED\b/, legacyPatchedSignature: null, applyReplacement: "ALLOWANCE_ENABLED"},
  {id: "speed-service-tier-request-allowance-26707", label: "Speed service tier request allowance", needle: "request-allowance-needle", guardedSignature: /REQUEST_ALLOWANCE_DISABLED/, patchedSignature: /REQUEST_ALLOWANCE_ENABLED/, legacyPatchedSignature: null, applyReplacement: "REQUEST_ALLOWANCE_ENABLED"},
  {id: "speed-service-tier-conversation-fallback-26707", label: "Speed service tier conversation fallback", needle: "fallback-needle", guardedSignature: /FALLBACK_DISABLED/, patchedSignature: /FALLBACK_ENABLED/, legacyPatchedSignature: null, applyReplacement: "FALLBACK_ENABLED"},
  {id: "intelligence-speed-menu-options-boolean-code", label: "Composer Intelligence Speed menu", needle: "intelligence-needle", guardedSignature: /INTELLIGENCE_DISABLED/, patchedSignature: /INTELLIGENCE_ENABLED/, legacyPatchedSignature: null, applyReplacement: "INTELLIGENCE_ENABLED"},
  {id: "service-tier-slash-command", label: "Fast slash command", needle: "slash-needle", guardedSignature: /SLASH_DISABLED/, patchedSignature: /SLASH_ENABLED/, legacyPatchedSignature: null, applyReplacement: "SLASH_ENABLED"},
  {id: "gpt5x-model-list-options", label: "GPT-5.x model list", needle: "model-list-needle", guardedSignature: /MODEL_LIST_DISABLED/, patchedSignature: /MODEL_LIST_ENABLED/, legacyPatchedSignature: null, applyReplacement: "MODEL_LIST_ENABLED"},
  {id: "gpt56-model-query-selector", label: "GPT-5.6 model query selector", needle: "selector-needle", guardedSignature: /SELECTOR_DISABLED/, patchedSignature: /SELECTOR_ENABLED/, legacyPatchedSignature: null, applyReplacement: "SELECTOR_ENABLED"}
];
function replaceContent(content, signature, replacement) {
  return content.replace(signature, replacement);
}
function replaceContentOrThrow(content, signature, replacement) {
  return replaceContent(content, signature, replacement);
}
function inspectSpec(content, spec) {
  if (!content.includes(spec.needle)) return null;
  const guarded = spec.guardedSignature.test(content);
  const patched = spec.patchedSignature.test(content);
  const legacyPatched = spec.legacyPatchedSignature?.test(content) ?? false;
  if (!guarded && !patched && !legacyPatched) return null;
  return {spec, guarded, patched, legacyPatched};
}
function applyRuntimePatchesToBody(_resourcePath, body) {
  return {content: body, matchedLabels: [], patchedLabels: [], alreadyPatchedLabels: []};
}`;
}

function windowsRuntimeContext() {
  const context = createCodexfastContext("", "win32");
  context.paths.bundle = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`;
  context.paths.resources = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\resources`;
  context.metadata.version = "26.707.3748.0";
  context.metadata.build = "MSIX";
  context.metadata.versionKey = "OpenAI.Codex+26.707.3748.0";
  context.metadata.compatibility = "supported; runtime target verification required";
  context.metadata.supported = true;
  context.metadata.packageName = "OpenAI.Codex";
  context.metadata.packageFamilyName = "OpenAI.Codex_2p2nqsd0c76g0";
  context.metadata.applicationId = "App";
  context.metadata.appUserModelId = "OpenAI.Codex_2p2nqsd0c76g0!App";
  context.paths.executable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`;
  context.toolchain.powershell = "powershell.exe";
  context.runtimeCompatibility.source = "whitelist-signatures";
  context.runtimeCompatibility.resourcePaths = [
    "assets/general-settings-Dtfq14Yt.js",
    "assets/use-service-tier-settings-uyaJ6nX6.js",
    "assets/read-service-tier-for-request-D2fynmwS.js",
    "assets/composer-Bt9Tt576.js",
    "assets/app-main-BEs0GGm0.js",
    "assets/model-queries-DYpQPsG6.js",
  ];
  return context;
}

function withWindowsAppOverridesCleared<T>(action: () => T): T {
  const keys = [
    "CODEXFAST_APP_BUNDLE",
    "CODEXFAST_APP_EXECUTABLE",
    "CODEXFAST_APP_USER_MODEL_ID",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;
  for (const key of keys) {
    delete process.env[key];
  }
  try {
    return action();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function createFakeMsix(
  root: string,
  packageFullName: string,
  manifestXml: string,
): string {
  const bundle = join(root, packageFullName);
  mkdirSync(join(bundle, "app", "resources"), { recursive: true });
  writeFileSync(join(bundle, "AppxManifest.xml"), manifestXml, "utf8");
  writeFileSync(join(bundle, "app", "ChatGPT.exe"), "fake executable", "utf8");
  writeFileSync(join(bundle, "app", "resources", "app.asar"), "fake asar", "utf8");
  writeFileSync(join(bundle, "AppxSignature.p7x"), "fake signature", "utf8");
  return bundle;
}

const adaptiveTargetFragments = [
  {
    id: "speed-setting-destructured-option-count",
    resource: "general-settings-NEW123.js",
    body: "speed-setting-needle SPEED_SETTING_DISABLED",
  },
  {
    id: "speed-service-tier-allowance-26601",
    resource: "use-service-tier-settings-NEW456.js",
    body: "standalone-allowance-needle ALLOWANCE_DISABLED",
  },
  {
    id: "speed-service-tier-request-allowance-26707",
    resource: "read-service-tier-for-request-NEW789.js",
    body: "request-allowance-needle REQUEST_ALLOWANCE_DISABLED",
  },
  {
    id: "speed-service-tier-conversation-fallback-26707",
    resource: "use-service-tier-settings-NEW456.js",
    body: "fallback-needle FALLBACK_DISABLED",
  },
  {
    id: "intelligence-speed-menu-options-boolean-code",
    resource: "composer-NEWABC.js",
    body: "intelligence-needle INTELLIGENCE_DISABLED",
  },
  {
    id: "service-tier-slash-command",
    resource: "composer-NEWABC.js",
    body: "slash-needle SLASH_DISABLED",
  },
  {
    id: "gpt5x-model-list-options",
    resource: "app-main-NEWDEF.js",
    body: "model-list-needle MODEL_LIST_DISABLED",
  },
  {
    id: "gpt56-model-query-selector",
    resource: "model-queries-NEWGHI.js",
    body: "selector-needle SELECTOR_DISABLED",
  },
] as const;

async function createAdaptiveAsar(
  root: string,
  bundle: string,
  options: {
    omitTargetId?: string;
    duplicateTargetId?: string;
    duplicateInSameFile?: boolean;
    duplicateSignatureWithoutNeedleTargetId?: string;
  } = {},
): Promise<string> {
  const source = join(root, `asar-source-${Math.random().toString(16).slice(2)}`);
  const assets = join(source, "webview", "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(source, "webview", "index.html"), "<html></html>", "utf8");
  const grouped = new Map<string, string[]>();
  for (const fragment of adaptiveTargetFragments) {
    if (fragment.id === options.omitTargetId) {
      continue;
    }
    const bodies = grouped.get(fragment.resource) ?? [];
    bodies.push(fragment.body);
    if (
      fragment.id === options.duplicateTargetId &&
      options.duplicateInSameFile
    ) {
      bodies.push(fragment.body);
    }
    grouped.set(fragment.resource, bodies);
    if (
      fragment.id === options.duplicateTargetId &&
      !options.duplicateInSameFile
    ) {
      writeFileSync(
        join(assets, `duplicate-${fragment.resource}`),
        fragment.body,
        "utf8",
      );
    }
    if (fragment.id === options.duplicateSignatureWithoutNeedleTargetId) {
      writeFileSync(
        join(assets, `signature-only-${fragment.resource}`),
        fragment.body.slice(fragment.body.lastIndexOf(" ") + 1),
        "utf8",
      );
    }
  }
  for (const [resource, bodies] of grouped) {
    writeFileSync(join(assets, resource), bodies.join(" "), "utf8");
  }
  const appAsar = join(bundle, "app", "resources", "app.asar");
  await createFinishedAsar(source, appAsar);
  return appAsar;
}

function adaptiveManifestXml(
  manifestXml: string,
  packageName: "OpenAI.Codex" | "OpenAI.CodexBeta",
  version: string,
): string {
  return manifestXml
    .replace('Name="OpenAI.Codex"', `Name="${packageName}"`)
    .replace('Version="26.707.3748.0"', `Version="${version}"`);
}

function adaptiveContextForBundle(
  bundle: string,
  packageName: "OpenAI.Codex" | "OpenAI.CodexBeta",
  version: string,
) {
  const context = createCodexfastContext("", "win32");
  context.paths.bundle = bundle;
  context.paths.appxManifest = join(bundle, "AppxManifest.xml");
  context.paths.executable = join(bundle, "app", "ChatGPT.exe");
  context.paths.resources = join(bundle, "app", "resources");
  context.paths.appAsar = join(context.paths.resources, "app.asar");
  context.metadata.packageName = packageName;
  context.metadata.version = version;
  context.metadata.versionKey = `${packageName}+${version}`;
  context.metadata.publisher =
    "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
  context.metadata.packageFamilyName = `${packageName}_2p2nqsd0c76g0`;
  context.metadata.applicationId = "App";
  context.metadata.appUserModelId =
    `${context.metadata.packageFamilyName}!App`;
  return context;
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function adaptiveCdpProfile() {
  const patcherSource = runtimePatcherSourceForWindows(
    filteredPatcherFixtureSource(),
  );
  const bodiesByResource = new Map<string, string[]>();
  for (const fragment of adaptiveTargetFragments) {
    const fragments = bodiesByResource.get(fragment.resource) ?? [];
    fragments.push(fragment.body);
    bodiesByResource.set(fragment.resource, fragments);
  }
  const bodies = new Map(
    [...bodiesByResource].map(([resource, fragments]) => [
      resource,
      fragments.join(" "),
    ]),
  );
  const patchedHashes = new Map(
    [...bodies].map(([resource, body]) => [
      resource,
      sha256Text(
        applyRuntimePatchesToResponseBodyWithSource(
          patcherSource,
          `app://-/assets/${resource}`,
          body,
        ).content,
      ),
    ]),
  );
  return {
    patcherSource,
    resourcePaths: [...bodies.keys()].map((resource) => `assets/${resource}`),
    responses: [...bodies].map(([resource, body]) => ({
      requestId: resource,
      url: `app://-/assets/${resource}`,
      body,
    })),
    targets: adaptiveTargetFragments.map((fragment) => ({
      label: runtimePatchWindowsRequiredInitialLabels[
        adaptiveTargetFragments.findIndex((candidate) =>
          candidate.id === fragment.id
        )
      ],
      runtimePath: `assets/${fragment.resource}`,
      contentSha256: sha256Text(bodies.get(fragment.resource)!),
      patchedContentSha256: patchedHashes.get(fragment.resource)!,
    })),
  };
}

function adaptivePackageRunner(
  packageName: "OpenAI.Codex" | "OpenAI.CodexBeta",
  packageFullName: string,
  packageFamilyName: string,
  bundle: string,
  version: string,
): WindowsCommandRunner {
  return () => commandResult(0, JSON.stringify({
    Name: packageName,
    PackageFullName: packageFullName,
    PackageFamilyName: packageFamilyName,
    InstallLocation: bundle,
    Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
    Version: version,
  }));
}

type FakeCdpEventHandler = (
  params: unknown,
  message: { sessionId?: string },
) => void | Promise<void>;

class FakeRuntimeCdp {
  private handlers = new Map<string, FakeCdpEventHandler[]>();
  private errorHandlers: Array<(error: Error) => void> = [];
  private preloadEventsScheduled = false;
  private responseBodies = new Map<string, string>();
  private responseFixtures: Array<{
    requestId: string;
    url: string;
    body: string;
  }> | null = null;
  private failedMethods = new Map<string, Error>();
  private targetUrl = "app://-/index.html";
  private emitTargetOnAutoAttach = true;
  private emitResponsesOnResume = false;
  closed = false;
  runtimeEvaluateContextFailuresRemaining = 0;
  runtimeEvaluateExpressions: string[] = [];
  sentMethods: string[] = [];

  setResponseFixtures(fixtures: Array<{
    requestId: string;
    url: string;
    body: string;
  }>): void {
    this.responseFixtures = fixtures;
  }

  failMethod(method: string, error: Error): void {
    this.failedMethods.set(method, error);
  }

  setTargetUrl(url: string): void {
    this.targetUrl = url;
  }

  setAutoAttachTargetEnabled(enabled: boolean): void {
    this.emitTargetOnAutoAttach = enabled;
  }

  setEmitResponsesOnResume(enabled: boolean): void {
    this.emitResponsesOnResume = enabled;
  }

  private async emitConfiguredResponses(sessionId: string): Promise<void> {
    const responses = this.responseFixtures ?? [
      {
        requestId: "general-settings",
        url: "app://-/assets/general-settings.js",
        body: "speed-setting-needle SPEED_SETTING_DISABLED",
      },
      {
        requestId: "service-tier-settings",
        url: "app://-/assets/service-tier-settings.js",
        body:
          "standalone-allowance-needle ALLOWANCE_DISABLED fallback-needle FALLBACK_DISABLED",
      },
      {
        requestId: "service-tier-request",
        url: "app://-/assets/service-tier-request.js",
        body: "request-allowance-needle REQUEST_ALLOWANCE_DISABLED",
      },
      {
        requestId: "composer",
        url: "app://-/assets/composer.js",
        body:
          "intelligence-needle INTELLIGENCE_DISABLED slash-needle SLASH_DISABLED",
      },
      {
        requestId: "model-list",
        url: "app://-/assets/model-list.js",
        body: "model-list-needle MODEL_LIST_DISABLED",
      },
      {
        requestId: "selector",
        url: "app://-/assets/selector.js",
        body: "selector-needle SELECTOR_DISABLED",
      },
    ];
    for (const { requestId, url, body } of responses) {
      this.responseBodies.set(requestId, body);
      await this.emit("Fetch.requestPaused", {
        requestId,
        request: { url },
        responseStatusCode: 200,
      }, sessionId);
    }
  }

  asConnection(): CdpConnection {
    return this as unknown as CdpConnection;
  }

  async send<T = unknown>(
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<T> {
    this.sentMethods.push(method);
    const methodFailure = this.failedMethods.get(method);
    if (methodFailure) {
      throw methodFailure;
    }
    if (method === "Target.setAutoAttach" && this.emitTargetOnAutoAttach) {
      queueMicrotask(() => {
        void this.emit("Target.attachedToTarget", {
          sessionId: "page-session",
          targetInfo: { type: "page", url: this.targetUrl },
          waitingForDebugger: true,
        });
      });
    }
    if (method === "Runtime.evaluate") {
      const expression = (params as { expression?: string })?.expression ?? "";
      this.runtimeEvaluateExpressions.push(expression);
      if (this.runtimeEvaluateContextFailuresRemaining > 0) {
        this.runtimeEvaluateContextFailuresRemaining -= 1;
        return {
          exceptionDetails: {
            text: "Execution context was destroyed.",
          },
        } as T;
      }
    }
    if (method === "Runtime.evaluate" && !this.preloadEventsScheduled) {
      this.preloadEventsScheduled = true;
      await this.emitConfiguredResponses(sessionId ?? "page-session");
    }
    if (
      method === "Runtime.runIfWaitingForDebugger" &&
      this.emitResponsesOnResume &&
      !this.preloadEventsScheduled
    ) {
      this.preloadEventsScheduled = true;
      await this.emitConfiguredResponses(sessionId ?? "page-session");
    }
    if (method === "Page.reload") {
      await this.emitConfiguredResponses(sessionId ?? "page-session");
    }
    if (method === "Fetch.getResponseBody") {
      const requestId = (params as { requestId?: string })?.requestId;
      const body = requestId ? this.responseBodies.get(requestId) ?? "" : "";
      return { body, base64Encoded: false } as T;
    }
    return undefined as T;
  }

  on(method: string, handler: FakeCdpEventHandler): void {
    const handlers = this.handlers.get(method) ?? [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  onEventError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  triggerEventError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private async emit(
    method: string,
    params: unknown,
    sessionId?: string,
  ): Promise<void> {
    try {
      await Promise.all(
        (this.handlers.get(method) ?? []).map((handler) =>
          handler(params, { sessionId })
        ),
      );
    } catch (error) {
      for (const handler of this.errorHandlers) {
        handler(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

async function withoutConsoleOutput<T>(action: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await action();
  } finally {
    console.log = originalLog;
  }
}

async function testRuntimeFailureTerminatesLaunchedProcess(): Promise<void> {
  const context = windowsRuntimeContext();
  let terminateCalls = 0;
  let cleanupCalls = 0;
  let requiredLabels: string[] = [];
  let preloadPaths: string[] = [];
  const exitCode = await withoutConsoleOutput(() =>
    runRuntimeLaunch({
      context,
      patcherSource: filteredPatcherFixtureSource(),
      supportedAppVersionKeys: context.metadata.versionKey,
      printActionHeader: () => undefined,
      removeLegacyWatcherFiles: () => {
        cleanupCalls += 1;
        return true;
      },
      platformOperations: {
        checkRunning: () => ({ ok: true, running: false }),
        launch: () => ({
          pid: 42_424,
          waitForExit: () => new Promise<number>(() => undefined),
          terminateTree: () => {
            terminateCalls += 1;
          },
        }),
      },
      runtimePatchSessionStarter: async (
        _debugPort,
        _patcherSource,
        labels,
        initialResourcePaths,
      ) => {
        requiredLabels = labels;
        preloadPaths = initialResourcePaths;
        throw new Error(
          "Runtime patch interception did not observe required targets: Fast slash command.",
        );
      },
      debugPortFactory: () => 45_678,
      windowsCompatibilityVerifier: () => undefined,
    })
  );
  assert.equal(exitCode, 1);
  assert.equal(terminateCalls, 1);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(requiredLabels, runtimePatchWindowsRequiredInitialLabels);
  assert.deepEqual(
    preloadPaths,
    runtimePatchInitialResourcePathsForContext(context),
  );
}

async function testInitialCdpFailureTerminatesLaunchedProcess(): Promise<void> {
  const context = windowsRuntimeContext();
  let terminateCalls = 0;
  const exitCode = await withoutConsoleOutput(() =>
    runRuntimeLaunch({
      context,
      patcherSource: filteredPatcherFixtureSource(),
      supportedAppVersionKeys: context.metadata.versionKey,
      printActionHeader: () => undefined,
      removeLegacyWatcherFiles: () => true,
      platformOperations: {
        checkRunning: () => ({ ok: true, running: false }),
        launch: () => ({
          pid: 43_434,
          waitForExit: () => new Promise<number>(() => undefined),
          terminateTree: () => {
            terminateCalls += 1;
          },
        }),
      },
      runtimePatchSessionStarter: async () => {
        throw new Error("CDP browser endpoint unavailable");
      },
      debugPortFactory: () => 45_680,
      windowsCompatibilityVerifier: () => undefined,
    })
  );
  assert.equal(exitCode, 1);
  assert.equal(terminateCalls, 1);
}

async function testExistingCodexPreventsActivation(): Promise<void> {
  const context = windowsRuntimeContext();
  let launchCalls = 0;
  const exitCode = await withoutConsoleOutput(() =>
    runRuntimeLaunch({
      context,
      patcherSource: filteredPatcherFixtureSource(),
      supportedAppVersionKeys: context.metadata.versionKey,
      printActionHeader: () => undefined,
      removeLegacyWatcherFiles: () => true,
      platformOperations: {
        checkRunning: () => ({ ok: true, running: true }),
        launch: () => {
          launchCalls += 1;
          throw new Error("launch must not be called");
        },
      },
      debugPortFactory: () => 45_681,
      windowsCompatibilityVerifier: () => undefined,
    })
  );
  assert.equal(exitCode, 1);
  assert.equal(launchCalls, 0);
}

async function testRuntimeDisconnectTerminatesLaunchedProcess(): Promise<void> {
  const context = windowsRuntimeContext();
  let terminateCalls = 0;
  let closeCalls = 0;
  const exitCode = await withoutConsoleOutput(() =>
    runRuntimeLaunch({
      context,
      patcherSource: filteredPatcherFixtureSource(),
      supportedAppVersionKeys: context.metadata.versionKey,
      printActionHeader: () => undefined,
      removeLegacyWatcherFiles: () => true,
      platformOperations: {
        checkRunning: () => ({ ok: true, running: false }),
        launch: () => ({
          pid: 51_515,
          waitForExit: () => new Promise<number>(() => undefined),
          terminateTree: () => {
            terminateCalls += 1;
          },
        }),
      },
      runtimePatchSessionStarter: async () => ({
        patchedLabels: [...runtimePatchWindowsRequiredInitialLabels],
        close: () => {
          closeCalls += 1;
        },
        lost: Promise.resolve(
          new Error(
            "Runtime patch session lost after 3 reconnect attempts: simulated disconnect",
          ),
        ),
      }),
      debugPortFactory: () => 45_679,
      windowsCompatibilityVerifier: () => undefined,
    })
  );
  assert.equal(exitCode, 1);
  assert.equal(terminateCalls, 1);
  assert.equal(closeCalls, 1);
}

async function testReconnectLoopExhaustion(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const initialCdp = new FakeRuntimeCdp();
    initialCdp.runtimeEvaluateContextFailuresRemaining = 1;
    let connectCalls = 0;
    const session = await startRuntimePatchSession(
      45_682,
      runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
      runtimePatchWindowsRequiredInitialLabels,
      runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
      [],
      {
        connect: async () => {
          connectCalls += 1;
          if (connectCalls === 1) {
            return initialCdp.asConnection();
          }
          throw new Error(`simulated reconnect failure ${connectCalls - 1}`);
        },
        sleep: async () => undefined,
      },
    );
    assert.deepEqual(
      [...session.patchedLabels].sort(),
      [...runtimePatchWindowsRequiredInitialLabels].sort(),
    );
    assert.equal(initialCdp.runtimeEvaluateExpressions.length, 2);
    const fetchEnableIndex = initialCdp.sentMethods.indexOf("Fetch.enable");
    const runtimeEvaluateIndex = initialCdp.sentMethods.indexOf(
      "Runtime.evaluate",
    );
    assert.ok(fetchEnableIndex >= 0, "expected Fetch.enable to be sent");
    assert.ok(
      runtimeEvaluateIndex >= 0,
      "expected Runtime.evaluate to be sent",
    );
    assert.ok(
      fetchEnableIndex < runtimeEvaluateIndex,
      "expected Fetch interception to be enabled before preload evaluation",
    );
    const preloadExpression = initialCdp.runtimeEvaluateExpressions.at(-1) ?? "";
    for (
      const resourcePath of runtimePatchInitialResourcePathsForContext(
        windowsRuntimeContext(),
      )
    ) {
      assert.match(preloadExpression, new RegExp(resourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    initialCdp.triggerEventError(new Error("simulated CDP disconnect"));
    const lost = await session.lost;
    assert.equal(connectCalls, 4);
    assert.match(
      lost.message,
      /Runtime patch session lost after 3 reconnect attempts: simulated reconnect failure 3/,
    );
    assert.equal(initialCdp.closed, true);
  });
}

async function testReconnectSetupFailureIsFailClosed(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const initialCdp = new FakeRuntimeCdp();
    const reconnectCdp = new FakeRuntimeCdp();
    reconnectCdp.failMethod(
      "Fetch.enable",
      new Error("simulated reconnect Fetch.enable failure"),
    );
    let connectCalls = 0;
    const session = await startRuntimePatchSession(
      45_686,
      runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
      runtimePatchWindowsRequiredInitialLabels,
      runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
      [],
      {
        connect: async () => {
          connectCalls += 1;
          if (connectCalls === 1) {
            return initialCdp.asConnection();
          }
          if (connectCalls === 2) {
            return reconnectCdp.asConnection();
          }
          throw new Error(`simulated reconnect retry failure ${connectCalls}`);
        },
        sleep: async () => undefined,
      },
    );
    initialCdp.triggerEventError(new Error("simulated initial disconnect"));
    const lost = await Promise.race([
      session.lost,
      new Promise<Error>((resolve) =>
        setTimeout(
          () => resolve(new Error("timed out waiting for fail-closed reconnect")),
          2_000,
        )
      ),
    ]);
    assert.equal(connectCalls, 4);
    assert.match(
      lost.message,
      /Runtime patch session lost after 3 reconnect attempts: simulated reconnect retry failure 4/,
    );
    session.close();
  });
}

async function testReconnectWithoutRendererIsFailClosed(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const initialCdp = new FakeRuntimeCdp();
    const reconnectCdps = Array.from({ length: 3 }, () => {
      const cdp = new FakeRuntimeCdp();
      cdp.setAutoAttachTargetEnabled(false);
      return cdp;
    });
    let connectCalls = 0;
    const session = await startRuntimePatchSession(
      45_689,
      runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
      runtimePatchWindowsRequiredInitialLabels,
      runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
      [],
      {
        connect: async () => {
          connectCalls += 1;
          return connectCalls === 1
            ? initialCdp.asConnection()
            : reconnectCdps[connectCalls - 2].asConnection();
        },
        sleep: async () => undefined,
      },
    );
    initialCdp.triggerEventError(new Error("simulated disconnect"));
    const lost = await session.lost;
    assert.equal(connectCalls, 4);
    assert.match(
      lost.message,
      /Runtime patch session lost after 3 reconnect attempts: CDP reconnected without a renderer bound to an app origin/,
    );
    session.close();
  });
}

async function testReconnectWithUnboundPendingRendererIsFailClosed(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const initialCdp = new FakeRuntimeCdp();
    const reconnectCdps = Array.from({ length: 3 }, () => {
      const cdp = new FakeRuntimeCdp();
      cdp.setTargetUrl("");
      return cdp;
    });
    let connectCalls = 0;
    const session = await startRuntimePatchSession(
      45_693,
      runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
      runtimePatchWindowsRequiredInitialLabels,
      runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
      [],
      {
        connect: async () => {
          connectCalls += 1;
          return connectCalls === 1
            ? initialCdp.asConnection()
            : reconnectCdps[connectCalls - 2].asConnection();
        },
        sleep: async () => undefined,
      },
    );
    initialCdp.triggerEventError(new Error("simulated disconnect"));
    const lost = await session.lost;
    assert.equal(connectCalls, 4);
    assert.match(
      lost.message,
      /Runtime patch session lost after 3 reconnect attempts: CDP reconnected without a renderer bound to an app origin/,
    );
    session.close();
  });
}

async function testReconnectRequiresAllPatchLabels(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const initialCdp = new FakeRuntimeCdp();
    const reconnectCdps = Array.from({ length: 3 }, () => {
      const cdp = new FakeRuntimeCdp();
      cdp.setEmitResponsesOnResume(true);
      cdp.setResponseFixtures([
        {
          requestId: "general-settings",
          url: "app://-/assets/general-settings.js",
          body: "speed-setting-needle SPEED_SETTING_DISABLED",
        },
        {
          requestId: "service-tier-settings",
          url: "app://-/assets/service-tier-settings.js",
          body:
            "standalone-allowance-needle ALLOWANCE_DISABLED fallback-needle FALLBACK_DISABLED",
        },
        {
          requestId: "service-tier-request",
          url: "app://-/assets/service-tier-request.js",
          body: "request-allowance-needle REQUEST_ALLOWANCE_DISABLED",
        },
        {
          requestId: "composer",
          url: "app://-/assets/composer.js",
          body:
            "intelligence-needle INTELLIGENCE_DISABLED slash-needle SLASH_DISABLED",
        },
        {
          requestId: "model-list",
          url: "app://-/assets/model-list.js",
          body: "model-list-needle MODEL_LIST_DISABLED",
        },
      ]);
      return cdp;
    });
    let connectCalls = 0;
    const session = await startRuntimePatchSession(
      45_695,
      runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
      runtimePatchWindowsRequiredInitialLabels,
      runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
      [],
      {
        connect: async () => {
          connectCalls += 1;
          return connectCalls === 1
            ? initialCdp.asConnection()
            : reconnectCdps[connectCalls - 2].asConnection();
        },
        sleep: async () => undefined,
      },
    );
    initialCdp.triggerEventError(new Error("simulated disconnect"));
    const lost = await session.lost;
    assert.equal(connectCalls, 4);
    assert.match(
      lost.message,
      /Runtime patch session lost after 3 reconnect attempts: CDP reconnected without observing required targets: GPT-5\.6 model query selector/,
    );
    session.close();
  });
}

async function testMissingRequiredPatchLabelIsFailClosed(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const cdp = new FakeRuntimeCdp();
    cdp.setResponseFixtures([
      {
        requestId: "general-settings",
        url: "app://-/assets/general-settings.js",
        body: "speed-setting-needle SPEED_SETTING_DISABLED",
      },
      {
        requestId: "service-tier-settings",
        url: "app://-/assets/service-tier-settings.js",
        body:
          "standalone-allowance-needle ALLOWANCE_DISABLED fallback-needle FALLBACK_DISABLED",
      },
      {
        requestId: "service-tier-request",
        url: "app://-/assets/service-tier-request.js",
        body: "request-allowance-needle REQUEST_ALLOWANCE_DISABLED",
      },
      {
        requestId: "composer",
        url: "app://-/assets/composer.js",
        body:
          "intelligence-needle INTELLIGENCE_DISABLED slash-needle SLASH_DISABLED",
      },
      {
        requestId: "model-list",
        url: "app://-/assets/model-list.js",
        body: "model-list-needle MODEL_LIST_DISABLED",
      },
    ]);
    await assert.rejects(
      startRuntimePatchSession(
        45_694,
        runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
        runtimePatchWindowsRequiredInitialLabels,
        runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
        [],
        {
          connect: async () => cdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /Runtime patch interception did not observe required targets: GPT-5\.6 model query selector/,
    );
  });
}

async function testRuntimeTargetPathAndHashBinding(): Promise<void> {
  const profile = adaptiveCdpProfile();
  await withoutConsoleOutput(async () => {
    const validCdp = new FakeRuntimeCdp();
    validCdp.setResponseFixtures(profile.responses);
    const session = await startRuntimePatchSession(
      45_683,
      profile.patcherSource,
      runtimePatchWindowsRequiredInitialLabels,
      profile.resourcePaths,
      profile.targets,
      {
        connect: async () => validCdp.asConnection(),
        sleep: async () => undefined,
      },
    );
    assert.deepEqual(
      [...session.patchedLabels].sort(),
      [...runtimePatchWindowsRequiredInitialLabels].sort(),
    );
    session.close();

    const wrongPathCdp = new FakeRuntimeCdp();
    wrongPathCdp.setResponseFixtures(profile.responses.map((response, index) =>
      index === 0
        ? { ...response, url: "app://-/assets/unexpected-general-settings.js" }
        : response
    ));
    await assert.rejects(
      startRuntimePatchSession(
        45_684,
        profile.patcherSource,
        runtimePatchWindowsRequiredInitialLabels,
        profile.resourcePaths,
        profile.targets,
        {
          connect: async () => wrongPathCdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /unexpected renderer origin app:\/\/-[,]? resource assets\/unexpected-general-settings\.js or body hash/,
    );

    const wrongHashCdp = new FakeRuntimeCdp();
    wrongHashCdp.setResponseFixtures(profile.responses.map((response, index) =>
      index === 0 ? { ...response, body: `${response.body} ` } : response
    ));
    await assert.rejects(
      startRuntimePatchSession(
        45_685,
        profile.patcherSource,
        runtimePatchWindowsRequiredInitialLabels,
        profile.resourcePaths,
        profile.targets,
        {
          connect: async () => wrongHashCdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /unexpected renderer origin app:\/\/-[,]? resource assets\/general-settings-NEW123\.js or body hash/,
    );

    const wrongOriginCdp = new FakeRuntimeCdp();
    wrongOriginCdp.setResponseFixtures(profile.responses.map((response, index) =>
      index === 0
        ? { ...response, url: "app://unexpected/assets/general-settings-NEW123.js" }
        : response
    ));
    await assert.rejects(
      startRuntimePatchSession(
        45_687,
        profile.patcherSource,
        runtimePatchWindowsRequiredInitialLabels,
        profile.resourcePaths,
        profile.targets,
        {
          connect: async () => wrongOriginCdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /Refusing renderer origin change from app:\/\/- to app:\/\/unexpected for session page-session/,
    );
  });
}

async function testPendingAppRendererOriginBinding(): Promise<void> {
  const profile = adaptiveCdpProfile();
  await withoutConsoleOutput(async () => {
    const pendingCdp = new FakeRuntimeCdp();
    pendingCdp.setTargetUrl("");
    pendingCdp.setEmitResponsesOnResume(true);
    pendingCdp.setResponseFixtures(profile.responses.map((response) => ({
      ...response,
      url: response.url.replace("app://-/", "app://codex.local/"),
    })));
    const session = await startRuntimePatchSession(
      45_690,
      profile.patcherSource,
      runtimePatchWindowsRequiredInitialLabels,
      profile.resourcePaths,
      profile.targets,
      {
        connect: async () => pendingCdp.asConnection(),
        sleep: async () => undefined,
      },
    );
    assert.deepEqual(
      [...session.patchedLabels].sort(),
      [...runtimePatchWindowsRequiredInitialLabels].sort(),
    );
    const fetchEnableIndex = pendingCdp.sentMethods.indexOf("Fetch.enable");
    const resumeIndex = pendingCdp.sentMethods.indexOf(
      "Runtime.runIfWaitingForDebugger",
    );
    assert.ok(fetchEnableIndex >= 0, "expected Fetch.enable to be sent");
    assert.ok(
      resumeIndex >= 0,
      "expected Runtime.runIfWaitingForDebugger to be sent",
    );
    assert.ok(
      fetchEnableIndex < resumeIndex,
      "expected Fetch interception before releasing a pending renderer",
    );
    const firstResponseIndex = pendingCdp.sentMethods.indexOf(
      "Fetch.getResponseBody",
    );
    const preloadIndex = pendingCdp.sentMethods.indexOf("Runtime.evaluate");
    assert.ok(
      firstResponseIndex >= 0,
      "expected an app response to bind the pending renderer",
    );
    assert.ok(preloadIndex >= 0, "expected runtime resource preload");
    assert.ok(
      firstResponseIndex < preloadIndex,
      "expected app-origin binding before runtime resource preload",
    );
    session.close();

    const nonAppResponseCdp = new FakeRuntimeCdp();
    nonAppResponseCdp.setTargetUrl("");
    nonAppResponseCdp.setEmitResponsesOnResume(true);
    nonAppResponseCdp.setResponseFixtures(profile.responses.map(
      (response, index) =>
        index === 0
          ? { ...response, url: "https://example.com/assets/runtime.js" }
          : response,
    ));
    await assert.rejects(
      startRuntimePatchSession(
        45_691,
        profile.patcherSource,
        runtimePatchWindowsRequiredInitialLabels,
        profile.resourcePaths,
        profile.targets,
        {
          connect: async () => nonAppResponseCdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /Refusing non-app runtime response for renderer session page-session/,
    );

    const changedOriginCdp = new FakeRuntimeCdp();
    changedOriginCdp.setTargetUrl("");
    changedOriginCdp.setEmitResponsesOnResume(true);
    changedOriginCdp.setResponseFixtures(profile.responses.map(
      (response, index) =>
        index === 1
          ? {
            ...response,
            url: response.url.replace("app://-/", "app://unexpected/"),
          }
          : response,
    ));
    await assert.rejects(
      startRuntimePatchSession(
        45_692,
        profile.patcherSource,
        runtimePatchWindowsRequiredInitialLabels,
        profile.resourcePaths,
        profile.targets,
        {
          connect: async () => changedOriginCdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /Refusing renderer origin change from app:\/\/- to app:\/\/unexpected for session page-session/,
    );
  });
}

async function testNonAppRendererIsRejected(): Promise<void> {
  await withoutConsoleOutput(async () => {
    const cdp = new FakeRuntimeCdp();
    cdp.setTargetUrl("https://example.com/index.html");
    await assert.rejects(
      startRuntimePatchSession(
        45_688,
        runtimePatcherSourceForWindows(filteredPatcherFixtureSource()),
        runtimePatchWindowsRequiredInitialLabels,
        runtimePatchInitialResourcePathsForContext(windowsRuntimeContext()),
        [],
        {
          connect: async () => cdp.asConnection(),
          sleep: async () => undefined,
        },
      ),
      /Refusing non-app renderer target https:\/\/example\.com\/index\.html/,
    );
  });
}

async function testAdaptiveWindowsCompatibility(
  manifestXml: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "codexfast-adaptive-msix-"));
  const version = "26.800.1.0";
  const expectedResources = [
    "assets/general-settings-NEW123.js",
    "assets/use-service-tier-settings-NEW456.js",
    "assets/read-service-tier-for-request-NEW789.js",
    "assets/composer-NEWABC.js",
    "assets/app-main-NEWDEF.js",
    "assets/model-queries-NEWGHI.js",
  ];
  try {
    for (const packageName of ["OpenAI.Codex", "OpenAI.CodexBeta"] as const) {
      const packageFamilyName = `${packageName}_2p2nqsd0c76g0`;
      const packageFullName =
        `${packageName}_${version}_x64__2p2nqsd0c76g0`;
      const bundle = createFakeMsix(
        root,
        packageFullName,
        adaptiveManifestXml(manifestXml, packageName, version),
      );
      await createAdaptiveAsar(root, bundle);
      let context = createCodexfastContext("", "win32");
      if (process.platform === "win32") {
        withWindowsAppOverridesCleared(() => {
          loadWindowsAppEnvironment(
            context,
            {},
            adaptivePackageRunner(
              packageName,
              packageFullName,
              packageFamilyName,
              bundle,
              version,
            ),
          );
        });
        assert.equal(context.metadata.supported, false);
        assert.equal(context.metadata.packageFullName, packageFullName);
        assert.equal(context.metadata.packageFamilyName, packageFamilyName);
        assert.equal(context.metadata.packageRegistrationVerified, true);
      } else {
        context = adaptiveContextForBundle(bundle, packageName, version);
      }

      applyWindowsRuntimeCompatibility(
        context,
        filteredPatcherFixtureSource(),
        {},
      );
      assert.equal(context.metadata.supported, true);
      assert.equal(
        context.runtimeCompatibility.source,
        "signature-compatible-update",
      );
      assert.equal(context.runtimeCompatibility.targets.length, 8);
      assert.deepEqual(
        context.runtimeCompatibility.resourcePaths,
        expectedResources,
      );
      assert.deepEqual(
        [...new Set(
          context.runtimeCompatibility.targets.map((target) =>
            target.archivePath
          ),
        )].length,
        6,
      );
      assert.ok(
        context.runtimeCompatibility.targets.every((target) =>
          target.runtimePath.startsWith("assets/") &&
          target.contentSha256.length === 64 &&
          target.patchedContentSha256.length === 64
        ),
      );
      verifyWindowsRuntimeCompatibilitySnapshot(context);
    }

    const knownPackageFullName =
      "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0";
    const knownBundle = createFakeMsix(
      root,
      knownPackageFullName,
      manifestXml,
    );
    await createAdaptiveAsar(root, knownBundle);
    const knownContext = adaptiveContextForBundle(
      knownBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    applyWindowsRuntimeCompatibility(
      knownContext,
      filteredPatcherFixtureSource(),
      {
        "OpenAI.Codex+26.707.3748.0": "known test profile",
      },
    );
    assert.equal(
      knownContext.runtimeCompatibility.source,
      "whitelist-signatures",
    );

    for (const fragment of adaptiveTargetFragments) {
      const packageFullName = `missing-${fragment.id}`;
      const bundle = createFakeMsix(root, packageFullName, manifestXml);
      await createAdaptiveAsar(root, bundle, { omitTargetId: fragment.id });
      const context = adaptiveContextForBundle(
        bundle,
        "OpenAI.Codex",
        "26.707.3748.0",
      );
      assert.throws(
        () =>
          inspectWindowsRuntimeCompatibility(
            context,
            filteredPatcherFixtureSource(),
            undefined,
          ),
        new RegExp(
          `did not find required target: .*\\(${fragment.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
        ),
      );
    }

    for (const duplicateInSameFile of [false, true]) {
      const fragment = adaptiveTargetFragments[0];
      const packageFullName = duplicateInSameFile
        ? "duplicate-target-same-file"
        : "duplicate-target-cross-file";
      const bundle = createFakeMsix(root, packageFullName, manifestXml);
      await createAdaptiveAsar(root, bundle, {
        duplicateTargetId: fragment.id,
        duplicateInSameFile,
      });
      const context = adaptiveContextForBundle(
        bundle,
        "OpenAI.Codex",
        "26.707.3748.0",
      );
      assert.throws(
        () =>
          inspectWindowsRuntimeCompatibility(
            context,
            filteredPatcherFixtureSource(),
            undefined,
          ),
        duplicateInSameFile
          ? /could not verify Speed setting .*state=ambiguous, guarded=2/
          : /found ambiguous target Speed setting .*duplicate-general-settings-NEW123\.js/,
      );
    }

    const signatureOnlyFragment = adaptiveTargetFragments[0];
    const signatureOnlyBundle = createFakeMsix(
      root,
      "duplicate-signature-without-needle",
      manifestXml,
    );
    await createAdaptiveAsar(root, signatureOnlyBundle, {
      duplicateSignatureWithoutNeedleTargetId: signatureOnlyFragment.id,
    });
    const signatureOnlyContext = adaptiveContextForBundle(
      signatureOnlyBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    assert.throws(
      () =>
        inspectWindowsRuntimeCompatibility(
          signatureOnlyContext,
          filteredPatcherFixtureSource(),
          undefined,
        ),
      /found ambiguous target Speed setting .*signature-only-general-settings-NEW123\.js/,
    );

    const malformedBundle = createFakeMsix(
      root,
      "malformed-asar",
      manifestXml,
    );
    const malformedContext = adaptiveContextForBundle(
      malformedBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    assert.throws(
      () =>
        inspectWindowsRuntimeCompatibility(
          malformedContext,
          filteredPatcherFixtureSource(),
          undefined,
        ),
      /Unexpected end of app\.asar|Unsupported app\.asar|Invalid app\.asar/,
    );

    const signatureMutationBundle = createFakeMsix(
      root,
      "signature-mutation",
      manifestXml,
    );
    await createAdaptiveAsar(root, signatureMutationBundle);
    const signatureMutationContext = adaptiveContextForBundle(
      signatureMutationBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    applyWindowsRuntimeCompatibility(
      signatureMutationContext,
      filteredPatcherFixtureSource(),
      {},
    );
    writeFileSync(
      join(signatureMutationBundle, "AppxSignature.p7x"),
      "mutated signature",
      "utf8",
    );
    assert.throws(
      () => verifyWindowsRuntimeCompatibilitySnapshot(signatureMutationContext),
      /AppxSignature\.p7x changed after compatibility inspection/,
    );

    const archiveMutationBundle = createFakeMsix(
      root,
      "archive-mutation",
      manifestXml,
    );
    await createAdaptiveAsar(root, archiveMutationBundle);
    const archiveMutationContext = adaptiveContextForBundle(
      archiveMutationBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    applyWindowsRuntimeCompatibility(
      archiveMutationContext,
      filteredPatcherFixtureSource(),
      {},
    );
    const originalArchive = readFileSync(archiveMutationContext.paths.appAsar);
    writeFileSync(
      archiveMutationContext.paths.appAsar,
      Buffer.concat([originalArchive, Buffer.from("mutation")]),
    );
    assert.throws(
      () => verifyWindowsRuntimeCompatibilitySnapshot(archiveMutationContext),
      /app\.asar changed after compatibility inspection/,
    );

    const manifestMutationBundle = createFakeMsix(
      root,
      "manifest-mutation",
      manifestXml,
    );
    await createAdaptiveAsar(root, manifestMutationBundle);
    const manifestMutationContext = adaptiveContextForBundle(
      manifestMutationBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    applyWindowsRuntimeCompatibility(
      manifestMutationContext,
      filteredPatcherFixtureSource(),
      {},
    );
    writeFileSync(
      manifestMutationContext.paths.appxManifest,
      manifestXml.replace(
        'Version="26.707.3748.0"',
        'Version="26.999.1.0"',
      ),
      "utf8",
    );
    assert.throws(
      () => verifyWindowsRuntimeCompatibilitySnapshot(manifestMutationContext),
      /AppxManifest\.xml changed after compatibility inspection/,
    );

    const preInspectionManifestChangeBundle = createFakeMsix(
      root,
      "manifest-changed-before-inspection",
      manifestXml,
    );
    await createAdaptiveAsar(root, preInspectionManifestChangeBundle);
    const preInspectionManifestChangeContext = adaptiveContextForBundle(
      preInspectionManifestChangeBundle,
      "OpenAI.Codex",
      "26.707.3748.0",
    );
    writeFileSync(
      preInspectionManifestChangeContext.paths.appxManifest,
      manifestXml.replace(
        'Version="26.707.3748.0"',
        'Version="26.999.2.0"',
      ),
      "utf8",
    );
    assert.throws(
      () =>
        inspectWindowsRuntimeCompatibility(
          preInspectionManifestChangeContext,
          filteredPatcherFixtureSource(),
          undefined,
        ),
      /AppxManifest\.xml identity changed after Windows package discovery/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testWindowsPackageDiscovery(manifestXml: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "codexfast-discovery-"));
  try {
    withWindowsAppOverridesCleared(() => {
      const stablePackageFullName =
        "OpenAI.Codex_26.800.1.0_x64__2p2nqsd0c76g0";
      const betaPackageFullName =
        "OpenAI.CodexBeta_26.707.3748.0_x64__2p2nqsd0c76g0";
      const stableManifest = manifestXml.replace(
        'Version="26.707.3748.0"',
        'Version="26.800.1.0"',
      );
      const betaManifest = manifestXml.replace(
        'Name="OpenAI.Codex"',
        'Name="OpenAI.CodexBeta"',
      );
      const stableBundle = createFakeMsix(
        root,
        stablePackageFullName,
        stableManifest,
      );
      const betaBundle = createFakeMsix(
        root,
        betaPackageFullName,
        betaManifest,
      );
      const candidates = [
        {
          Name: "OpenAI.CodexBeta",
          PackageFullName: betaPackageFullName,
          PackageFamilyName: "OpenAI.CodexBeta_2p2nqsd0c76g0",
          InstallLocation: betaBundle,
          Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
          Version: "26.707.3748.0",
        },
        {
          Name: "OpenAI.Codex",
          PackageFullName: stablePackageFullName,
          PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
          InstallLocation: stableBundle,
          Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
          Version: "26.800.1.0",
        },
      ];
      const discoveryRunner: WindowsCommandRunner = () =>
        commandResult(0, JSON.stringify(candidates));

      const stablePriorityContext = createCodexfastContext("", "win32");
      loadWindowsAppEnvironment(stablePriorityContext, {
        "OpenAI.CodexBeta+26.707.3748.0": "supported beta",
      }, discoveryRunner);
      assert.equal(stablePriorityContext.paths.bundle, stableBundle);
      assert.equal(stablePriorityContext.metadata.packageName, "OpenAI.Codex");
      assert.equal(stablePriorityContext.metadata.supported, false);
      assert.equal(
        stablePriorityContext.metadata.appUserModelId,
        "OpenAI.Codex_2p2nqsd0c76g0!App",
      );

      const stableContext = createCodexfastContext("", "win32");
      loadWindowsAppEnvironment(stableContext, {
        "OpenAI.Codex+26.800.1.0": "supported stable",
        "OpenAI.CodexBeta+26.707.3748.0": "supported beta",
      }, discoveryRunner);
      assert.equal(stableContext.paths.bundle, stableBundle);
      assert.equal(stableContext.metadata.packageName, "OpenAI.Codex");

      assert.throws(
        () =>
          loadWindowsAppEnvironment(
            createCodexfastContext("", "win32"),
            {},
            () => commandResult(0, "[]"),
          ),
        /was not discoverable for the current user/,
      );
      assert.throws(
        () =>
          loadWindowsAppEnvironment(
            createCodexfastContext("", "win32"),
            {},
            () => commandResult(5, "", "access denied"),
          ),
        /Get-AppxPackage failed: access denied/,
      );

      const mismatchPackageFullName =
        "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0";
      const mismatchBundle = createFakeMsix(
        root,
        mismatchPackageFullName,
        manifestXml.replace(
          'Version="26.707.3748.0"',
          'Version="26.700.1.0"',
        ),
      );
      assert.throws(
        () =>
          loadWindowsAppEnvironment(
            createCodexfastContext("", "win32"),
            {},
            () => commandResult(0, JSON.stringify({
              Name: "OpenAI.Codex",
              PackageFullName: mismatchPackageFullName,
              PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
              InstallLocation: mismatchBundle,
              Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
              Version: "26.707.3748.0",
            })),
          ),
        /does not match AppxManifest\.xml/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createWindowsLifecycleHarness(identity: WindowsProcessIdentity) {
  let alive = true;
  let currentIdentity = identity;
  let monitorTasklistFailure = false;
  let taskkillLeavesProcessAlive = false;
  let activationCalls = 0;
  let activationArguments = "";
  const taskkillArgs: string[][] = [];
  const runner: WindowsCommandRunner = (command, args, options) => {
    if (command === "tasklist.exe") {
      if (args.some((argument) => argument.startsWith("IMAGENAME eq "))) {
        return commandResult(0, "INFO: No tasks are running.");
      }
      if (monitorTasklistFailure) {
        return commandResult(3, "", "simulated tasklist failure");
      }
      return alive
        ? commandResult(
          0,
          `"ChatGPT.exe","${identity.pid}","Console","1","1,000 K"`,
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_TERMINATE_PID) {
      const expectedIdentity: WindowsProcessIdentity = {
        pid: Number(options.env.CODEXFAST_TERMINATE_PID),
        processName: options.env.CODEXFAST_TERMINATE_PROCESS_NAME ?? "",
        executablePath:
          options.env.CODEXFAST_TERMINATE_EXECUTABLE_PATH ?? "",
        startTimeUtc: options.env.CODEXFAST_TERMINATE_START_TIME_UTC ?? "",
      };
      if (!alive) {
        return commandResult(0, JSON.stringify({ State: "exited" }));
      }
      if (!sameWindowsProcessIdentity(expectedIdentity, currentIdentity)) {
        return commandResult(0, JSON.stringify({ State: "mismatch" }));
      }
      taskkillArgs.push([
        "/PID",
        String(identity.pid),
        "/T",
        "/F",
      ]);
      if (!taskkillLeavesProcessAlive) {
        alive = false;
      }
      return commandResult(0, JSON.stringify({
        State: "completed",
        TaskkillExitCode: 0,
        TaskkillStdout: "SUCCESS",
        TaskkillStderr: "",
        OriginalExited: !alive,
      }));
    }
    if (options?.env?.CODEXFAST_ACTIVATION_AUMID) {
      activationCalls += 1;
      activationArguments = options.env.CODEXFAST_ACTIVATION_ARGUMENTS ?? "";
      return commandResult(0, `${identity.pid}\r\n`);
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return alive
        ? commandResult(0, JSON.stringify({
          Pid: currentIdentity.pid,
          ProcessName: currentIdentity.processName,
          ExecutablePath: currentIdentity.executablePath,
          StartTimeUtc: currentIdentity.startTimeUtc,
          CommandLine: currentIdentity.commandLine ??
            `"${currentIdentity.executablePath}" ${activationArguments}`,
        }))
        : commandResult(0, "");
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return {
    runner,
    taskkillArgs,
    activationCalls: () => activationCalls,
    setAlive: (value: boolean) => {
      alive = value;
    },
    setCurrentIdentity: (value: WindowsProcessIdentity) => {
      currentIdentity = value;
    },
    setMonitorTasklistFailure: (value: boolean) => {
      monitorTasklistFailure = value;
    },
    setTaskkillLeavesProcessAlive: (value: boolean) => {
      taskkillLeavesProcessAlive = value;
    },
  };
}

async function testWindowsProcessLifecycle(): Promise<void> {
  const context = windowsRuntimeContext();
  const identity: WindowsProcessIdentity = {
    pid: 42_424,
    processName: "ChatGPT",
    executablePath: context.paths.executable,
    startTimeUtc: new Date().toISOString(),
  };

  const killHarness = createWindowsLifecycleHarness(identity);
  const launched = launchWindowsCodexProcess(
    context,
    45_678,
    killHarness.runner,
    { terminationPollAttempts: 1, sleep: async () => undefined },
  );
  assert.equal(launched.pid, identity.pid);
  assert.ok(sameWindowsProcessIdentity(launched.identity, identity));
  await launched.terminateTree();
  assert.deepEqual(killHarness.taskkillArgs, [[
    "/PID",
    "42424",
    "/T",
    "/F",
  ]]);
  assert.equal(await launched.waitForExit(), 0);

  const exitedHarness = createWindowsLifecycleHarness(identity);
  const exited = launchWindowsCodexProcess(
    context,
    45_679,
    exitedHarness.runner,
    { pollIntervalMs: 0, sleep: async () => undefined },
  );
  exitedHarness.setAlive(false);
  assert.equal(await exited.waitForExit(), 0);
  await exited.terminateTree();
  assert.equal(exitedHarness.taskkillArgs.length, 0);

  const reusedHarness = createWindowsLifecycleHarness(identity);
  const reused = launchWindowsCodexProcess(
    context,
    45_680,
    reusedHarness.runner,
    { terminationPollAttempts: 1, sleep: async () => undefined },
  );
  reusedHarness.setCurrentIdentity({
    ...identity,
    startTimeUtc: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(
    reused.terminateTree(),
    /no longer belongs to the process launched by codexfast/,
  );
  assert.equal(reusedHarness.taskkillArgs.length, 0);

  const tasklistFailureHarness = createWindowsLifecycleHarness(identity);
  const tasklistFailure = launchWindowsCodexProcess(
    context,
    45_681,
    tasklistFailureHarness.runner,
    { terminationPollAttempts: 1, sleep: async () => undefined },
  );
  tasklistFailureHarness.setMonitorTasklistFailure(true);
  await assert.rejects(
    tasklistFailure.waitForExit(),
    /tasklist failed while monitoring PID 42424/,
  );
  tasklistFailureHarness.setMonitorTasklistFailure(false);
  await tasklistFailure.terminateTree();
  assert.equal(tasklistFailureHarness.taskkillArgs.length, 1);

  const survivingHarness = createWindowsLifecycleHarness(identity);
  survivingHarness.setTaskkillLeavesProcessAlive(true);
  const surviving = launchWindowsCodexProcess(
    context,
    45_682,
    survivingHarness.runner,
    { terminationPollAttempts: 2, sleep: async () => undefined },
  );
  await assert.rejects(
    surviving.terminateTree(),
    /was still running after taskkill completed/,
  );
  assert.equal(survivingHarness.taskkillArgs.length, 1);

  let activationAttempted = false;
  assert.throws(
    () =>
      launchWindowsCodexProcess(context, 45_683, (command, args, options) => {
        if (command === "tasklist.exe") {
          return args.includes("IMAGENAME eq Codex.exe")
            ? commandResult(
              0,
              '"Codex.exe","9999","Console","1","1,000 K"',
            )
            : commandResult(0, "INFO: No tasks are running.");
        }
        if (options?.env?.CODEXFAST_PROCESS_IDS) {
          return processIdentityResult([{
            pid: 9_999,
            processName: "Codex",
            executablePath: join(context.paths.resources, "codex.exe"),
            startTimeUtc: new Date().toISOString(),
          }]);
        }
        activationAttempted = true;
        return commandResult(0, "9999");
      }),
    /Codex started after the initial process check/,
  );
  assert.equal(activationAttempted, false);

  const ownershipFailureCases: Array<{
    name: string;
    identity: WindowsProcessIdentity;
    message: RegExp;
  }> = [
    {
      name: "wrong process name",
      identity: { ...identity, processName: "OtherApp" },
      message: /expected ChatGPT\.exe/,
    },
    {
      name: "unreadable executable path",
      identity: { ...identity, executablePath: "" },
      message: /at <unreadable>/,
    },
    {
      name: "wrong executable path",
      identity: {
        ...identity,
        executablePath: String.raw`C:\Windows\System32\notepad.exe`,
      },
      message: /expected .*ChatGPT\.exe/,
    },
    {
      name: "stale process start time",
      identity: {
        ...identity,
        startTimeUtc: new Date(Date.now() - 120_000).toISOString(),
      },
      message: /outside this activation window/,
    },
    {
      name: "wrong activation command line",
      identity: {
        ...identity,
        commandLine:
          `"${identity.executablePath}" --remote-debugging-port=49999 --remote-debugging-address=127.0.0.1`,
      },
      message: /without this launch's --remote-debugging-port=45690 argument/,
    },
  ];
  for (const failureCase of ownershipFailureCases) {
    const harness = createWindowsLifecycleHarness(failureCase.identity);
    assert.throws(
      () =>
        launchWindowsCodexProcess(
          context,
          45_690,
          harness.runner,
          { terminationPollAttempts: 1, sleep: async () => undefined },
        ),
      failureCase.message,
      failureCase.name,
    );
    assert.equal(harness.activationCalls(), 1, failureCase.name);
    assert.equal(harness.taskkillArgs.length, 0, failureCase.name);
  }

  const registrationContext = windowsRuntimeContext();
  registrationContext.metadata.packageFullName =
    "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0";
  registrationContext.metadata.packageRegistrationVerified = true;
  registrationContext.metadata.publisher =
    "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
  let registrationActivationAttempted = false;
  assert.throws(
    () =>
      launchWindowsCodexProcess(
        registrationContext,
        45_684,
        (_command, _args, options) => {
          if (options?.env?.CODEXFAST_ACTIVATION_AUMID) {
            registrationActivationAttempted = true;
          }
          return commandResult(0, "[]");
        },
      ),
    /selected MSIX registration changed after compatibility inspection/,
  );
  assert.equal(registrationActivationAttempted, false);

  const unregisteredUpdateContext = windowsRuntimeContext();
  unregisteredUpdateContext.runtimeCompatibility.source =
    "signature-compatible-update";
  assert.throws(
    () =>
      launchWindowsCodexProcess(
        unregisteredUpdateContext,
        45_685,
        () => {
          throw new Error("runner must not be called");
        },
      ),
    /cannot be activated without an exact registered PackageFullName/,
  );
}

function testWindowsEnvironmentOverrides(manifestXml: string): void {
  if (process.platform !== "win32") {
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "codexfast-fake-msix-"));
  const bundle = join(
    root,
    "Program Files",
    "WindowsApps",
    "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0",
  );
  const executable = join(bundle, "app", "ChatGPT.exe");
  const appAsar = join(bundle, "app", "resources", "app.asar");
  const previous = {
    bundle: process.env.CODEXFAST_APP_BUNDLE,
    executable: process.env.CODEXFAST_APP_EXECUTABLE,
    aumid: process.env.CODEXFAST_APP_USER_MODEL_ID,
  };
  try {
    mkdirSync(join(bundle, "app", "resources"), { recursive: true });
    writeFileSync(join(bundle, "AppxManifest.xml"), manifestXml, "utf8");
    writeFileSync(executable, "fake executable", "utf8");
    writeFileSync(appAsar, "fake asar", "utf8");
    process.env.CODEXFAST_APP_BUNDLE = bundle;
    process.env.CODEXFAST_APP_EXECUTABLE = join("app", "ChatGPT.exe");
    process.env.CODEXFAST_APP_USER_MODEL_ID = "Custom.Package_family!App";

    assert.throws(
      () =>
        loadWindowsAppEnvironment(createCodexfastContext("", "win32"), {
          "OpenAI.Codex+26.707.3748.0": "test-supported",
        }),
      /Package Family Name Custom\.Package_family does not match the selected MSIX OpenAI\.Codex_2p2nqsd0c76g0/,
    );

    process.env.CODEXFAST_APP_USER_MODEL_ID =
      "OpenAI.Codex_2p2nqsd0c76g0!App";

    const context = createCodexfastContext("", "win32");
    loadWindowsAppEnvironment(context, {
      "OpenAI.Codex+26.707.3748.0": "test-supported",
    });
    assert.equal(context.paths.bundle, bundle);
    assert.equal(context.paths.executable, executable);
    assert.equal(context.paths.appAsar, appAsar);
    assert.equal(
      context.metadata.packageFamilyName,
      "OpenAI.Codex_2p2nqsd0c76g0",
    );
    assert.equal(context.metadata.applicationId, "App");
    assert.equal(
      context.metadata.appUserModelId,
      "OpenAI.Codex_2p2nqsd0c76g0!App",
    );
    assert.equal(context.metadata.supported, true);
    assert.equal(context.metadata.packageRegistrationVerified, false);
    assert.match(context.metadata.compatibility, /explicit AUMID override/);

    const injectedContext = createCodexfastContext("", "win32");
    withWindowsAppOverridesCleared(() =>
      loadWindowsAppEnvironment(
        injectedContext,
        {
          "OpenAI.Codex+26.707.3748.0": "test-supported",
        },
        () => commandResult(0, "[]"),
        {
          ...process.env,
          CODEXFAST_APP_BUNDLE: bundle,
          CODEXFAST_APP_EXECUTABLE: join("app", "ChatGPT.exe"),
          CODEXFAST_APP_USER_MODEL_ID:
            "OpenAI.Codex_2p2nqsd0c76g0!App",
        },
      )
    );
    assert.equal(injectedContext.paths.bundle, bundle);
    assert.equal(injectedContext.paths.executable, executable);
    assert.equal(
      injectedContext.metadata.appUserModelId,
      "OpenAI.Codex_2p2nqsd0c76g0!App",
    );

    const outsideExecutable = join(root, "ChatGPT.exe");
    writeFileSync(outsideExecutable, "outside executable", "utf8");
    process.env.CODEXFAST_APP_EXECUTABLE = outsideExecutable;
    assert.throws(
      () =>
        loadWindowsAppEnvironment(createCodexfastContext("", "win32"), {
          "OpenAI.Codex+26.707.3748.0": "test-supported",
        }),
      /must resolve inside the selected MSIX bundle/,
    );
    process.env.CODEXFAST_APP_EXECUTABLE = join("app", "ChatGPT.exe");

    writeFileSync(
      join(bundle, "AppxManifest.xml"),
      manifestXml.replace(
        'Version="26.707.3748.0"',
        'Version="26.800.1.0"',
      ),
      "utf8",
    );
    assert.throws(
      () =>
        loadWindowsAppEnvironment(
          createCodexfastContext("", "win32"),
          {},
          () => commandResult(0, "[]"),
        ),
      /Unlisted Windows versions require an exact current-user MSIX registration match/,
    );
    writeFileSync(join(bundle, "AppxManifest.xml"), manifestXml, "utf8");

    process.env.CODEXFAST_APP_USER_MODEL_ID =
      "OpenAI.Codex_2p2nqsd0c76g0!MissingApplication";
    assert.throws(
      () =>
        loadWindowsAppEnvironment(createCodexfastContext("", "win32"), {
          "OpenAI.Codex+26.707.3748.0": "test-supported",
        }),
      /does not define it/,
    );
  } finally {
    if (previous.bundle === undefined) {
      delete process.env.CODEXFAST_APP_BUNDLE;
    } else {
      process.env.CODEXFAST_APP_BUNDLE = previous.bundle;
    }
    if (previous.executable === undefined) {
      delete process.env.CODEXFAST_APP_EXECUTABLE;
    } else {
      process.env.CODEXFAST_APP_EXECUTABLE = previous.executable;
    }
    if (previous.aumid === undefined) {
      delete process.env.CODEXFAST_APP_USER_MODEL_ID;
    } else {
      process.env.CODEXFAST_APP_USER_MODEL_ID = previous.aumid;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runWindowsSuite(rootDir: string): Promise<void> {
  const manifestXml = readFileSync(
    join(rootDir, "test", "fixtures", "windows", "AppxManifest.xml"),
    "utf8",
  );
  const manifest = parseAppxManifest(manifestXml);
  assert.equal(manifest.identityName, "OpenAI.Codex");
  assert.equal(manifest.version, "26.707.3748.0");
  assert.equal(manifest.processorArchitecture, "x64");
  assert.equal(
    manifest.publisher,
    "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
  );
  assert.deepEqual(manifest.applications[0], {
    id: "App",
    executable: String.raw`app\ChatGPT.exe`,
    entryPoint: "Windows.FullTrustApplication",
  });
  testWindowsEnvironmentOverrides(manifestXml);
  testWindowsPackageDiscovery(manifestXml);
  await testAdaptiveWindowsCompatibility(manifestXml);

  assert.equal(
    deriveAppUserModelId("OpenAI.Codex_2p2nqsd0c76g0", "App"),
    "OpenAI.Codex_2p2nqsd0c76g0!App",
  );
  await assert.rejects(
    CdpConnection.connect(
      "ws://example.com:45678/devtools/browser/test",
      45_678,
    ),
    /Refusing non-loopback CDP WebSocket host/,
  );
  await assert.rejects(
    CdpConnection.connect(
      "ws://127.0.0.1:45679/devtools/browser/test",
      45_678,
    ),
    /Refusing CDP WebSocket port 45679; expected 45678/,
  );

  const packagePath = parseWindowsAppsPackagePath(
    String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`,
  );
  assert.ok(packagePath);
  assert.equal(packagePath.packageName, "OpenAI.Codex");
  assert.equal(packagePath.version, "26.707.3748.0");
  assert.equal(packagePath.architecture, "x64");
  assert.equal(packagePath.resourceId, "");
  assert.equal(packagePath.packageFamilyName, "OpenAI.Codex_2p2nqsd0c76g0");
  assert.equal(parseWindowsAppsPackagePath(String.raw`D:\Portable\Codex`), null);
  const registeredPackage: WindowsPackageCandidate = {
    name: "OpenAI.Codex",
    packageFullName: packagePath.packageDirectoryName,
    packageFamilyName: packagePath.packageFamilyName,
    installLocation: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`,
    publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
    version: "26.707.3748.0",
  };
  validateWindowsPackageIdentity(
    registeredPackage.installLocation,
    manifest,
    registeredPackage,
    packagePath,
  );
  assert.throws(
    () =>
      validateWindowsPackageIdentity(
        registeredPackage.installLocation,
        manifest,
        {
          ...registeredPackage,
          packageFamilyName: "OpenAI.Codex_wrongpublisher",
        },
        packagePath,
      ),
    /does not match WindowsApps path identity/,
  );
  assert.throws(
    () =>
      validateWindowsPackageIdentity(
        registeredPackage.installLocation,
        { ...manifest, processorArchitecture: "arm64" },
        registeredPackage,
        packagePath,
      ),
    /does not match AppxManifest\.xml identity/,
  );

  const packageCandidates = parseWindowsPackageCandidates(JSON.stringify([
    {
      Name: "OpenAI.CodexBeta",
      PackageFullName: "OpenAI.CodexBeta_26.800.1.0_x64__publisher",
      PackageFamilyName: "OpenAI.CodexBeta_publisher",
      InstallLocation: String.raw`C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.800.1.0_x64__publisher`,
      Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
      Version: "26.800.1.0",
    },
    {
      Name: "OpenAI.Codex",
      PackageFullName: "OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0",
      PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
      InstallLocation: String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0`,
      Publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
      Version: "26.707.3748.0",
    },
  ]));
  assert.deepEqual(
    packageCandidates.map((candidate) => candidate.name),
    ["OpenAI.Codex", "OpenAI.CodexBeta"],
  );

  const tasklistOutput = [
    '\uFEFF"ChatGPT.exe","17240","Console","1","215,432 K"',
    '"Codex.exe","28100","Console","1","99,000 K"',
    "INFO: No tasks are running which match the specified criteria.",
  ].join("\r\n");
  assert.deepEqual(parseTasklistCsv(tasklistOutput), [
    { imageName: "ChatGPT.exe", pid: 17_240 },
    { imageName: "Codex.exe", pid: 28_100 },
  ]);
  const nulSeparatedTasklist = '"Codex.exe","28100"'
    .split("")
    .join("\u0000");
  assert.deepEqual(parseTasklistCsv(nulSeparatedTasklist), [
    { imageName: "Codex.exe", pid: 28_100 },
  ]);

  const runningContext = windowsRuntimeContext();
  const processStarted = new Date().toISOString();
  const tasklistRunner: WindowsCommandRunner = (command, args, options) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq ChatGPT.exe")
        ? commandResult(
          0,
          '"ChatGPT.exe","17240","Console","1","215,432 K"',
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return processIdentityResult([{
        pid: 17_240,
        processName: "ChatGPT",
        executablePath: runningContext.paths.executable,
        startTimeUtc: processStarted,
      }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(checkWindowsCodexRunning(runningContext, tasklistRunner), {
    ok: true,
    running: true,
  });
  const codexOnlyRunner: WindowsCommandRunner = (command, args, options) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq Codex.exe")
        ? commandResult(
          0,
          '"Codex.exe","28100","Console","1","99,000 K"',
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return processIdentityResult([{
        pid: 28_100,
        processName: "Codex",
        executablePath: join(runningContext.paths.resources, "codex.exe"),
        startTimeUtc: processStarted,
      }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(checkWindowsCodexRunning(runningContext, codexOnlyRunner), {
    ok: true,
    running: true,
  });
  assert.deepEqual(
    snapshotWindowsCodexTasks(runningContext, codexOnlyRunner),
    {
      ok: true,
      tasks: [{ imageName: "Codex.exe", pid: 28_100 }],
    },
  );
  const cliOnlyRunner: WindowsCommandRunner = (command, args, options) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq Codex.exe")
        ? commandResult(
          0,
          '"Codex.exe","12680","Console","1","99,000 K"',
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return processIdentityResult([{
        pid: 12_680,
        processName: "Codex",
        executablePath: String.raw`C:\Users\Example\AppData\Roaming\npm\node_modules\@openai\codex\vendor\codex.exe`,
        startTimeUtc: processStarted,
      }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(checkWindowsCodexRunning(runningContext, cliOnlyRunner), {
    ok: true,
    running: false,
  });
  const mixedRunner: WindowsCommandRunner = (command, args, options) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq Codex.exe")
        ? commandResult(0, [
          '"Codex.exe","12680","Console","1","99,000 K"',
          '"Codex.exe","28100","Console","1","99,000 K"',
        ].join("\r\n"))
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      assert.equal(options.env.CODEXFAST_PROCESS_IDS, "12680,28100");
      return processIdentityResult([
        {
          pid: 12_680,
          processName: "Codex",
          executablePath: String.raw`C:\Users\Example\AppData\Local\OpenAI\Codex\bin\codex.exe`,
          startTimeUtc: processStarted,
        },
        {
          pid: 28_100,
          processName: "Codex",
          executablePath: join(runningContext.paths.resources, "codex.exe"),
          startTimeUtc: processStarted,
        },
      ]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(snapshotWindowsCodexTasks(runningContext, mixedRunner), {
    ok: true,
    tasks: [{ imageName: "Codex.exe", pid: 28_100 }],
  });
  const betaBundle = String.raw`C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.800.1.0_x64__2p2nqsd0c76g0`;
  runningContext.metadata.registeredPackageInstallLocations = [
    runningContext.paths.bundle,
    betaBundle,
  ];
  const betaDesktopRunner: WindowsCommandRunner = (
    command,
    args,
    options,
  ) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq Codex.exe")
        ? commandResult(
          0,
          '"Codex.exe","30100","Console","1","99,000 K"',
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return processIdentityResult([{
        pid: 30_100,
        processName: "Codex",
        executablePath: join(betaBundle, "app", "Codex.exe"),
        startTimeUtc: processStarted,
      }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(
    snapshotWindowsCodexTasks(runningContext, betaDesktopRunner),
    {
      ok: true,
      tasks: [{ imageName: "Codex.exe", pid: 30_100 }],
    },
  );
  const unreadablePathRunner: WindowsCommandRunner = (
    command,
    args,
    options,
  ) => {
    if (command === "tasklist.exe") {
      return args.includes("IMAGENAME eq Codex.exe")
        ? commandResult(
          0,
          '"Codex.exe","28100","Console","1","99,000 K"',
        )
        : commandResult(0, "INFO: No tasks are running.");
    }
    if (options?.env?.CODEXFAST_PROCESS_IDS) {
      return processIdentityResult([{
        pid: 28_100,
        processName: "Codex",
        executablePath: "",
        startTimeUtc: processStarted,
      }]);
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  assert.deepEqual(
    checkWindowsCodexRunning(runningContext, unreadablePathRunner),
    {
      ok: false,
      message:
        "Cannot determine whether PID 28100 is Codex Desktop because its executable path is unavailable.",
    },
  );
  assert.deepEqual(
    checkWindowsCodexRunning(
      runningContext,
      () => commandResult(2, "", "tasklist unavailable"),
    ),
    {
      ok: false,
      message:
        "Cannot determine whether Codex is running because tasklist failed for ChatGPT.exe: tasklist unavailable",
    },
  );

  assert.deepEqual(buildWindowsActivationArguments(45_678), [
    "--remote-debugging-port=45678",
    "--remote-debugging-address=127.0.0.1",
  ]);
  assert.equal(
    windowsActivationCommandLine(45_678),
    "--remote-debugging-port=45678 --remote-debugging-address=127.0.0.1",
  );
  const activationSource = applicationActivationPowerShellSource();
  assert.match(activationSource, /IApplicationActivationManager/);
  assert.match(activationSource, /2e941141-7f97-4756-ba1d-9decde894a3d/i);
  assert.match(activationSource, /\[PreserveSig\]/);
  assert.match(
    activationSource,
    /ActivateForFile\(\s*\[MarshalAs\(UnmanagedType\.LPWStr\)\] string appUserModelId,\s*IntPtr itemArray,/s,
  );
  assert.match(
    activationSource,
    /ActivateForProtocol\(\s*\[MarshalAs\(UnmanagedType\.LPWStr\)\] string appUserModelId,\s*IntPtr itemArray,/s,
  );
  assert.doesNotMatch(activationSource, /runas|Verb\s+RunAs/i);
  assert.doesNotMatch(
    windowsProcessIdentityPowerShellSource(),
    /runas|Verb\s+RunAs/i,
  );
  const terminationSource = windowsProcessTerminationPowerShellSource();
  assert.doesNotMatch(terminationSource, /runas|Verb\s+RunAs/i);
  assert.ok(
    terminationSource.indexOf("$process.Handle") <
      terminationSource.indexOf("taskkill.exe"),
    "expected the launched process handle to be held before taskkill",
  );
  assert.match(terminationSource, /Arguments = "\/PID \$processId \/T \/F"/);
  if (process.platform === "win32") {
    const powershell = resolveWindowsPowerShell();
    assert.ok(powershell, "expected Windows PowerShell to be available");
    compileWindowsActivationHelper(powershell);
    compileWindowsProcessTerminationHelper(powershell);
    const currentProcessIdentity = queryWindowsProcessIdentity(
      powershell,
      process.pid,
    );
    assert.equal(currentProcessIdentity?.pid, process.pid);
    assert.match(currentProcessIdentity?.processName ?? "", /^node$/i);
    assert.ok(currentProcessIdentity?.startTimeUtc);

    const traySelfTest = spawnSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(rootDir, "scripts", "codexfast-tray.ps1"),
      "-SelfTest",
    ], { cwd: rootDir, encoding: "utf8" });
    assert.equal(
      traySelfTest.status,
      0,
      traySelfTest.stderr || traySelfTest.stdout,
    );
    assert.match(traySelfTest.stdout, /codexfast tray self-test passed/);
    assert.match(
      traySelfTest.stdout,
      /logs[\\/]launcher\.log/,
    );

    const traySmokeTest = spawnSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(rootDir, "scripts", "codexfast-tray.ps1"),
      "-SmokeTest",
    ], { cwd: rootDir, encoding: "utf8" });
    assert.equal(
      traySmokeTest.status,
      0,
      traySmokeTest.stderr || traySmokeTest.stdout,
    );
    assert.match(traySmokeTest.stdout, /codexfast tray smoke test passed/);

    const shortcutSelfTest = spawnSync(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(rootDir, "scripts", "install-windows-shortcut.ps1"),
      "-SelfTest",
    ], { cwd: rootDir, encoding: "utf8" });
    assert.equal(
      shortcutSelfTest.status,
      0,
      shortcutSelfTest.stderr || shortcutSelfTest.stdout,
    );
    assert.match(
      shortcutSelfTest.stdout,
      /codexfast Windows shortcut self-test passed/,
    );
  }

  let activationEnvironment: NodeJS.ProcessEnv | undefined;
  const activationRunner: WindowsCommandRunner = (_command, _args, options) => {
    activationEnvironment = options?.env;
    return commandResult(0, "42424\r\n");
  };
  assert.equal(
    activateWindowsApplication(runningContext, 45_678, activationRunner),
    42_424,
  );
  assert.equal(
    activationEnvironment?.CODEXFAST_ACTIVATION_AUMID,
    "OpenAI.Codex_2p2nqsd0c76g0!App",
  );
  assert.equal(
    activationEnvironment?.CODEXFAST_ACTIVATION_ARGUMENTS,
    "--remote-debugging-port=45678 --remote-debugging-address=127.0.0.1",
  );
  let identityEnvironment: NodeJS.ProcessEnv | undefined;
  const queriedIdentity = queryWindowsProcessIdentity(
    "powershell.exe",
    42_424,
    (_command, _args, options) => {
      identityEnvironment = options?.env;
      return commandResult(0, JSON.stringify({
        Pid: 42_424,
        ProcessName: "ChatGPT",
        ExecutablePath: runningContext.paths.executable,
        StartTimeUtc: new Date().toISOString(),
      }));
    },
  );
  assert.equal(identityEnvironment?.CODEXFAST_PROCESS_IDS, "42424");
  assert.equal(queriedIdentity?.pid, 42_424);
  assert.equal(queriedIdentity?.processName, "ChatGPT");

  const modelFixture = readFileSync(
    join(rootDir, "test", "fixtures", "windows", "model-targets.js"),
    "utf8",
  );
  const modelPatch = applyRuntimePatchesToBody(
    "app://-/assets/windows-model-targets.js",
    modelFixture,
  );
  assert.ok(modelPatch.patchedLabels.includes("GPT-5.x model list"));
  assert.ok(
    modelPatch.patchedLabels.includes("GPT-5.6 model query selector"),
  );
  assert.match(modelPatch.content, /displayName:`GPT-5\.6 Sol`/);
  assert.match(modelPatch.content, /displayName:`GPT-5\.6 Terra`/);
  const gpt56Entries = modelPatch.content.match(
    /\{id:`gpt-5\.6-(?:sol|terra|luna)`[^]*?isDefault:!1\}/g,
  ) ?? [];
  assert.equal(gpt56Entries.length, 3);
  for (const entry of gpt56Entries) {
    assert.match(entry, /additionalSpeedTiers:\[`fast`\]/);
    assert.match(entry, /serviceTiers:\[\{id:`priority`,name:`Fast`/);
  }
  const lunaEntryStart = modelPatch.content.indexOf("{id:`gpt-5.6-luna`");
  const lunaEntryEnd = modelPatch.content.indexOf(
    "defaultReasoningEffort",
    lunaEntryStart,
  );
  const lunaEntry = modelPatch.content.slice(lunaEntryStart, lunaEntryEnd);
  assert.match(lunaEntry, /reasoningEffort:`max`/);
  assert.doesNotMatch(lunaEntry, /reasoningEffort:`ultra`/);

  const fastFixture = readFileSync(
    join(rootDir, "test", "fixtures", "windows", "fast-targets.js"),
    "utf8",
  );
  const fastPatch = applyRuntimePatchesToBody(
    "app://-/assets/windows-fast-targets.js",
    fastFixture,
  );
  for (const label of runtimePatchWindowsRequiredInitialLabels.slice(0, 6)) {
    assert.ok(
      fastPatch.patchedLabels.includes(label),
      `expected Windows Fast fixture to patch ${label}`,
    );
  }
  assert.match(
    fastPatch.content,
    /if\(r\.availableOptions\.length<=1\)return null/,
  );
  assert.doesNotMatch(fastPatch.content, /if\(!n\|\|r\.availableOptions/);
  assert.match(fastPatch.content, /if\(n!==`chatgpt`\)return!0/);
  assert.match(fastPatch.content, /k=O;S=Iee\(s,k,y\)/);
  assert.match(fastPatch.content, /ae=m\.availableOptions\.length>1/);
  assert.match(fastPatch.content, /requiresEmptyComposer:!1,enabled:!0/);
  const fastRepatch = applyRuntimePatchesToBody(
    "app://-/assets/windows-fast-targets.js",
    fastPatch.content,
  );
  for (const label of runtimePatchWindowsRequiredInitialLabels.slice(0, 6)) {
    assert.ok(
      fastRepatch.alreadyPatchedLabels.includes(label),
      `expected repeated Windows Fast fixture patch to recognize ${label}`,
    );
  }

  const filteredSource = runtimePatcherSourceForWindows(
    filteredPatcherFixtureSource(),
  );
  const filteredPatcher = new Function(
    `${filteredSource}\nreturn applyRuntimePatchesToBody;`,
  )() as (resourcePath: string, body: string) => {
    content: string;
    patchedLabels: string[];
  };
  const filteredResult = filteredPatcher(
    "app://-/assets/demo.js",
    "speed-setting-needle SPEED_SETTING_DISABLED standalone-allowance-needle ALLOWANCE_DISABLED request-allowance-needle REQUEST_ALLOWANCE_DISABLED fallback-needle FALLBACK_DISABLED intelligence-needle INTELLIGENCE_DISABLED slash-needle SLASH_DISABLED model-list-needle MODEL_LIST_DISABLED selector-needle SELECTOR_DISABLED",
  );
  assert.match(filteredResult.content, /SPEED_SETTING_ENABLED/);
  assert.match(filteredResult.content, /ALLOWANCE_ENABLED/);
  assert.match(filteredResult.content, /REQUEST_ALLOWANCE_ENABLED/);
  assert.match(filteredResult.content, /FALLBACK_ENABLED/);
  assert.match(filteredResult.content, /INTELLIGENCE_ENABLED/);
  assert.match(filteredResult.content, /SLASH_ENABLED/);
  assert.match(filteredResult.content, /MODEL_LIST_ENABLED/);
  assert.match(filteredResult.content, /SELECTOR_ENABLED/);
  assert.deepEqual(
    filteredResult.patchedLabels,
    runtimePatchWindowsRequiredInitialLabels,
  );

  await testRuntimeFailureTerminatesLaunchedProcess();
  await testInitialCdpFailureTerminatesLaunchedProcess();
  await testRuntimeDisconnectTerminatesLaunchedProcess();
  await testReconnectLoopExhaustion();
  await testReconnectSetupFailureIsFailClosed();
  await testReconnectWithoutRendererIsFailClosed();
  await testReconnectWithUnboundPendingRendererIsFailClosed();
  await testReconnectRequiresAllPatchLabels();
  await testMissingRequiredPatchLabelIsFailClosed();
  await testRuntimeTargetPathAndHashBinding();
  await testPendingAppRendererOriginBinding();
  await testNonAppRendererIsRejected();
  await testExistingCodexPreventsActivation();
  await testWindowsProcessLifecycle();

  console.log("windows platform suite passed");
}
