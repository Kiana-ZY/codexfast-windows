import { existsSync } from "node:fs";
import { join } from "node:path";

export type CodexfastPlatform = "darwin" | "win32" | "unsupported";

export type AppPaths = {
  bundle: string;
  resources: string;
  infoPlist: string;
  appxManifest: string;
  executable: string;
  appAsar: string;
};

export type AppMetadata = {
  version: string;
  build: string;
  versionKey: string;
  compatibility: string;
  supported: boolean;
  packageName: string;
  packageFullName: string;
  publisher: string;
  packageFamilyName: string;
  applicationId: string;
  appUserModelId: string;
  packageRegistrationVerified: boolean;
  registeredPackageInstallLocations: string[];
};

export type Toolchain = {
  plistBuddy: string;
  powershell: string;
};

export type RuntimeCompatibilityProfile = {
  source: "none" | "whitelist-signatures" | "signature-compatible-update";
  appAsarSha256: string;
  appAsarSize: number;
  appAsarMtimeMs: number;
  appxManifestSha256: string;
  appxManifestSize: number;
  appxManifestMtimeMs: number;
  appxSignaturePath: string;
  appxSignatureSha256: string;
  appxSignatureSize: number;
  appxSignatureMtimeMs: number;
  resourcePaths: string[];
  targets: Array<{
    id: string;
    label: string;
    archivePath: string;
    runtimePath: string;
    contentSha256: string;
    patchedContentSha256: string;
    state: "guarded" | "patched" | "legacy-patched";
  }>;
};

export type CodexfastContext = {
  platform: CodexfastPlatform;
  paths: AppPaths;
  metadata: AppMetadata;
  toolchain: Toolchain;
  runtimeCompatibility: RuntimeCompatibilityProfile;
};

export function createAppPaths(
  appBundle = "/Applications/Codex.app",
  platform: CodexfastPlatform = "darwin",
): AppPaths {
  if (platform === "win32") {
    return {
      bundle: appBundle,
      resources: "",
      infoPlist: "",
      appxManifest: appBundle ? join(appBundle, "AppxManifest.xml") : "",
      executable: "",
      appAsar: "",
    };
  }

  const resources = join(appBundle, "Contents", "Resources");
  return {
    bundle: appBundle,
    resources,
    infoPlist: join(appBundle, "Contents", "Info.plist"),
    appxManifest: "",
    executable: "",
    appAsar: join(resources, "app.asar"),
  };
}

export function emptyAppMetadata(): AppMetadata {
  return {
    version: "unknown",
    build: "unknown",
    versionKey: "unknown+unknown",
    compatibility: "unsupported",
    supported: false,
    packageName: "",
    packageFullName: "",
    publisher: "",
    packageFamilyName: "",
    applicationId: "",
    appUserModelId: "",
    packageRegistrationVerified: false,
    registeredPackageInstallLocations: [],
  };
}

export function emptyToolchain(): Toolchain {
  return {
    plistBuddy: "",
    powershell: "",
  };
}

export function emptyRuntimeCompatibilityProfile(): RuntimeCompatibilityProfile {
  return {
    source: "none",
    appAsarSha256: "",
    appAsarSize: 0,
    appAsarMtimeMs: 0,
    appxManifestSha256: "",
    appxManifestSize: 0,
    appxManifestMtimeMs: 0,
    appxSignaturePath: "",
    appxSignatureSha256: "",
    appxSignatureSize: 0,
    appxSignatureMtimeMs: 0,
    resourcePaths: [],
    targets: [],
  };
}

export function resolveDefaultAppBundle(): string {
  if (existsSync("/Applications/Codex.app")) {
    return "/Applications/Codex.app";
  }
  if (existsSync("/Applications/ChatGPT.app")) {
    return "/Applications/ChatGPT.app";
  }
  return "/Applications/Codex.app";
}

export function codexfastPlatformForProcess(
  platform = process.platform,
): CodexfastPlatform {
  if (platform === "darwin" || platform === "win32") {
    return platform;
  }
  return "unsupported";
}

export function createCodexfastContext(
  appBundle = process.env.CODEXFAST_APP_BUNDLE,
  platform = codexfastPlatformForProcess(),
): CodexfastContext {
  const resolvedBundle = platform === "darwin"
    ? appBundle ?? resolveDefaultAppBundle()
    : appBundle ?? "";
  return {
    platform,
    paths: createAppPaths(resolvedBundle, platform),
    metadata: emptyAppMetadata(),
    toolchain: emptyToolchain(),
    runtimeCompatibility: emptyRuntimeCompatibilityProfile(),
  };
}
