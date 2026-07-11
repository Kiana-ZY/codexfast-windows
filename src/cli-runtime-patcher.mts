import { asError, printLine } from "./cli-utils.mts";

export type RuntimePatchResult = {
  content: string;
  matchedLabels: string[];
  patchedLabels: string[];
  alreadyPatchedLabels: string[];
};

export type RuntimePatchCompatibilityMatch = {
  id: string;
  label: string;
  state: "guarded" | "patched" | "legacy-patched" | "ambiguous";
  replacementVerified: boolean;
  guardedCount: number;
  patchedCount: number;
  legacyPatchedCount: number;
};

type RuntimePatchEngine = {
  apply: (resourcePath: string, body: string) => RuntimePatchResult;
  inspectCompatibility:
    | ((resourcePath: string, body: string) => RuntimePatchCompatibilityMatch[])
    | null;
};

let runtimePatchEngineSource = "";
let runtimePatchEngine: RuntimePatchEngine | null = null;

function runtimePatchEngineForSource(patcherSource: string): RuntimePatchEngine {
  if (runtimePatchEngine && runtimePatchEngineSource === patcherSource) {
    return runtimePatchEngine;
  }
  const factory = new Function(
    `${patcherSource}\nreturn {apply:applyRuntimePatchesToBody,inspectCompatibility:typeof inspectRuntimePatchCompatibility==="function"?inspectRuntimePatchCompatibility:null};`,
  ) as () => unknown;
  const candidate = factory() as Partial<RuntimePatchEngine> | null;
  if (!candidate || typeof candidate.apply !== "function") {
    throw new Error("Embedded runtime patch engine is unavailable.");
  }
  runtimePatchEngineSource = patcherSource;
  runtimePatchEngine = {
    apply: candidate.apply,
    inspectCompatibility:
      typeof candidate.inspectCompatibility === "function"
        ? candidate.inspectCompatibility
        : null,
  };
  return runtimePatchEngine;
}

export function applyRuntimePatchesToResponseBodyWithSource(
  patcherSource: string,
  resourcePath: string,
  body: string,
): RuntimePatchResult {
  return runtimePatchEngineForSource(patcherSource).apply(resourcePath, body);
}

export function inspectRuntimePatchCompatibilityWithSource(
  patcherSource: string,
  resourcePath: string,
  body: string,
): RuntimePatchCompatibilityMatch[] {
  const inspectCompatibility = runtimePatchEngineForSource(patcherSource)
    .inspectCompatibility;
  if (!inspectCompatibility) {
    throw new Error(
      "Embedded runtime patch engine does not expose compatibility inspection.",
    );
  }
  return inspectCompatibility(resourcePath, body);
}

export function isRuntimeJavaScriptResource(resourceUrl: string): boolean {
  return /^app:\/\/[^?#]+\/(?:(?:webview\/)?assets|\.vite\/build)\/[^/?#]+\.js(?:[?#].*)?$/.test(
    resourceUrl,
  );
}

export function runRuntimeUrlSelfTest(): number {
  const acceptedUrls = [
    "app://-/assets/index-DxnGmFpS.js",
    "app://-/assets/index-DxnGmFpS.js?v=1",
    "app://-/webview/assets/index.js",
    "app://codex.local/webview/assets/chunk.js#hash",
    "app://-/.vite/build/bootstrap.js",
    "app://-/.vite/build/src-UHYOvFd-.js",
  ];
  const rejectedUrls = [
    "app://-/index.html",
    "app://-/assets/style.css",
    "https://example.com/assets/index.js",
    "app://-/assets/nested/index.js",
  ];

  for (const url of acceptedUrls) {
    if (!isRuntimeJavaScriptResource(url)) {
      printLine(`Runtime URL self-test failed: expected accepted ${url}`);
      return 1;
    }
  }

  for (const url of rejectedUrls) {
    if (isRuntimeJavaScriptResource(url)) {
      printLine(`Runtime URL self-test failed: expected rejected ${url}`);
      return 1;
    }
  }

  printLine("Runtime URL self-test passed");
  return 0;
}

export function runRuntimePatchBodySourceSelfTest(patcherSource: string): number {
  const body =
    "settings.agent.speed.label;n=se(),{serviceTierSettings:r,setServiceTier:i}=fe();if(!n)return null;let o;";
  let result: RuntimePatchResult;
  try {
    result = applyRuntimePatchesToResponseBodyWithSource(
      patcherSource,
      "app://-/assets/general-settings-demo.js",
      body,
    );
  } catch (error) {
    printLine(`Runtime patch body self-test failed: ${asError(error).message}`);
    return 1;
  }

  if (
    !result.content.includes(
      "{serviceTierSettings:r,setServiceTier:i}=fe();let o;",
    ) ||
    !result.patchedLabels.includes("Speed setting")
  ) {
    printLine("Runtime patch body self-test failed");
    return 1;
  }

  printLine("Runtime patch body self-test passed");
  return 0;
}
