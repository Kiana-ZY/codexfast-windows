import { createHash, randomBytes } from "node:crypto";
import {
  CdpConnection,
  cdpCommandWithTimeout,
  waitForRuntimeBrowserConnection,
} from "./cli-cdp.mts";
import type { CodexfastContext } from "./cli-context.mts";
import { printExitBlock, printExitCode } from "./cli-output.mts";
import {
  applyRuntimePatchesToResponseBodyWithSource,
  isRuntimeJavaScriptResource,
  type RuntimePatchResult,
} from "./cli-runtime-patcher.mts";
import {
  defaultRuntimeLaunchPlatformOperations,
  type RuntimeLaunchPlatformOperations,
  type RuntimeLaunchProcess,
} from "./cli-runtime-platform.mts";
import {
  runtimePatcherSourceForWindows,
  runtimePatcherSourceWithTargetFilter,
  runtimePatchWindowsRequiredInitialLabels,
} from "./cli-runtime-profile.mts";
import { verifyWindowsRuntimeCompatibilitySnapshot } from "./cli-windows-compatibility.mts";
import {
  asError,
  debugRuntime,
  printLine,
  sleep,
} from "./cli-utils.mts";

type FetchHeader = {
  name: string;
  value: string;
};

type FetchRequestPausedParams = {
  requestId: string;
  request: {
    url: string;
  };
  responseHeaders?: FetchHeader[];
  responseStatusCode?: number;
};

type TargetAttachedToTargetParams = {
  sessionId: string;
  targetInfo: {
    type: string;
    url: string;
  };
  waitingForDebugger?: boolean;
};

export type RuntimePatchSessionHandle = {
  patchedLabels: string[];
  close: () => void;
  lost: Promise<Error>;
};

type RuntimeFetchPatchOutcome = {
  labels: string[];
  sawJavaScript: boolean;
  resourceOrigin: string;
  resourcePath: string;
  bodySha256: string;
};

type RuntimeFetchPatchValidator = (
  outcome: RuntimeFetchPatchOutcome,
) => void;

export type RuntimePatchExpectedTarget = {
  label: string;
  runtimePath: string;
  contentSha256: string;
  patchedContentSha256: string;
};

export type RuntimePatchSessionStarter = (
  debugPort: number,
  patcherSource: string,
  requiredInitialLabels: string[],
  initialResourcePaths: string[],
  expectedInitialTargets: RuntimePatchExpectedTarget[],
) => Promise<RuntimePatchSessionHandle>;

export type RuntimePatchSessionDependencies = {
  connect?: (debugPort: number) => Promise<CdpConnection>;
  sleep?: (ms: number) => Promise<void>;
};

export type RuntimeLaunchOptions = {
  context: CodexfastContext;
  patcherSource: string;
  supportedAppVersionKeys: string;
  printActionHeader: (action: string) => void;
  removeLegacyWatcherFiles: (options?: {
    quietLaunchctl?: boolean;
    reportRemoved?: boolean;
  }) => boolean;
  platformOperations?: RuntimeLaunchPlatformOperations;
  runtimePatchSessionStarter?: RuntimePatchSessionStarter;
  debugPortFactory?: () => number;
  windowsCompatibilityVerifier?: (context: CodexfastContext) => void;
};

const runtimePatchInitialTargetTimeoutMs = 45_000;
const runtimePatchNoTargetIdleMs = 2_500;
const runtimePatchSettleMs = 750;
const runtimePatchInitialLoadSettleMs = 1_000;
const runtimePatchHeartbeatIntervalMs = 5_000;
const runtimePatchHeartbeatTimeoutMs = 2_000;
const runtimePatchReconnectMaxAttempts = 3;
const runtimePatchReconnectDelayMs = 1_000;
const runtimePatchReconnectAttachMaxAttempts = 10;
const runtimePatchReconnectAttachDelayMs = 100;
const runtimePatchPreloadMaxAttempts = 3;
const runtimePatchPreloadRetryDelayMs = 100;
const runtimePatchRendererOriginMaxAttempts = 100;
const runtimePatchRendererOriginRetryDelayMs = 50;
const runtimePatchDefaultRequiredInitialLabels = ["Plugins access"];
const runtimePatchNoPluginsAccessRequiredVersionKeys = new Set([
  "26.601.21317+3511",
  "26.602.30954+3575",
  "26.602.40724+3593",
  "26.602.71036+3685",
  "26.608.12217+3722",
  "26.609.30741+3808",
  "26.609.41114+3888",
  "26.609.71450+3965",
  "26.611.61049+3996",
  "26.611.61753+4008",
  "26.611.62324+4028",
  "26.616.31447+4133",
  "26.616.51431+4212",
  "26.616.71553+4265",
  "26.616.81150+4306",
  "26.623.31443+4441",
  "26.623.31921+4452",
  "26.623.42026+4514",
  "26.623.61825+4548",
  "26.623.70822+4559",
  "26.623.81905+4598",
  "26.623.101652+4674",
  "26.623.141536+4753",
  "26.707.31428+5059",
]);
const runtimePatchNoPluginTargetsVersionKeys = new Set([
  "26.623.31443+4441",
  "26.623.31921+4452",
  "26.623.42026+4514",
  "26.623.61825+4548",
  "26.623.70822+4559",
  "26.623.81905+4598",
  "26.623.101652+4674",
  "26.623.141536+4753",
  "26.707.31428+5059",
]);
const runtimePatchPluginTargetIdPrefixes = [
  "plugin",
  "plugins",
  "composer-plugin",
  "shared-plugin",
];
const runtimePatchRequiredInitialReloadMaxAttempts = 1;

function randomDebugPort(): number {
  return 40_000 + (randomBytes(2).readUInt16BE(0) % 20_000);
}

function responseHeadersForFulfill(
  headers: FetchHeader[] | undefined,
): FetchHeader[] {
  const forwarded: FetchHeader[] = [];
  for (const header of headers ?? []) {
    const name = header.name.toLowerCase();
    if (name === "content-type" || name === "charset") {
      forwarded.push({ name: header.name, value: header.value });
    }
  }
  if (
    !forwarded.some((header) => header.name.toLowerCase() === "content-type")
  ) {
    forwarded.push({
      name: "content-type",
      value: "application/javascript; charset=utf-8",
    });
  }
  return forwarded;
}

function normalizedRuntimeResourcePath(resourceUrl: string): string {
  try {
    const parsed = new URL(resourceUrl);
    if (parsed.protocol !== "app:") {
      return "";
    }
    return decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/gu, "");
  } catch {
    return "";
  }
}

function normalizedRuntimeResourceOrigin(resourceUrl: string): string {
  try {
    const parsed = new URL(resourceUrl);
    return parsed.protocol === "app:" ? `app://${parsed.host}` : "";
  } catch {
    return "";
  }
}

async function continueFetchRequest(
  cdp: CdpConnection,
  requestId: string,
  sessionId?: string,
): Promise<void> {
  await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
}

async function validateRuntimeFetchOutcomeOrBlock(
  cdp: CdpConnection,
  requestId: string,
  sessionId: string | undefined,
  validateOutcome: RuntimeFetchPatchValidator | undefined,
  outcome: RuntimeFetchPatchOutcome,
): Promise<void> {
  try {
    validateOutcome?.(outcome);
  } catch (error) {
    try {
      await cdp.send(
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        sessionId,
      );
    } catch {
      cdp.close();
    }
    throw error;
  }
}

async function handleFetchRequestPaused(
  cdp: CdpConnection,
  patcherSource: string,
  params: FetchRequestPausedParams,
  sessionId?: string,
  validateOutcome?: RuntimeFetchPatchValidator,
): Promise<RuntimeFetchPatchOutcome> {
  const resourceUrl = params.request.url;
  if (!isRuntimeJavaScriptResource(resourceUrl)) {
    const outcome = {
      labels: [],
      sawJavaScript: false,
      resourceOrigin: normalizedRuntimeResourceOrigin(resourceUrl),
      resourcePath: normalizedRuntimeResourcePath(resourceUrl),
      bodySha256: "",
    };
    await validateRuntimeFetchOutcomeOrBlock(
      cdp,
      params.requestId,
      sessionId,
      validateOutcome,
      outcome,
    );
    await continueFetchRequest(cdp, params.requestId, sessionId);
    return outcome;
  }
  debugRuntime(`paused ${resourceUrl}`);

  let bodyResult: { body?: string; base64Encoded?: boolean };
  try {
    bodyResult = await cdp.send("Fetch.getResponseBody", {
      requestId: params.requestId,
    }, sessionId);
  } catch {
    debugRuntime(`getResponseBody failed ${resourceUrl}`);
    const outcome = {
      labels: [],
      sawJavaScript: true,
      resourceOrigin: normalizedRuntimeResourceOrigin(resourceUrl),
      resourcePath: normalizedRuntimeResourcePath(resourceUrl),
      bodySha256: "",
    };
    await validateRuntimeFetchOutcomeOrBlock(
      cdp,
      params.requestId,
      sessionId,
      validateOutcome,
      outcome,
    );
    await continueFetchRequest(cdp, params.requestId, sessionId);
    return outcome;
  }

  if (typeof bodyResult.body !== "string") {
    debugRuntime(`missing body ${resourceUrl}`);
    const outcome = {
      labels: [],
      sawJavaScript: true,
      resourceOrigin: normalizedRuntimeResourceOrigin(resourceUrl),
      resourcePath: normalizedRuntimeResourcePath(resourceUrl),
      bodySha256: "",
    };
    await validateRuntimeFetchOutcomeOrBlock(
      cdp,
      params.requestId,
      sessionId,
      validateOutcome,
      outcome,
    );
    await continueFetchRequest(cdp, params.requestId, sessionId);
    return outcome;
  }

  const body = bodyResult.base64Encoded
    ? Buffer.from(bodyResult.body, "base64").toString("utf8")
    : bodyResult.body;
  const resourcePath = normalizedRuntimeResourcePath(resourceUrl);
  const resourceOrigin = normalizedRuntimeResourceOrigin(resourceUrl);
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  let patchResult: RuntimePatchResult;
  try {
    patchResult = applyRuntimePatchesToResponseBodyWithSource(
      patcherSource,
      resourceUrl,
      body,
    );
  } catch (error) {
    debugRuntime(`patch failed ${resourceUrl}: ${asError(error).message}`);
    const outcome = {
      labels: [],
      sawJavaScript: true,
      resourceOrigin,
      resourcePath,
      bodySha256,
    };
    await validateRuntimeFetchOutcomeOrBlock(
      cdp,
      params.requestId,
      sessionId,
      validateOutcome,
      outcome,
    );
    await continueFetchRequest(cdp, params.requestId, sessionId);
    return outcome;
  }
  const labels = [
    ...patchResult.patchedLabels,
    ...patchResult.alreadyPatchedLabels,
  ];
  const outcome = {
    labels,
    sawJavaScript: true,
    resourceOrigin,
    resourcePath,
    bodySha256,
  };
  await validateRuntimeFetchOutcomeOrBlock(
    cdp,
    params.requestId,
    sessionId,
    validateOutcome,
    outcome,
  );
  if (patchResult.matchedLabels.length > 0) {
    debugRuntime(
      `matched ${resourceUrl}: ${patchResult.matchedLabels.join(", ")}`,
    );
  }

  if (patchResult.content === body) {
    await continueFetchRequest(cdp, params.requestId, sessionId);
    return outcome;
  }

  await cdp.send("Fetch.fulfillRequest", {
    requestId: params.requestId,
    responseCode: params.responseStatusCode ?? 200,
    responseHeaders: responseHeadersForFulfill(params.responseHeaders),
    body: Buffer.from(patchResult.content, "utf8").toString("base64"),
  }, sessionId);
  return outcome;
}

function runtimePatchSessionLostMessage(error: Error): string {
  return `Runtime patch session lost after ${runtimePatchReconnectMaxAttempts} reconnect attempts: ${error.message}`;
}

function printRuntimePatchSessionLost(error: Error): void {
  printLine(error.message);
  printLine(
    "Codex will be closed because runtime patching is no longer active.",
  );
  printLine(
    "Fully quit Codex and relaunch with codexfast to start a patched session.",
  );
}

function printRuntimeLaunchReady(patchedLabels: string[]): void {
  printLine("Patched targets:");
  for (const label of patchedLabels) {
    printLine(`  ${label}`);
  }
  printLine("");
  printLine("Runtime launch completed.");
  printLine("Keep this codexfast launch process running while you use Codex.");
  printLine("Quit Codex to end the runtime patch session.");
}

function waitForRuntimeInitialPageLoad(cdp: CdpConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    };

    timeout = setTimeout(resolveOnce, runtimePatchInitialLoadSettleMs);
    cdp.on("Page.loadEventFired", resolveOnce);
    cdp.on("Page.frameStoppedLoading", resolveOnce);
  });
}

function missingRuntimePatchRequiredInitialLabels(
  observedLabels: Set<string>,
  requiredLabels: string[],
): string[] {
  return requiredLabels.filter(
    (label) => !observedLabels.has(label),
  );
}

function runtimePatchRequiredInitialLabelsForVersion(
  versionKey: string,
): string[] {
  if (runtimePatchNoPluginsAccessRequiredVersionKeys.has(versionKey)) {
    return [];
  }
  return runtimePatchDefaultRequiredInitialLabels;
}

export function runtimePatchRequiredInitialLabelsForContext(
  context: CodexfastContext,
): string[] {
  if (context.platform === "win32") {
    return [...runtimePatchWindowsRequiredInitialLabels];
  }
  return runtimePatchRequiredInitialLabelsForVersion(
    context.metadata.versionKey,
  );
}

export function runtimePatchInitialResourcePathsForContext(
  context: CodexfastContext,
): string[] {
  if (context.platform !== "win32") {
    return [];
  }
  return [...context.runtimeCompatibility.resourcePaths];
}

export function runtimePatcherSourceForVersion(
  patcherSource: string,
  versionKey: string,
): string {
  if (!runtimePatchNoPluginTargetsVersionKeys.has(versionKey)) {
    return patcherSource;
  }

  const skippedPrefixes = JSON.stringify(runtimePatchPluginTargetIdPrefixes);
  return runtimePatcherSourceWithTargetFilter(
    patcherSource,
    `
const __codexfastPluginTargetIdPrefixes = ${skippedPrefixes};
const __codexfastShouldUseTarget = (spec) => !__codexfastPluginTargetIdPrefixes.some((prefix) => spec.id.startsWith(prefix));`,
  );
}

export function runtimePatcherSourceForContext(
  patcherSource: string,
  context: CodexfastContext,
): string {
  if (context.platform === "win32") {
    return runtimePatcherSourceForWindows(patcherSource);
  }
  return runtimePatcherSourceForVersion(
    patcherSource,
    context.metadata.versionKey,
  );
}

async function enableRuntimePatchInterception(
  cdp: CdpConnection,
  options: { sessionId: string; waitForInitialLoad: boolean; reload: boolean },
): Promise<void> {
  await cdp.send("Fetch.enable", {
    patterns: [
      {
        urlPattern: "app://*/assets/*.js",
        requestStage: "Response",
      },
      {
        urlPattern: "app://*/webview/assets/*.js",
        requestStage: "Response",
      },
      {
        urlPattern: "app://*/.vite/build/*.js",
        requestStage: "Response",
      },
    ],
  }, options.sessionId);
  debugRuntime("Fetch.enable ok");
  if (options.waitForInitialLoad || options.reload) {
    await cdp.send("Page.enable", undefined, options.sessionId);
    debugRuntime("Page.enable ok");
  }
  if (options.waitForInitialLoad) {
    await waitForRuntimeInitialPageLoad(cdp);
    debugRuntime("initial page load settled");
  }
  if (options.reload) {
    await cdp.send("Page.reload", { ignoreCache: true }, options.sessionId);
    debugRuntime("Page.reload ok");
  }
}

async function enableRuntimePatchAutoAttach(cdp: CdpConnection): Promise<void> {
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  debugRuntime("Target.setAutoAttach ok");
}

async function preloadRuntimePatchResources(
  cdp: CdpConnection,
  sessionId: string,
  resourcePaths: string[],
  sleepFor: (ms: number) => Promise<void>,
): Promise<void> {
  if (resourcePaths.length === 0) {
    return;
  }
  const resources = JSON.stringify(resourcePaths);
  const expression =
    `Promise.all(${resources}.map(async resourcePath=>{const resourceUrl=new URL(resourcePath,document.baseURI).href;const response=await fetch(resourceUrl);if(!response.ok)throw new Error(\`codexfast preload failed: \${response.status} \${resourceUrl}\`);await response.text();return resourceUrl}))`;
  for (let attempt = 1; attempt <= runtimePatchPreloadMaxAttempts; attempt += 1) {
    try {
      const evaluation = await cdp.send<{
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      const exceptionMessage =
        evaluation?.exceptionDetails?.exception?.description ??
        evaluation?.exceptionDetails?.text;
      if (exceptionMessage) {
        throw new Error(exceptionMessage);
      }
      debugRuntime(`preloaded ${resourcePaths.length} runtime patch resources`);
      return;
    } catch (error) {
      const preloadError = asError(error);
      const contextUnavailable =
        /Cannot find (?:default )?execution context|Cannot find context|Execution context was destroyed|Inspected target navigated or closed/i
          .test(preloadError.message);
      if (!contextUnavailable || attempt >= runtimePatchPreloadMaxAttempts) {
        throw new Error(
          `Failed to preload runtime patch resources: ${preloadError.message}`,
        );
      }
      debugRuntime(
        `runtime patch resource preload retry ${attempt}/${runtimePatchPreloadMaxAttempts - 1}: ${preloadError.message}`,
      );
      await sleepFor(runtimePatchPreloadRetryDelayMs);
    }
  }
}

export async function startRuntimePatchSession(
  debugPort: number,
  patcherSource: string,
  requiredInitialLabels: string[],
  initialResourcePaths: string[] = [],
  expectedInitialTargets: RuntimePatchExpectedTarget[] = [],
  dependencies: RuntimePatchSessionDependencies = {},
): Promise<RuntimePatchSessionHandle> {
  const connect = dependencies.connect ?? waitForRuntimeBrowserConnection;
  const sleepFor = dependencies.sleep ?? sleep;
  let cdp = await connect(debugPort);
  const observedLabels = new Set<string>();
  const rendererOriginsBySession = new Map<string, string>();
  const pausedRequestHandlers = new Set<Promise<void>>();
  const targetSetupHandlers = new Set<Promise<void>>();
  const reconnectObservedLabelsByGeneration = new Map<number, Set<string>>();
  const attachedPageSessions = new Set<string>();
  let activePageSessionId: string | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let failSession: (error: Error) => void = () => undefined;
  let keepSessionOpen = false;
  let initialCompleted = false;
  let initialPreloadStarted = false;
  let closed = false;
  let reconnecting = false;
  let reconnectSetupError: Error | null = null;
  let connectionGeneration = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let resolveLost: (error: Error) => void = () => undefined;
  let markInitialObserved: () => void = () => undefined;
  let markInitialJavaScriptTraffic: () => void = () => undefined;
  const lost = new Promise<Error>((resolve) => {
    resolveLost = resolve;
  });

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const markSessionLost = (error: Error): void => {
    if (closed) {
      return;
    }
    closed = true;
    stopHeartbeat();
    cdp.close();
    resolveLost(error);
  };

  const reconnectRuntimePatchSession = async (reason: Error): Promise<void> => {
    if (closed || reconnecting) {
      return;
    }
    reconnecting = true;
    cdp.close();
    let lastError = reason;

    for (
      let attempt = 1;
      attempt <= runtimePatchReconnectMaxAttempts;
      attempt += 1
    ) {
      if (closed) {
        reconnecting = false;
        return;
      }
      if (attempt > 1) {
        await sleepFor(runtimePatchReconnectDelayMs);
      }
      printLine(
        `Runtime patch session reconnecting (${attempt}/${runtimePatchReconnectMaxAttempts})...`,
      );
      try {
        reconnectSetupError = null;
        activePageSessionId = null;
        attachedPageSessions.clear();
        rendererOriginsBySession.clear();
        const nextCdp = await connect(debugPort);
        connectionGeneration += 1;
        const reconnectGeneration = connectionGeneration;
        const reconnectObservedLabels = new Set<string>();
        reconnectObservedLabelsByGeneration.set(
          reconnectGeneration,
          reconnectObservedLabels,
        );
        cdp = nextCdp;
        registerRuntimeFetchHandler(reconnectGeneration);
        registerRuntimeTargetHandler(reconnectGeneration);
        await enableRuntimePatchAutoAttach(cdp);
        for (
          let attachAttempt = 1;
          attachAttempt <= runtimePatchReconnectAttachMaxAttempts;
          attachAttempt += 1
        ) {
          await Promise.resolve();
          while (targetSetupHandlers.size > 0) {
            await Promise.all([...targetSetupHandlers]);
          }
          while (pausedRequestHandlers.size > 0) {
            await Promise.all([...pausedRequestHandlers]);
          }
          if (reconnectSetupError) {
            throw reconnectSetupError;
          }
          const hasBoundAppRenderer = [...attachedPageSessions].some(
            (sessionId) => rendererOriginsBySession.has(sessionId),
          );
          const missingReconnectLabels =
            missingRuntimePatchRequiredInitialLabels(
              reconnectObservedLabels,
              requiredInitialLabels,
            );
          if (hasBoundAppRenderer && missingReconnectLabels.length === 0) {
            break;
          }
          if (attachAttempt < runtimePatchReconnectAttachMaxAttempts) {
            await sleepFor(runtimePatchReconnectAttachDelayMs);
          }
        }
        const hasBoundAppRenderer = [...attachedPageSessions].some(
          (sessionId) => rendererOriginsBySession.has(sessionId),
        );
        if (!hasBoundAppRenderer) {
          throw new Error(
            "CDP reconnected without a renderer bound to an app origin.",
          );
        }
        const missingReconnectLabels = missingRuntimePatchRequiredInitialLabels(
          reconnectObservedLabels,
          requiredInitialLabels,
        );
        if (missingReconnectLabels.length > 0) {
          throw new Error(
            `CDP reconnected without observing required targets: ${missingReconnectLabels.join(", ")}.`,
          );
        }
        reconnectObservedLabelsByGeneration.delete(reconnectGeneration);
        printLine("Runtime patch session reconnected.");
        reconnecting = false;
        return;
      } catch (error) {
        lastError = asError(error);
        reconnectObservedLabelsByGeneration.delete(connectionGeneration);
        cdp.close();
      }
    }

    reconnecting = false;
    markSessionLost(new Error(runtimePatchSessionLostMessage(lastError)));
  };

  const handleConnectionFailure = (generation: number, error: Error): void => {
    if (closed || generation !== connectionGeneration) {
      return;
    }
    if (!initialCompleted) {
      failSession(error);
      return;
    }
    if (reconnecting) {
      reconnectSetupError = error;
      return;
    }
    void reconnectRuntimePatchSession(error);
  };

  const rejectRuntimeFetchOutcome = (error: Error): never => {
    if (!initialCompleted) {
      failSession(error);
    } else {
      markSessionLost(error);
    }
    throw error;
  };

  const registerRuntimeFetchHandler = (generation: number): void => {
    const attachedCdp = cdp;
    attachedCdp.onEventError((error) => {
      handleConnectionFailure(generation, error);
    });
    attachedCdp.on("Fetch.requestPaused", (params: unknown, message) => {
      const task = handleFetchRequestPaused(
        attachedCdp,
        patcherSource,
        params as FetchRequestPausedParams,
        message.sessionId,
        (outcome) => {
          const rendererSessionId = message.sessionId ?? "";
          let expectedOrigin = rendererSessionId
            ? rendererOriginsBySession.get(rendererSessionId) ?? ""
            : "";
          if (rendererSessionId && attachedPageSessions.has(rendererSessionId)) {
            if (!outcome.resourceOrigin) {
              rejectRuntimeFetchOutcome(
                new Error(
                  `Refusing non-app runtime response for renderer session ${rendererSessionId}.`,
                ),
              );
            }
            if (!expectedOrigin) {
              expectedOrigin = outcome.resourceOrigin;
              rendererOriginsBySession.set(rendererSessionId, expectedOrigin);
              debugRuntime(
                `bound pending renderer session ${rendererSessionId} to origin ${expectedOrigin}`,
              );
            } else if (outcome.resourceOrigin !== expectedOrigin) {
              rejectRuntimeFetchOutcome(
                new Error(
                  `Refusing renderer origin change from ${expectedOrigin} to ${outcome.resourceOrigin} for session ${rendererSessionId}.`,
                ),
              );
            }
          }
          if (expectedInitialTargets.length === 0) {
            return;
          }
          for (const expectedTarget of expectedInitialTargets) {
            const observedLabel = outcome.labels.includes(expectedTarget.label);
            const observedExpectedPath =
              outcome.resourcePath === expectedTarget.runtimePath;
            if (!observedLabel && !observedExpectedPath) {
              continue;
            }
            const expectedBodyHash =
              outcome.bodySha256 === expectedTarget.contentSha256 ||
              outcome.bodySha256 === expectedTarget.patchedContentSha256;
            if (
              !expectedOrigin ||
              outcome.resourceOrigin !== expectedOrigin ||
              !observedLabel ||
              !observedExpectedPath ||
              !expectedBodyHash
            ) {
              rejectRuntimeFetchOutcome(
                new Error(
                  `Runtime target ${expectedTarget.label} was observed from unexpected renderer origin ${outcome.resourceOrigin || "<unknown>"}, resource ${outcome.resourcePath || "<unknown>"} or body hash.`,
                ),
              );
            }
          }
        },
      ).then((outcome) => {
        const { labels } = outcome;
        const reconnectObservedLabels =
          reconnectObservedLabelsByGeneration.get(generation);
        let sawNewLabel = false;
        for (const label of labels) {
          if (!observedLabels.has(label)) {
            sawNewLabel = true;
          }
          observedLabels.add(label);
          reconnectObservedLabels?.add(label);
        }
        if (!initialCompleted && labels.length > 0) {
          markInitialObserved();
        } else if (!initialCompleted && outcome.sawJavaScript) {
          markInitialJavaScriptTraffic();
        }
        if (initialCompleted && sawNewLabel) {
          debugRuntime(
            `patched labels now active: ${[...observedLabels].join(", ")}`,
          );
        }
      });
      pausedRequestHandlers.add(task);
      task.then(
        () => pausedRequestHandlers.delete(task),
        () => pausedRequestHandlers.delete(task),
      );
      return task;
    });
  };

  const registerRuntimeTargetHandler = (generation: number): void => {
    const attachedCdp = cdp;
    attachedCdp.on("Target.attachedToTarget", (params: unknown) => {
      const task = (async (): Promise<void> => {
        if (closed || generation !== connectionGeneration) {
          return;
        }
        const attached = params as TargetAttachedToTargetParams;
        const targetType = attached.targetInfo?.type ?? "";
        const targetUrl = attached.targetInfo?.url ?? "";
        if (targetType === "browser") {
          return;
        }
        if (targetType !== "page") {
          if (attached.waitingForDebugger) {
            await attachedCdp.send(
              "Runtime.runIfWaitingForDebugger",
              undefined,
              attached.sessionId,
            );
          }
          return;
        }
        const targetOrigin = normalizedRuntimeResourceOrigin(targetUrl);
        const pendingAppRenderer =
          targetUrl === "" && attached.waitingForDebugger === true;
        if (!targetOrigin && !pendingAppRenderer) {
          handleConnectionFailure(
            generation,
            new Error(
              `Refusing non-app renderer target ${targetUrl || "<empty>"}.`,
            ),
          );
          return;
        }

        activePageSessionId = attached.sessionId;
        attachedPageSessions.add(attached.sessionId);
        if (targetOrigin) {
          rendererOriginsBySession.set(attached.sessionId, targetOrigin);
        }
        debugRuntime(
          `attached target type=${targetType} url=${targetUrl || "<pending>"} session=${attached.sessionId}`,
        );
        await enableRuntimePatchInterception(attachedCdp, {
          sessionId: attached.sessionId,
          waitForInitialLoad: false,
          reload: !attached.waitingForDebugger,
        });
        if (attached.waitingForDebugger) {
          await attachedCdp.send(
            "Runtime.runIfWaitingForDebugger",
            undefined,
            attached.sessionId,
          );
          debugRuntime("Runtime.runIfWaitingForDebugger ok");
        }
        if (
          !initialCompleted &&
          !initialPreloadStarted &&
          initialResourcePaths.length > 0
        ) {
          initialPreloadStarted = true;
          for (
            let originAttempt = 1;
            originAttempt <= runtimePatchRendererOriginMaxAttempts;
            originAttempt += 1
          ) {
            if (rendererOriginsBySession.has(attached.sessionId)) {
              break;
            }
            if (originAttempt < runtimePatchRendererOriginMaxAttempts) {
              await sleepFor(runtimePatchRendererOriginRetryDelayMs);
            }
          }
          if (!rendererOriginsBySession.has(attached.sessionId)) {
            throw new Error(
              "Renderer did not navigate to an app origin before runtime resource preload.",
            );
          }
          await preloadRuntimePatchResources(
            attachedCdp,
            attached.sessionId,
            initialResourcePaths,
            sleepFor,
          );
        }
      })();
      targetSetupHandlers.add(task);
      task.then(
        () => targetSetupHandlers.delete(task),
        () => targetSetupHandlers.delete(task),
      );
      return task;
    });
    attachedCdp.on("Target.detachedFromTarget", (params: unknown) => {
      const detached = params as { sessionId?: string };
      if (!detached.sessionId) {
        return;
      }
      attachedPageSessions.delete(detached.sessionId);
      rendererOriginsBySession.delete(detached.sessionId);
      if (activePageSessionId === detached.sessionId) {
        activePageSessionId = [...attachedPageSessions][0] ?? null;
      }
    });
  };

  const startHeartbeat = (): void => {
    heartbeatTimer = setInterval(() => {
      if (closed || reconnecting) {
        return;
      }
      if (cdp.isClosed()) {
        void reconnectRuntimePatchSession(
          new Error("CDP WebSocket connection closed."),
        );
        return;
      }
      void cdpCommandWithTimeout(
        cdp.send("Browser.getVersion"),
        runtimePatchHeartbeatTimeoutMs,
        "Timed out waiting for CDP heartbeat.",
      ).catch((error: unknown) => {
        void reconnectRuntimePatchSession(asError(error));
      });
    }, runtimePatchHeartbeatIntervalMs);
  };

  try {
    const initialSession = new Promise<string[]>((resolve, reject) => {
      let hardTimeout: ReturnType<typeof setTimeout> | null = null;
      let noTargetIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let completed = false;
      let finishStarted = false;
      let sawInitialJavaScript = false;

      const clearSessionTimers = (): void => {
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        if (hardTimeout) {
          clearTimeout(hardTimeout);
          hardTimeout = null;
        }
        if (noTargetIdleTimer) {
          clearTimeout(noTargetIdleTimer);
          noTargetIdleTimer = null;
        }
      };

      const fail = (error: Error): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearSessionTimers();
        reject(error);
      };
      failSession = fail;

      const finish = (): void => {
        if (completed || finishStarted) {
          return;
        }
        finishStarted = true;
        clearSessionTimers();
        void (async () => {
          try {
            while (pausedRequestHandlers.size > 0) {
              await Promise.all([...pausedRequestHandlers]);
            }
          } catch (error) {
            fail(asError(error));
            return;
          }
          if (completed) {
            return;
          }
          if (!sawInitialJavaScript) {
            fail(
              new Error(
                "Runtime patch interception timed out before JavaScript responses were observed.",
              ),
            );
            return;
          }
          const missingRequiredLabels =
            missingRuntimePatchRequiredInitialLabels(
              observedLabels,
              requiredInitialLabels,
            );
          if (missingRequiredLabels.length > 0) {
            const retryLine =
              requiredInitialReloadAttempts === 1
                ? "Retried renderer reload 1 time while waiting for required targets."
                : `Retried renderer reload ${requiredInitialReloadAttempts} times while waiting for required targets.`;
            printLine(retryLine);
            fail(
              new Error(
                `Runtime patch interception did not observe required targets: ${missingRequiredLabels.join(", ")}.`,
              ),
            );
            return;
          }
          completed = true;
          initialCompleted = true;
          resolve([...observedLabels]);
        })();
      };
      let requiredInitialReloadAttempts = 0;

      const retryInitialTargetLoad = (): void => {
        if (
          completed ||
          finishStarted ||
          missingRuntimePatchRequiredInitialLabels(
            observedLabels,
            requiredInitialLabels,
          ).length === 0
        ) {
          return;
        }
        if (
          requiredInitialReloadAttempts >=
          runtimePatchRequiredInitialReloadMaxAttempts
        ) {
          finish();
          return;
        }
        requiredInitialReloadAttempts += 1;
        debugRuntime(
          `retrying renderer reload for required runtime targets (${requiredInitialReloadAttempts}/${runtimePatchRequiredInitialReloadMaxAttempts})`,
        );
        if (!activePageSessionId) {
          finish();
          return;
        }
        void cdp
          .send("Page.reload", { ignoreCache: true }, activePageSessionId)
          .then(() => {
            debugRuntime("Page.reload retry for required runtime targets ok");
          })
          .catch((error: unknown) => {
            fail(asError(error));
          });
      };

      const markJavaScriptTraffic = (): void => {
        if (completed || finishStarted) {
          return;
        }
        sawInitialJavaScript = true;
        if (
          missingRuntimePatchRequiredInitialLabels(
            observedLabels,
            requiredInitialLabels,
          ).length === 0
        ) {
          if (!settleTimer) {
            settleTimer = setTimeout(finish, runtimePatchSettleMs);
          }
          return;
        }
        if (noTargetIdleTimer) {
          clearTimeout(noTargetIdleTimer);
        }
        noTargetIdleTimer = setTimeout(
          retryInitialTargetLoad,
          runtimePatchNoTargetIdleMs,
        );
      };

      const markObserved = (): void => {
        if (completed || settleTimer) {
          return;
        }
        sawInitialJavaScript = true;
        if (
          missingRuntimePatchRequiredInitialLabels(
            observedLabels,
            requiredInitialLabels,
          ).length > 0
        ) {
          markJavaScriptTraffic();
          return;
        }
        if (noTargetIdleTimer) {
          clearTimeout(noTargetIdleTimer);
          noTargetIdleTimer = null;
        }
        settleTimer = setTimeout(finish, runtimePatchSettleMs);
      };
      markInitialObserved = markObserved;
      markInitialJavaScriptTraffic = markJavaScriptTraffic;

      hardTimeout = setTimeout(finish, runtimePatchInitialTargetTimeoutMs);
    });
    void initialSession.catch(() => undefined);
    registerRuntimeFetchHandler(connectionGeneration);
    registerRuntimeTargetHandler(connectionGeneration);

    try {
      await enableRuntimePatchAutoAttach(cdp);
    } catch (error) {
      failSession(asError(error));
    }

    const patchedLabels = await initialSession;
    keepSessionOpen = true;
    startHeartbeat();
    return {
      patchedLabels,
      close: () => {
        closed = true;
        stopHeartbeat();
        cdp.close();
      },
      lost,
    };
  } finally {
    if (!keepSessionOpen) {
      closed = true;
      stopHeartbeat();
      cdp.close();
    }
  }
}

function waitForRuntimePatchSession(
  debugPort: number,
  patcherSource: string,
  requiredInitialLabels: string[],
  initialResourcePaths: string[],
  expectedInitialTargets: RuntimePatchExpectedTarget[],
): Promise<RuntimePatchSessionHandle> {
  return startRuntimePatchSession(
    debugPort,
    patcherSource,
    requiredInitialLabels,
    initialResourcePaths,
    expectedInitialTargets,
  );
}

async function terminateRuntimeLaunchProcess(
  launchedProcess: RuntimeLaunchProcess,
): Promise<void> {
  try {
    await launchedProcess.terminateTree();
  } catch (error) {
    const message =
      `Failed to close launched Codex PID ${launchedProcess.pid}: ${asError(error).message}`;
    debugRuntime(message);
    printLine(message);
  }
}

export async function runRuntimeLaunch(
  options: RuntimeLaunchOptions,
): Promise<number> {
  const {
    context,
    patcherSource,
    printActionHeader,
    removeLegacyWatcherFiles,
    supportedAppVersionKeys,
  } = options;
  const platformOperations = options.platformOperations ??
    defaultRuntimeLaunchPlatformOperations;
  const runtimePatchSessionStarter = options.runtimePatchSessionStarter ??
    waitForRuntimePatchSession;
  const debugPortFactory = options.debugPortFactory ?? randomDebugPort;
  const windowsCompatibilityVerifier = options.windowsCompatibilityVerifier ??
    verifyWindowsRuntimeCompatibilitySnapshot;

  printActionHeader("launch");

  if (!context.metadata.supported) {
    printLine("Runtime launch is blocked for this Codex version or package.");
    printLine(`Supported version keys: ${supportedAppVersionKeys}`);
    return printExitBlock(1).exitCode;
  }

  if (context.platform === "darwin") {
    if (
      !removeLegacyWatcherFiles({ quietLaunchctl: true, reportRemoved: true })
    ) {
      printLine("Failed to remove legacy auto-repair watcher.");
      return printExitBlock(1).exitCode;
    }
  }

  if (context.platform === "win32") {
    try {
      windowsCompatibilityVerifier(context);
    } catch (error) {
      printLine(
        `Windows compatibility recheck failed: ${asError(error).message}`,
      );
      return printExitBlock(1).exitCode;
    }
  }

  const runningCheck = platformOperations.checkRunning(context);
  if (!runningCheck.ok) {
    printLine(runningCheck.message);
    return printExitBlock(1).exitCode;
  }

  if (runningCheck.running) {
    printLine(
      "Codex is already running. Fully quit Codex before using runtime launch.",
    );
    return printExitBlock(1).exitCode;
  }

  if (process.env.CODEXFAST_TEST_RUNTIME_LAUNCH_SUCCESS === "1") {
    printRuntimeLaunchReady(
      context.platform === "win32"
        ? runtimePatchWindowsRequiredInitialLabels
        : ["Speed setting"],
    );
    if (process.env.CODEXFAST_TEST_RUNTIME_LAUNCH_SESSION_LOST === "1") {
      printRuntimePatchSessionLost(
        new Error(
          runtimePatchSessionLostMessage(
            new Error("simulated CDP heartbeat failure"),
          ),
        ),
      );
      return printExitBlock(1).exitCode;
    }
    return printExitCode(0).exitCode;
  }

  if (process.env.CODEXFAST_TEST_RUNTIME_LAUNCH_PENDING_TARGETS === "1") {
    const requiredInitialLabels = runtimePatchRequiredInitialLabelsForContext(
      context,
    );
    const missingRequiredTargets = requiredInitialLabels.length > 0
      ? requiredInitialLabels.join(", ")
      : "none";
    printLine(
      "Retried renderer reload 1 time while waiting for required targets.",
    );
    printLine(
      `Runtime launch failed: Runtime patch interception did not observe required targets: ${missingRequiredTargets}.`,
    );
    return printExitBlock(1).exitCode;
  }

  let launchedProcess: RuntimeLaunchProcess | null = null;
  let session: RuntimePatchSessionHandle | null = null;
  try {
    const debugPort = debugPortFactory();
    launchedProcess = platformOperations.launch(context, debugPort);
    const processExit = launchedProcess.waitForExit();
    void processExit.catch(() => undefined);
    session = await runtimePatchSessionStarter(
      debugPort,
      runtimePatcherSourceForContext(
        patcherSource,
        context,
      ),
      runtimePatchRequiredInitialLabelsForContext(context),
      runtimePatchInitialResourcePathsForContext(context),
      context.platform === "win32"
        ? context.runtimeCompatibility.targets.map((target) => ({
          label: target.label,
          runtimePath: target.runtimePath,
          contentSha256: target.contentSha256,
          patchedContentSha256: target.patchedContentSha256,
        }))
        : [],
    );
    if (context.platform === "win32") {
      windowsCompatibilityVerifier(context);
    }
    printRuntimeLaunchReady(session.patchedLabels);
    const outcome = await Promise.race([
      processExit.then((exitCode) => ({
        type: "process-exit" as const,
        exitCode,
      })),
      session.lost.then((error) => ({ type: "session-lost" as const, error })),
    ]);
    if (outcome.type === "session-lost") {
      session.close();
      session = null;
      if (launchedProcess) {
        await terminateRuntimeLaunchProcess(launchedProcess);
      }
      printRuntimePatchSessionLost(outcome.error);
      return printExitBlock(1).exitCode;
    }
    session.close();
    session = null;
    printExitCode(outcome.exitCode);
    return outcome.exitCode;
  } catch (error) {
    if (session) {
      session.close();
      session = null;
    }
    if (launchedProcess) {
      await terminateRuntimeLaunchProcess(launchedProcess);
    }
    printLine(`Runtime launch failed: ${asError(error).message}`);
  }

  return printExitBlock(1).exitCode;
}
