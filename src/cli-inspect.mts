import type { CodexfastContext } from "./cli-context.mts";
import { loadWindowsAppEnvironment } from "./cli-platform-windows.mts";
import { applyWindowsRuntimeCompatibility } from "./cli-windows-compatibility.mts";
import { asError, printLine } from "./cli-utils.mts";

export type InspectErrorCode =
  | "INVALID_ARGUMENTS"
  | "UNSUPPORTED_PLATFORM"
  | "WINDOWS_APP_DISCOVERY_FAILED"
  | "WINDOWS_RUNTIME_COMPATIBILITY_FAILED";

export type InspectError = {
  stage: "arguments" | "platform" | "discovery" | "compatibility";
  code: InspectErrorCode;
  message: string;
};

type InspectFileSnapshot = {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
};

type InspectPackage = {
  name: string;
  packageFullName: string;
  version: string;
  versionKey: string;
  publisher: string;
  packageFamilyName: string;
  applicationId: string;
  appUserModelId: string;
  registrationVerified: boolean;
  registeredInstallLocations: string[];
};

type InspectPaths = {
  bundle: string;
  resources: string;
  appxManifest: string;
  executable: string;
  appAsar: string;
};

type InspectCompatibility = {
  source: "whitelist-signatures" | "signature-compatible-update";
  classification: "recorded-static-pass" | "unlisted-signature-compatible";
  description: string;
  staticGatePassed: true;
  runtimeVerificationRequired: true;
  requiredTargetCount: number;
  verifiedTargetCount: number;
};

type InspectTarget = {
  id: string;
  label: string;
  state: "guarded" | "patched" | "legacy-patched";
  archivePath: string;
  runtimePath: string;
  contentSha256: string;
  patchedContentSha256: string;
};

type InspectReportBase = {
  schemaVersion: 1;
  command: "inspect";
  tool: {
    name: "codexfast-windows";
    version: string;
  };
  platform: string;
  scope: {
    readOnly: true;
    codexLaunched: false;
    runtimeVerificationPerformed: false;
    providerConfigurationInspected: false;
  };
  selection: {
    overrides: {
      bundle: boolean;
      executable: boolean;
      appUserModelId: boolean;
    };
  };
  package: InspectPackage | null;
  paths: InspectPaths | null;
};

export type InspectSuccessReport = InspectReportBase & {
  ok: true;
  compatibility: InspectCompatibility;
  snapshots: {
    appxManifest: InspectFileSnapshot;
    appAsar: InspectFileSnapshot;
    appxSignatureFile: InspectFileSnapshot;
  };
  resourcePaths: string[];
  targets: InspectTarget[];
  error: null;
};

export type InspectFailureReport = InspectReportBase & {
  ok: false;
  compatibility: null;
  snapshots: null;
  resourcePaths: string[];
  targets: InspectTarget[];
  error: InspectError;
};

export type InspectReport = InspectSuccessReport | InspectFailureReport;

type ParsedInspectArguments = {
  json: boolean;
  error: string | null;
};

export type RunInspectCommandOptions = {
  context: CodexfastContext;
  args: string[];
  packageVersion: string;
  patcherSource: string;
  supportedWindowsAppVersions: Record<string, string>;
  printActionHeader: () => void;
  environment?: NodeJS.ProcessEnv;
  writeLine?: (line: string) => void;
  loadEnvironment?: typeof loadWindowsAppEnvironment;
  applyCompatibility?: typeof applyWindowsRuntimeCompatibility;
};

export function parseInspectArguments(args: string[]): ParsedInspectArguments {
  const jsonCount = args.filter((arg) => arg === "--json").length;
  const unsupported = args.filter((arg) => arg !== "--json");
  if (unsupported.length > 0) {
    return {
      json: jsonCount > 0,
      error: `Unknown inspect option: ${unsupported.join(", ")}.`,
    };
  }
  if (jsonCount > 1) {
    return {
      json: true,
      error: "inspect accepts --json at most once.",
    };
  }
  return { json: jsonCount === 1, error: null };
}

function inspectScope(): InspectReportBase["scope"] {
  return {
    readOnly: true,
    codexLaunched: false,
    runtimeVerificationPerformed: false,
    providerConfigurationInspected: false,
  };
}

function inspectSelection(
  environment: NodeJS.ProcessEnv,
): InspectReportBase["selection"] {
  return {
    overrides: {
      bundle: Boolean(environment.CODEXFAST_APP_BUNDLE?.trim()),
      executable: Boolean(environment.CODEXFAST_APP_EXECUTABLE?.trim()),
      appUserModelId: Boolean(
        environment.CODEXFAST_APP_USER_MODEL_ID?.trim(),
      ),
    },
  };
}

function inspectPackage(
  context: CodexfastContext,
): InspectReportBase["package"] {
  if (!context.metadata.packageName) {
    return null;
  }
  return {
    name: context.metadata.packageName,
    packageFullName: context.metadata.packageFullName,
    version: context.metadata.version,
    versionKey: context.metadata.versionKey,
    publisher: context.metadata.publisher,
    packageFamilyName: context.metadata.packageFamilyName,
    applicationId: context.metadata.applicationId,
    appUserModelId: context.metadata.appUserModelId,
    registrationVerified: context.metadata.packageRegistrationVerified,
    registeredInstallLocations: [
      ...context.metadata.registeredPackageInstallLocations,
    ],
  };
}

function inspectPaths(context: CodexfastContext): InspectReportBase["paths"] {
  if (!context.paths.bundle) {
    return null;
  }
  return {
    bundle: context.paths.bundle,
    resources: context.paths.resources,
    appxManifest: context.paths.appxManifest,
    executable: context.paths.executable,
    appAsar: context.paths.appAsar,
  };
}

function baseInspectReport(
  context: CodexfastContext,
  packageVersion: string,
  environment: NodeJS.ProcessEnv,
): InspectReportBase {
  return {
    schemaVersion: 1,
    command: "inspect",
    tool: {
      name: "codexfast-windows",
      version: packageVersion,
    },
    platform: context.platform,
    scope: inspectScope(),
    selection: inspectSelection(environment),
    package: inspectPackage(context),
    paths: inspectPaths(context),
  };
}

export function createInspectFailureReport(
  context: CodexfastContext,
  packageVersion: string,
  environment: NodeJS.ProcessEnv,
  error: InspectError,
): InspectFailureReport {
  return {
    ...baseInspectReport(context, packageVersion, environment),
    ok: false,
    compatibility: null,
    snapshots: null,
    resourcePaths: [],
    targets: [],
    error,
  };
}

export function createInspectSuccessReport(
  context: CodexfastContext,
  packageVersion: string,
  environment: NodeJS.ProcessEnv,
): InspectSuccessReport {
  const profile = context.runtimeCompatibility;
  if (
    profile.source !== "whitelist-signatures" &&
    profile.source !== "signature-compatible-update"
  ) {
    throw new Error("Windows runtime compatibility profile is missing.");
  }
  return {
    ...baseInspectReport(context, packageVersion, environment),
    ok: true,
    compatibility: {
      source: profile.source,
      classification: profile.source === "whitelist-signatures"
        ? "recorded-static-pass"
        : "unlisted-signature-compatible",
      description: context.metadata.compatibility,
      staticGatePassed: true,
      runtimeVerificationRequired: true,
      requiredTargetCount: profile.targets.length,
      verifiedTargetCount: profile.targets.length,
    },
    snapshots: {
      appxManifest: {
        path: context.paths.appxManifest,
        sha256: profile.appxManifestSha256,
        size: profile.appxManifestSize,
        mtimeMs: profile.appxManifestMtimeMs,
      },
      appAsar: {
        path: context.paths.appAsar,
        sha256: profile.appAsarSha256,
        size: profile.appAsarSize,
        mtimeMs: profile.appAsarMtimeMs,
      },
      appxSignatureFile: {
        path: profile.appxSignaturePath,
        sha256: profile.appxSignatureSha256,
        size: profile.appxSignatureSize,
        mtimeMs: profile.appxSignatureMtimeMs,
      },
    },
    resourcePaths: [...profile.resourcePaths],
    targets: profile.targets.map((target) => ({ ...target })),
    error: null,
  };
}

function writeInspectJson(
  writeLine: (line: string) => void,
  report: InspectReport,
): void {
  writeLine(JSON.stringify(report, null, 2));
}

export function runInspectCommand(options: RunInspectCommandOptions): number {
  const environment = options.environment ?? process.env;
  const writeLine = options.writeLine ?? printLine;
  const parsed = parseInspectArguments(options.args);
  if (parsed.error) {
    const error: InspectError = {
      stage: "arguments",
      code: "INVALID_ARGUMENTS",
      message: parsed.error,
    };
    if (parsed.json) {
      writeInspectJson(
        writeLine,
        createInspectFailureReport(
          options.context,
          options.packageVersion,
          environment,
          error,
        ),
      );
    } else {
      writeLine(error.message);
      writeLine("Usage: codexfast inspect [--json]");
    }
    return 1;
  }

  if (options.context.platform !== "win32") {
    const error: InspectError = {
      stage: "platform",
      code: "UNSUPPORTED_PLATFORM",
      message: "The inspect command is currently available for Windows MSIX only.",
    };
    if (parsed.json) {
      writeInspectJson(
        writeLine,
        createInspectFailureReport(
          options.context,
          options.packageVersion,
          environment,
          error,
        ),
      );
    } else {
      writeLine(error.message);
    }
    return 1;
  }

  const loadEnvironment = options.loadEnvironment ?? loadWindowsAppEnvironment;
  try {
    loadEnvironment(
      options.context,
      options.supportedWindowsAppVersions,
      undefined,
      environment,
    );
  } catch (caught) {
    const error: InspectError = {
      stage: "discovery",
      code: "WINDOWS_APP_DISCOVERY_FAILED",
      message: asError(caught).message,
    };
    if (parsed.json) {
      writeInspectJson(
        writeLine,
        createInspectFailureReport(
          options.context,
          options.packageVersion,
          environment,
          error,
        ),
      );
    } else {
      writeLine(`Windows app discovery failed: ${error.message}`);
    }
    return 1;
  }

  const applyCompatibility = options.applyCompatibility ??
    applyWindowsRuntimeCompatibility;
  try {
    applyCompatibility(
      options.context,
      options.patcherSource,
      options.supportedWindowsAppVersions,
    );
  } catch (caught) {
    const error: InspectError = {
      stage: "compatibility",
      code: "WINDOWS_RUNTIME_COMPATIBILITY_FAILED",
      message: asError(caught).message,
    };
    if (parsed.json) {
      writeInspectJson(
        writeLine,
        createInspectFailureReport(
          options.context,
          options.packageVersion,
          environment,
          error,
        ),
      );
    } else {
      writeLine(`Windows runtime compatibility failed: ${error.message}`);
    }
    return 1;
  }

  if (parsed.json) {
    writeInspectJson(
      writeLine,
      createInspectSuccessReport(
        options.context,
        options.packageVersion,
        environment,
      ),
    );
    return 0;
  }

  options.printActionHeader();
  writeLine("Verified runtime target resources:");
  for (const target of options.context.runtimeCompatibility.targets) {
    writeLine(
      `  ${target.label} [${target.id}] ${target.state} ${target.archivePath} -> ${target.runtimePath}`,
    );
  }
  writeLine("");
  writeLine("Compatibility inspection completed without launching Codex.");
  return 0;
}
