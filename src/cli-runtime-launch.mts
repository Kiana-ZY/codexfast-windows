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
  close: () => void | Promise<void>;
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
  connect?: (
    debugPort: number,
    signal?: AbortSignal,
  ) => Promise<CdpConnection>;
  sleep?: (ms: number) => Promise<void>;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  reconnectObservationTimeoutMs?: number;
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
const runtimePatchCommandTimeoutMs = 10_000;
const runtimePatchBrowserConnectTimeoutMs = 15_000;
const runtimePatchHeartbeatIntervalMs = 5_000;
const runtimePatchHeartbeatTimeoutMs = 2_000;
const runtimePatchReconnectMaxAttempts = 3;
const runtimePatchReconnectDelayMs = 1_000;
const runtimePatchReconnectObservationTimeoutMs = 15_000;
const runtimePatchReconnectObservationPollMs = 100;
const runtimePatchPreloadMaxAttempts = 3;
const runtimePatchPreloadRetryDelayMs = 100;
const runtimePatchRendererOriginMaxAttempts = 100;
const runtimePatchRendererOriginRetryDelayMs = 50;
const runtimePatchRendererLocationTimeoutMs = 1_000;
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

function runtimeCdpCommand<T>(
  cdp: CdpConnection,
  method: string,
  params: unknown,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<T> {
  return cdpCommandWithTimeout(
    cdp.send<T>(method, params, sessionId),
    timeoutMs,
    `Timed out waiting for CDP ${method}.`,
  );
}

async function connectRuntimePatchCdp(
  connect: (
    debugPort: number,
    signal?: AbortSignal,
  ) => Promise<CdpConnection>,
  debugPort: number,
  timeoutMs: number,
): Promise<CdpConnection> {
  const controller = new AbortController();
  const pendingConnection = connect(debugPort, controller.signal);
  try {
    return await cdpCommandWithTimeout(
      pendingConnection,
      timeoutMs,
      "Timed out waiting for the CDP browser connection.",
    );
  } catch (error) {
    controller.abort();
    void pendingConnection.then(
      (lateConnection) => lateConnection.close(),
      () => undefined,
    );
    throw error;
  }
}

function runtimePatchLogError(error: Error): string {
  return error.message.replace(/[\r\n]+/gu, " ").trim() || error.name;
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
  commandTimeoutMs = runtimePatchCommandTimeoutMs,
): Promise<void> {
  await runtimeCdpCommand(
    cdp,
    "Fetch.continueRequest",
    { requestId },
    sessionId,
    commandTimeoutMs,
  );
}

async function validateRuntimeFetchOutcomeOrBlock(
  cdp: CdpConnection,
  requestId: string,
  sessionId: string | undefined,
  validateOutcome: RuntimeFetchPatchValidator | undefined,
  outcome: RuntimeFetchPatchOutcome,
  commandTimeoutMs: number,
): Promise<void> {
  try {
    validateOutcome?.(outcome);
  } catch (error) {
    try {
      await runtimeCdpCommand(
        cdp,
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        sessionId,
        commandTimeoutMs,
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
  commandTimeoutMs = runtimePatchCommandTimeoutMs,
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
      commandTimeoutMs,
    );
    await continueFetchRequest(
      cdp,
      params.requestId,
      sessionId,
      commandTimeoutMs,
    );
    return outcome;
  }
  debugRuntime(`paused ${resourceUrl}`);

  let bodyResult: { body?: string; base64Encoded?: boolean };
  try {
    bodyResult = await runtimeCdpCommand(
      cdp,
      "Fetch.getResponseBody",
      { requestId: params.requestId },
      sessionId,
      commandTimeoutMs,
    );
  } catch (error) {
    throw new Error(
      `Failed to read runtime response body for ${resourceUrl}: ${asError(error).message}`,
    );
  }

  if (typeof bodyResult.body !== "string") {
    throw new Error(`Runtime response body was missing for ${resourceUrl}.`);
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
      commandTimeoutMs,
    );
    await continueFetchRequest(
      cdp,
      params.requestId,
      sessionId,
      commandTimeoutMs,
    );
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
    commandTimeoutMs,
  );
  if (patchResult.matchedLabels.length > 0) {
    debugRuntime(
      `matched ${resourceUrl}: ${patchResult.matchedLabels.join(", ")}`,
    );
  }

  if (patchResult.content === body) {
    await continueFetchRequest(
      cdp,
      params.requestId,
      sessionId,
      commandTimeoutMs,
    );
    return outcome;
  }

  await runtimeCdpCommand(
    cdp,
    "Fetch.fulfillRequest",
    {
      requestId: params.requestId,
      responseCode: params.responseStatusCode ?? 200,
      responseHeaders: responseHeadersForFulfill(params.responseHeaders),
      body: Buffer.from(patchResult.content, "utf8").toString("base64"),
    },
    sessionId,
    commandTimeoutMs,
  );
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
  commandTimeoutMs: number,
): Promise<void> {
  await runtimeCdpCommand(
    cdp,
    "Fetch.enable",
    {
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
    },
    options.sessionId,
    commandTimeoutMs,
  );
  debugRuntime("Fetch.enable ok");
  if (options.waitForInitialLoad || options.reload) {
    await runtimeCdpCommand(
      cdp,
      "Page.enable",
      undefined,
      options.sessionId,
      commandTimeoutMs,
    );
    debugRuntime("Page.enable ok");
  }
  if (options.waitForInitialLoad) {
    await waitForRuntimeInitialPageLoad(cdp);
    debugRuntime("initial page load settled");
  }
  if (options.reload) {
    await runtimeCdpCommand(
      cdp,
      "Page.reload",
      { ignoreCache: true },
      options.sessionId,
      commandTimeoutMs,
    );
    debugRuntime("Page.reload ok");
  }
}

async function enableRuntimePatchAutoAttach(
  cdp: CdpConnection,
  commandTimeoutMs: number,
): Promise<void> {
  await runtimeCdpCommand(
    cdp,
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    },
    undefined,
    commandTimeoutMs,
  );
  debugRuntime("Target.setAutoAttach ok");
}

async function runtimeRendererOriginFromLocation(
  cdp: CdpConnection,
  sessionId: string,
  commandTimeoutMs: number,
): Promise<string> {
  const evaluation = await runtimeCdpCommand<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  }>(
    cdp,
    "Runtime.evaluate",
    {
      expression: "globalThis.location?.href ?? ''",
      returnByValue: true,
    },
    sessionId,
    Math.min(commandTimeoutMs, runtimePatchRendererLocationTimeoutMs),
  );
  if (evaluation?.exceptionDetails) {
    return "";
  }
  return typeof evaluation?.result?.value === "string"
    ? normalizedRuntimeResourceOrigin(evaluation.result.value)
    : "";
}

async function preloadRuntimePatchResources(
  cdp: CdpConnection,
  sessionId: string,
  resourcePaths: string[],
  sleepFor: (ms: number) => Promise<void>,
  commandTimeoutMs: number,
): Promise<void> {
  if (resourcePaths.length === 0) {
    return;
  }
  const resources = JSON.stringify(resourcePaths);
  const expression =
    `Promise.all(${resources}.map(async resourcePath=>{const resourceUrl=new URL(resourcePath,document.baseURI).href;const response=await fetch(resourceUrl);if(!response.ok)throw new Error(\`codexfast preload failed: \${response.status} \${resourceUrl}\`);await response.text();return resourceUrl}))`;
  for (let attempt = 1; attempt <= runtimePatchPreloadMaxAttempts; attempt += 1) {
    try {
      const evaluation = await runtimeCdpCommand<{
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>(
        cdp,
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
        commandTimeoutMs,
      );
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
  const commandTimeoutMs = dependencies.commandTimeoutMs ??
    runtimePatchCommandTimeoutMs;
  const connectTimeoutMs = dependencies.connectTimeoutMs ??
    runtimePatchBrowserConnectTimeoutMs;
  const reconnectObservationTimeoutMs =
    dependencies.reconnectObservationTimeoutMs ??
      runtimePatchReconnectObservationTimeoutMs;
  const reconnectObservationMaxAttempts = Math.max(
    1,
    Math.ceil(
      reconnectObservationTimeoutMs / runtimePatchReconnectObservationPollMs,
    ),
  );
  let cdp = await connectRuntimePatchCdp(
    connect,
    debugPort,
    connectTimeoutMs,
  );
  const observedLabels = new Set<string>();
  const rendererOriginsBySession = new Map<string, string>();
  const pausedRequestHandlers = new Set<Promise<void>>();
  const targetSetupHandlers = new Set<Promise<void>>();
  const initialPreloadHandlers = new Set<Promise<void>>();
  const reconnectObservationTasks = new Set<Promise<void>>();
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
  let reconnectTask: Promise<void> | null = null;
  let reconnectConnectController: AbortController | null = null;
  let resolveLost: (error: Error) => void = () => undefined;
  let resolveCloseSignal: () => void = () => undefined;
  let closeSignalResolved = false;
  let markInitialObserved: () => void = () => undefined;
  let markInitialJavaScriptTraffic: () => void = () => undefined;
  const lost = new Promise<Error>((resolve) => {
    resolveLost = resolve;
  });
  const closeSignal = new Promise<void>((resolve) => {
    resolveCloseSignal = resolve;
  });

  const signalClosed = (): void => {
    if (closeSignalResolved) {
      return;
    }
    closeSignalResolved = true;
    resolveCloseSignal();
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const abortReconnectConnection = (): void => {
    reconnectConnectController?.abort();
  };

  const markSessionLost = (error: Error): void => {
    if (closed) {
      return;
    }
    closed = true;
    connectionGeneration += 1;
    signalClosed();
    stopHeartbeat();
    abortReconnectConnection();
    cdp.close();
    resolveLost(error);
  };

  const generationIsActive = (generation: number): boolean =>
    !closed && generation === connectionGeneration;

  const drainRuntimeHandlers = async (): Promise<void> => {
    while (
      targetSetupHandlers.size > 0 ||
      initialPreloadHandlers.size > 0 ||
      pausedRequestHandlers.size > 0
    ) {
      await Promise.allSettled([
        ...targetSetupHandlers,
        ...initialPreloadHandlers,
        ...pausedRequestHandlers,
      ]);
    }
  };

  const drainReconnectObservationTasks = async (): Promise<void> => {
    while (reconnectObservationTasks.size > 0) {
      await Promise.allSettled([...reconnectObservationTasks]);
    }
  };

  const waitForReconnectDelay = async (milliseconds: number): Promise<boolean> => {
    const outcome = await Promise.race([
      sleepFor(milliseconds).then(() => "elapsed" as const),
      closeSignal.then(() => "closed" as const),
    ]);
    return outcome === "elapsed" && !closed;
  };

  const connectForReconnect = async (): Promise<CdpConnection | null> => {
    const controller = new AbortController();
    reconnectConnectController = controller;
    const pendingConnection = connect(debugPort, controller.signal);
    const timedConnection = cdpCommandWithTimeout(
      pendingConnection,
      connectTimeoutMs,
      "Timed out waiting for the CDP browser connection.",
    );
    try {
      const outcome = await Promise.race([
        timedConnection.then((connection) => ({
          type: "connected" as const,
          connection,
        })),
        closeSignal.then(() => ({ type: "closed" as const })),
      ]);
      if (outcome.type === "closed") {
        controller.abort();
        try {
          const lateConnection = await timedConnection;
          lateConnection.close();
        } catch {
          // The cancelled connection is fully drained before close() returns.
        }
        return null;
      }
      if (closed) {
        outcome.connection.close();
        return null;
      }
      return outcome.connection;
    } catch (error) {
      controller.abort();
      void pendingConnection.then(
        (lateConnection) => lateConnection.close(),
        () => undefined,
      );
      throw error;
    } finally {
      if (reconnectConnectController === controller) {
        reconnectConnectController = null;
      }
    }
  };

  const reconnectRuntimePatchSession = async (reason: Error): Promise<void> => {
    if (closed || reconnecting) {
      return;
    }
    reconnecting = true;
    connectionGeneration += 1;
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
        if (!await waitForReconnectDelay(runtimePatchReconnectDelayMs)) {
          reconnecting = false;
          return;
        }
      }
      printLine(
        `Runtime patch session reconnecting (${attempt}/${runtimePatchReconnectMaxAttempts}); reason: ${runtimePatchLogError(reason)}.`,
      );
      let reconnectGeneration: number | null = null;
      try {
        reconnectSetupError = null;
        activePageSessionId = null;
        attachedPageSessions.clear();
        rendererOriginsBySession.clear();
        const nextCdp = await connectForReconnect();
        if (!nextCdp || closed) {
          nextCdp?.close();
          reconnecting = false;
          return;
        }
        connectionGeneration += 1;
        const activeReconnectGeneration = connectionGeneration;
        reconnectGeneration = activeReconnectGeneration;
        const reconnectObservedLabels = new Set<string>();
        reconnectObservedLabelsByGeneration.set(
          activeReconnectGeneration,
          reconnectObservedLabels,
        );
        cdp = nextCdp;
        registerRuntimeFetchHandler(activeReconnectGeneration);
        registerRuntimeTargetHandler(activeReconnectGeneration);
        const observeReconnect = async (): Promise<void> => {
          await enableRuntimePatchAutoAttach(cdp, commandTimeoutMs);
          if (!generationIsActive(activeReconnectGeneration)) {
            return;
          }
          let preloadedSessionId: string | null = null;
          for (
            let observationAttempt = 1;
            observationAttempt <= reconnectObservationMaxAttempts;
            observationAttempt += 1
          ) {
            await drainRuntimeHandlers();
            if (!generationIsActive(activeReconnectGeneration)) {
              return;
            }
            if (reconnectSetupError) {
              throw reconnectSetupError;
            }
            const boundSessionId =
              activePageSessionId &&
                rendererOriginsBySession.has(activePageSessionId)
                ? activePageSessionId
                : [...attachedPageSessions].find((sessionId) =>
                  rendererOriginsBySession.has(sessionId)
                ) ?? null;
            if (boundSessionId && preloadedSessionId !== boundSessionId) {
              await preloadRuntimePatchResources(
                nextCdp,
                boundSessionId,
                initialResourcePaths,
                async (milliseconds) => {
                  if (!await waitForReconnectDelay(milliseconds)) {
                    throw new Error("Runtime patch session closed.");
                  }
                },
                commandTimeoutMs,
              );
              if (!generationIsActive(activeReconnectGeneration)) {
                return;
              }
              preloadedSessionId = boundSessionId;
              await drainRuntimeHandlers();
            }
            const missingReconnectLabels =
              missingRuntimePatchRequiredInitialLabels(
                reconnectObservedLabels,
                requiredInitialLabels,
              );
            if (boundSessionId && missingReconnectLabels.length === 0) {
              return;
            }
            if (observationAttempt < reconnectObservationMaxAttempts) {
              if (!await waitForReconnectDelay(
                runtimePatchReconnectObservationPollMs,
              )) {
                return;
              }
            }
          }
        };
        let observationTask: Promise<void>;
        observationTask = observeReconnect().finally(() => {
          reconnectObservationTasks.delete(observationTask);
        });
        reconnectObservationTasks.add(observationTask);
        await cdpCommandWithTimeout(
          Promise.race([
            observationTask,
            closeSignal.then(() => undefined),
          ]),
          reconnectObservationTimeoutMs,
          `Timed out after ${reconnectObservationTimeoutMs}ms while observing the reconnected renderer.`,
        );
        if (!generationIsActive(activeReconnectGeneration)) {
          nextCdp.close();
          reconnecting = false;
          return;
        }
        await drainRuntimeHandlers();
        if (reconnectSetupError) {
          throw reconnectSetupError;
        }
        const hasBoundAppRenderer = [...attachedPageSessions].some(
          (sessionId) => rendererOriginsBySession.has(sessionId),
        );
        if (!hasBoundAppRenderer) {
          throw new Error(
            "CDP reconnected without a renderer bound to an app origin.",
          );
        }
        const missingReconnectLabels =
          missingRuntimePatchRequiredInitialLabels(
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
        if (reconnectGeneration !== null) {
          reconnectObservedLabelsByGeneration.delete(reconnectGeneration);
          if (connectionGeneration === reconnectGeneration) {
            connectionGeneration += 1;
          }
        }
        cdp.close();
        if (closed) {
          reconnecting = false;
          return;
        }
        printLine(
          `Runtime patch reconnect attempt ${attempt} failed: ${runtimePatchLogError(lastError)}`,
        );
      }
    }

    reconnecting = false;
    markSessionLost(new Error(runtimePatchSessionLostMessage(lastError)));
  };

  const scheduleRuntimePatchReconnect = (reason: Error): void => {
    if (closed || reconnecting) {
      return;
    }
    let task: Promise<void>;
    task = reconnectRuntimePatchSession(reason)
      .catch((error: unknown) => {
        markSessionLost(
          new Error(runtimePatchSessionLostMessage(asError(error))),
        );
      })
      .finally(() => {
        if (reconnectTask === task) {
          reconnectTask = null;
        }
      });
    reconnectTask = task;
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
    scheduleRuntimePatchReconnect(error);
  };

  const beginInitialResourcePreload = (
    attachedCdp: CdpConnection,
    sessionId: string,
    generation: number,
  ): Promise<void> | null => {
    if (
      initialCompleted ||
      initialPreloadStarted ||
      initialResourcePaths.length === 0 ||
      !generationIsActive(generation) ||
      !rendererOriginsBySession.has(sessionId)
    ) {
      return null;
    }
    initialPreloadStarted = true;
    const task = preloadRuntimePatchResources(
      attachedCdp,
      sessionId,
      initialResourcePaths,
      sleepFor,
      commandTimeoutMs,
    );
    initialPreloadHandlers.add(task);
    task.then(
      () => initialPreloadHandlers.delete(task),
      (error: unknown) => {
        initialPreloadHandlers.delete(task);
        handleConnectionFailure(generation, asError(error));
      },
    );
    return task;
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
      if (!generationIsActive(generation)) {
        return;
      }
      const task = handleFetchRequestPaused(
        attachedCdp,
        patcherSource,
        params as FetchRequestPausedParams,
        message.sessionId,
        (outcome) => {
          if (!generationIsActive(generation)) {
            return;
          }
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
              activePageSessionId = rendererSessionId;
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
        commandTimeoutMs,
      ).then((outcome) => {
        if (!generationIsActive(generation)) {
          return;
        }
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
        const rendererSessionId = message.sessionId;
        if (rendererSessionId) {
          const preloadTask = beginInitialResourcePreload(
            attachedCdp,
            rendererSessionId,
            generation,
          );
          void preloadTask?.catch(() => undefined);
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
            await runtimeCdpCommand(
              attachedCdp,
              "Runtime.runIfWaitingForDebugger",
              undefined,
              attached.sessionId,
              commandTimeoutMs,
            );
          }
          return;
        }
        let targetOrigin = normalizedRuntimeResourceOrigin(targetUrl);
        const pendingAppRenderer = targetUrl === "";
        if (!targetOrigin && !pendingAppRenderer) {
          if (attached.waitingForDebugger) {
            await runtimeCdpCommand(
              attachedCdp,
              "Runtime.runIfWaitingForDebugger",
              undefined,
              attached.sessionId,
              commandTimeoutMs,
            );
          }
          debugRuntime(`ignored non-app page target ${targetUrl}`);
          return;
        }

        attachedPageSessions.add(attached.sessionId);
        if (targetOrigin) {
          rendererOriginsBySession.set(attached.sessionId, targetOrigin);
          activePageSessionId = attached.sessionId;
        }
        debugRuntime(
          `attached target type=${targetType} url=${targetUrl || "<pending>"} session=${attached.sessionId}`,
        );
        await enableRuntimePatchInterception(attachedCdp, {
          sessionId: attached.sessionId,
          waitForInitialLoad: false,
          reload: false,
        }, commandTimeoutMs);
        if (!generationIsActive(generation)) {
          return;
        }
        if (attached.waitingForDebugger) {
          await runtimeCdpCommand(
            attachedCdp,
            "Runtime.runIfWaitingForDebugger",
            undefined,
            attached.sessionId,
            commandTimeoutMs,
          );
          debugRuntime("Runtime.runIfWaitingForDebugger ok");
        }
        if (!targetOrigin) {
          try {
            targetOrigin = await runtimeRendererOriginFromLocation(
              attachedCdp,
              attached.sessionId,
              commandTimeoutMs,
            );
          } catch (error) {
            debugRuntime(
              `could not resolve pending renderer location for session ${attached.sessionId}: ${runtimePatchLogError(asError(error))}`,
            );
          }
          if (!generationIsActive(generation)) {
            return;
          }
          if (targetOrigin) {
            rendererOriginsBySession.set(attached.sessionId, targetOrigin);
            activePageSessionId = attached.sessionId;
            debugRuntime(
              `bound pending renderer session ${attached.sessionId} from location ${targetOrigin}`,
            );
          }
        }
        if (!attached.waitingForDebugger && targetOrigin) {
          await runtimeCdpCommand(
            attachedCdp,
            "Page.reload",
            { ignoreCache: true },
            attached.sessionId,
            commandTimeoutMs,
          );
          debugRuntime("Page.reload ok");
        }
        if (
          !initialCompleted &&
          !initialPreloadStarted &&
          initialResourcePaths.length > 0
        ) {
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
              if (!generationIsActive(generation)) {
                return;
              }
            }
          }
          if (!rendererOriginsBySession.has(attached.sessionId)) {
            debugRuntime(
              `pending renderer session ${attached.sessionId} did not bind to an app origin`,
            );
            return;
          }
          const preloadTask = beginInitialResourcePreload(
            attachedCdp,
            attached.sessionId,
            generation,
          );
          if (preloadTask) {
            await preloadTask;
          }
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
      if (!generationIsActive(generation)) {
        return;
      }
      const detached = params as { sessionId?: string };
      if (!detached.sessionId) {
        return;
      }
      attachedPageSessions.delete(detached.sessionId);
      rendererOriginsBySession.delete(detached.sessionId);
      if (activePageSessionId === detached.sessionId) {
        activePageSessionId = [...attachedPageSessions].find((sessionId) =>
          rendererOriginsBySession.has(sessionId)
        ) ?? null;
      }
    });
  };

  const startHeartbeat = (): void => {
    heartbeatTimer = setInterval(() => {
      if (closed || reconnecting) {
        return;
      }
      if (cdp.isClosed()) {
        scheduleRuntimePatchReconnect(
          new Error("CDP WebSocket connection closed."),
        );
        return;
      }
      void cdpCommandWithTimeout(
        cdp.send("Browser.getVersion"),
        runtimePatchHeartbeatTimeoutMs,
        "Timed out waiting for CDP heartbeat.",
      ).catch((error: unknown) => {
        scheduleRuntimePatchReconnect(asError(error));
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
        void runtimeCdpCommand(
          cdp,
          "Page.reload",
          { ignoreCache: true },
          activePageSessionId,
          commandTimeoutMs,
        )
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
      await enableRuntimePatchAutoAttach(cdp, commandTimeoutMs);
    } catch (error) {
      failSession(asError(error));
    }

    const patchedLabels = await initialSession;
    keepSessionOpen = true;
    startHeartbeat();
    return {
      patchedLabels,
      close: async () => {
        if (!closed) {
          closed = true;
          connectionGeneration += 1;
          signalClosed();
        }
        stopHeartbeat();
        abortReconnectConnection();
        cdp.close();
        const pendingReconnect = reconnectTask;
        if (pendingReconnect) {
          await pendingReconnect.catch(() => undefined);
        }
        await drainReconnectObservationTasks();
        await drainRuntimeHandlers();
      },
      lost,
    };
  } finally {
    if (!keepSessionOpen) {
      closed = true;
      connectionGeneration += 1;
      signalClosed();
      stopHeartbeat();
      abortReconnectConnection();
      cdp.close();
      await drainReconnectObservationTasks();
      await drainRuntimeHandlers();
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
      const lostSession = session;
      session = null;
      if (launchedProcess) {
        await terminateRuntimeLaunchProcess(launchedProcess);
      }
      await lostSession.close();
      printRuntimePatchSessionLost(outcome.error);
      return printExitBlock(1).exitCode;
    }
    await session.close();
    session = null;
    printExitCode(outcome.exitCode);
    return outcome.exitCode;
  } catch (error) {
    const failedSession = session;
    session = null;
    if (launchedProcess) {
      await terminateRuntimeLaunchProcess(launchedProcess);
    }
    if (failedSession) {
      await failedSession.close();
    }
    printLine(`Runtime launch failed: ${asError(error).message}`);
  }

  return printExitBlock(1).exitCode;
}
