import { existsSync, readFileSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  win32,
} from "node:path";
import type { CodexfastContext } from "./cli-context.mts";
import { asError, run, sleep } from "./cli-utils.mts";

export type WindowsCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type WindowsCommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv },
) => WindowsCommandResult;

export type AppxManifestApplication = {
  id: string;
  executable: string;
  entryPoint: string;
};

export type ParsedAppxManifest = {
  identityName: string;
  publisher: string;
  processorArchitecture: string;
  version: string;
  applications: AppxManifestApplication[];
};

export type WindowsAppsPackagePath = {
  packageDirectoryName: string;
  packageName: string;
  version: string;
  architecture: string;
  resourceId: string;
  publisherId: string;
  packageFamilyName: string;
};

export type WindowsPackageCandidate = {
  name: string;
  packageFullName: string;
  packageFamilyName: string;
  installLocation: string;
  publisher: string;
  version: string;
};

export type WindowsTask = {
  imageName: string;
  pid: number;
};

export type WindowsProcessIdentity = {
  pid: number;
  processName: string;
  executablePath: string;
  startTimeUtc: string;
  commandLine?: string;
};

export type WindowsRunningCheck =
  | { ok: true; running: boolean }
  | { ok: false; message: string };

export type WindowsTaskSnapshot =
  | { ok: true; tasks: WindowsTask[] }
  | { ok: false; message: string };

export type WindowsRuntimeProcess = {
  pid: number;
  identity: WindowsProcessIdentity;
  waitForExit: () => Promise<number>;
  terminateTree: () => Promise<void>;
};

export type WindowsProcessLifecycleOptions = {
  pollIntervalMs?: number;
  terminationPollIntervalMs?: number;
  terminationPollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const windowsPackageNames = new Set(["OpenAI.Codex", "OpenAI.CodexBeta"]);
const windowsOpenAiPublisher =
  "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
const windowsProcessNames = ["ChatGPT.exe", "Codex.exe"];
const windowsTaskPollIntervalMs = 1_000;
const windowsTerminationPollIntervalMs = 100;
const windowsTerminationPollAttempts = 20;
const windowsActivationStartToleranceMs = 250;

function decodeXmlAttribute(value: string): string {
  return value.replace(
    /&(?:quot|apos|lt|gt|amp);|&#(?:x[0-9a-f]+|[0-9]+);/gi,
    (entity) => {
      const named: Record<string, string> = {
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&amp;": "&",
      };
      const namedValue = named[entity.toLowerCase()];
      if (namedValue !== undefined) {
        return namedValue;
      }
      const numeric = entity.slice(2, -1);
      const codePoint = numeric[0]?.toLowerCase() === "x"
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function parseXmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? "";
    attributes.set(name, decodeXmlAttribute(value));
  }
  return attributes;
}

function requiredXmlAttribute(
  attributes: Map<string, string>,
  name: string,
  elementName: string,
): string {
  const value = attributes.get(name)?.trim() ?? "";
  if (!value) {
    throw new Error(`AppxManifest.xml ${elementName} is missing ${name}.`);
  }
  return value;
}

export function parseAppxManifest(xml: string): ParsedAppxManifest {
  const source = xml.replace(/<!--[\s\S]*?-->/g, "");
  const identityMatch = source.match(
    /<(?:[A-Za-z_][\w.-]*:)?Identity\b([^>]*)\/?\s*>/i,
  );
  if (!identityMatch) {
    throw new Error("AppxManifest.xml does not contain a Package Identity.");
  }
  const identity = parseXmlAttributes(identityMatch[1]);
  const applications: AppxManifestApplication[] = [];
  const applicationPattern = /<(?:[A-Za-z_][\w.-]*:)?Application\b([^>]*)>/gi;
  for (const match of source.matchAll(applicationPattern)) {
    const attributes = parseXmlAttributes(match[1]);
    applications.push({
      id: requiredXmlAttribute(attributes, "Id", "Application"),
      executable: requiredXmlAttribute(
        attributes,
        "Executable",
        "Application",
      ).replaceAll("/", "\\"),
      entryPoint: attributes.get("EntryPoint")?.trim() ?? "",
    });
  }
  if (applications.length === 0) {
    throw new Error("AppxManifest.xml does not contain an Application entry.");
  }

  return {
    identityName: requiredXmlAttribute(identity, "Name", "Identity"),
    publisher: requiredXmlAttribute(identity, "Publisher", "Identity"),
    processorArchitecture: identity.get("ProcessorArchitecture")?.trim() ?? "",
    version: requiredXmlAttribute(identity, "Version", "Identity"),
    applications,
  };
}

export function deriveAppUserModelId(
  packageFamilyName: string,
  applicationId: string,
): string {
  const family = packageFamilyName.trim();
  const application = applicationId.trim();
  if (!family || !application) {
    throw new Error(
      "Package Family Name and Application Id are required to build an AUMID.",
    );
  }
  return `${family}!${application}`;
}

export function parseWindowsAppsPackagePath(
  packagePath: string,
): WindowsAppsPackagePath | null {
  const normalizedPath = normalize(packagePath).replace(/[\\/]+$/, "");
  const pathMatch = normalizedPath.match(
    /(?:^|[\\/])Program Files[\\/]WindowsApps[\\/]([^\\/]+)$/i,
  );
  if (!pathMatch) {
    return null;
  }
  const packageDirectoryName = pathMatch[1];
  const packageMatch = packageDirectoryName.match(
    /^(.+)_([0-9]+(?:\.[0-9]+){3})_(x64|x86|arm64|neutral)_([^_]*)_([A-Za-z0-9]+)$/i,
  );
  if (!packageMatch) {
    return null;
  }
  const [, packageName, version, architecture, resourceId, publisherId] =
    packageMatch;
  return {
    packageDirectoryName,
    packageName,
    version,
    architecture,
    resourceId,
    publisherId,
    packageFamilyName: `${packageName}_${publisherId}`,
  };
}

function compareWindowsVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function parseWindowsPackageCandidates(
  json: string,
): WindowsPackageCandidate[] {
  if (!json.trim()) {
    return [];
  }
  const parsed = JSON.parse(json) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const candidates: WindowsPackageCandidate[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    const candidate = {
      name: String(record.Name ?? ""),
      packageFullName: String(record.PackageFullName ?? ""),
      packageFamilyName: String(record.PackageFamilyName ?? ""),
      installLocation: String(record.InstallLocation ?? ""),
      publisher: String(record.Publisher ?? ""),
      version: String(record.Version ?? ""),
    };
    if (
      windowsPackageNames.has(candidate.name) &&
      candidate.packageFullName &&
      candidate.packageFamilyName &&
      candidate.installLocation &&
      candidate.publisher &&
      candidate.version
    ) {
      candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => {
    const namePriority = Number(left.name === "OpenAI.CodexBeta") -
      Number(right.name === "OpenAI.CodexBeta");
    return namePriority ||
      compareWindowsVersionsDescending(left.version, right.version);
  });
}

export function windowsPackageDiscoveryPowerShell(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$names = @('OpenAI.Codex', 'OpenAI.CodexBeta')
$packages = @(Get-AppxPackage | Where-Object { $names -contains $_.Name } | ForEach-Object {
  [pscustomobject]@{
    Name = $_.Name
    PackageFullName = $_.PackageFullName
    PackageFamilyName = $_.PackageFamilyName
    InstallLocation = $_.InstallLocation
    Publisher = $_.Publisher
    Version = $_.Version.ToString()
  }
})
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $packages))`;
}

export function discoverWindowsPackages(
  powershell: string,
  runner: WindowsCommandRunner = run,
): WindowsPackageCandidate[] {
  const result = runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsPackageDiscoveryPowerShell(),
  ]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`Get-AppxPackage failed: ${detail}`);
  }
  try {
    return parseWindowsPackageCandidates(result.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse Get-AppxPackage output: ${asError(error).message}`,
    );
  }
}

export function resolveWindowsPowerShell(): string | null {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const candidate = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (existsSync(candidate)) {
    return candidate;
  }
  return null;
}

function selectManifestApplication(
  manifest: ParsedAppxManifest,
  executableOverride: string | undefined,
  applicationIdOverride: string,
): AppxManifestApplication {
  const applicationById = applicationIdOverride
    ? manifest.applications.find((application) =>
      application.id.toLowerCase() === applicationIdOverride.toLowerCase()
    )
    : undefined;
  if (applicationIdOverride && !applicationById) {
    throw new Error(
      `CODEXFAST_APP_USER_MODEL_ID references Application Id ${applicationIdOverride}, but AppxManifest.xml does not define it.`,
    );
  }

  let applicationByExecutable: AppxManifestApplication | undefined;
  if (executableOverride) {
    const overrideName = win32.basename(executableOverride).toLowerCase();
    applicationByExecutable = manifest.applications.find((application) =>
      win32.basename(application.executable).toLowerCase() === overrideName
    );
    if (!applicationByExecutable) {
      throw new Error(
        `CODEXFAST_APP_EXECUTABLE ${executableOverride} does not match an Application executable in AppxManifest.xml.`,
      );
    }
  }

  if (
    applicationById &&
    applicationByExecutable &&
    applicationById.id !== applicationByExecutable.id
  ) {
    throw new Error(
      `CODEXFAST_APP_EXECUTABLE selects Application Id ${applicationByExecutable.id}, but CODEXFAST_APP_USER_MODEL_ID selects ${applicationById.id}.`,
    );
  }

  if (applicationByExecutable || applicationById) {
    return applicationByExecutable ?? applicationById!;
  }
  return manifest.applications.find((application) =>
    windowsProcessNames.some((processName) =>
      processName.toLowerCase() ===
        win32.basename(application.executable).toLowerCase()
    )
  ) ?? manifest.applications[0];
}

function executablePathForWindowsApp(
  bundle: string,
  manifestExecutable: string,
  executableOverride: string | undefined,
): string {
  const manifestPath = resolve(bundle, manifestExecutable);
  const configured = executableOverride?.trim() || manifestExecutable;
  const executablePath = isAbsolute(configured)
    ? normalize(configured)
    : resolve(bundle, configured);
  if (!windowsPathIsWithin(bundle, executablePath)) {
    throw new Error(
      `CODEXFAST_APP_EXECUTABLE must resolve inside the selected MSIX bundle: ${executablePath}.`,
    );
  }
  if (
    windowsPathForComparison(executablePath) !==
      windowsPathForComparison(manifestPath)
  ) {
    throw new Error(
      `CODEXFAST_APP_EXECUTABLE must resolve to the exact executable declared by AppxManifest.xml: ${manifestPath}.`,
    );
  }
  return executablePath;
}

function packageFamilyNameFromAumid(aumid: string | undefined): string {
  const separatorIndex = aumid?.indexOf("!") ?? -1;
  return separatorIndex > 0 ? aumid!.slice(0, separatorIndex) : "";
}

function applicationIdFromAumid(aumid: string | undefined): string {
  const separatorIndex = aumid?.indexOf("!") ?? -1;
  return separatorIndex > 0 ? aumid!.slice(separatorIndex + 1) : "";
}

function sameWindowsIdentityValue(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function windowsPathForComparison(value: string): string {
  return win32.normalize(value.replace(/^\\\\\?\\/u, ""))
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function windowsPathIsWithin(root: string, candidate: string): boolean {
  const normalizedRoot = windowsPathForComparison(root);
  const normalizedCandidate = windowsPathForComparison(candidate);
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`);
}

export function validateWindowsPackageIdentity(
  bundle: string,
  manifest: ParsedAppxManifest,
  packageCandidate: WindowsPackageCandidate | null,
  parsedPackagePath: WindowsAppsPackagePath | null,
): void {
  if (
    packageCandidate &&
    (
      !sameWindowsIdentityValue(packageCandidate.name, manifest.identityName) ||
      !sameWindowsIdentityValue(packageCandidate.version, manifest.version) ||
      !sameWindowsIdentityValue(packageCandidate.publisher, manifest.publisher)
    )
  ) {
    throw new Error(
      `MSIX registration ${packageCandidate.name} ${packageCandidate.version} ${packageCandidate.publisher} does not match AppxManifest.xml ${manifest.identityName} ${manifest.version} ${manifest.publisher}.`,
    );
  }

  if (packageCandidate) {
    const installDirectoryName = win32.basename(
      win32.normalize(packageCandidate.installLocation),
    );
    const bundleDirectoryName = win32.basename(win32.normalize(bundle));
    if (
      !sameWindowsIdentityValue(
        packageCandidate.packageFullName,
        installDirectoryName,
      ) ||
      !sameWindowsIdentityValue(
        packageCandidate.packageFullName,
        bundleDirectoryName,
      )
    ) {
      throw new Error(
        `MSIX registration PackageFullName ${packageCandidate.packageFullName} does not match install directory ${bundleDirectoryName}.`,
      );
    }
  }

  if (
    parsedPackagePath &&
    (
      !sameWindowsIdentityValue(
        parsedPackagePath.packageName,
        manifest.identityName,
      ) ||
      !sameWindowsIdentityValue(parsedPackagePath.version, manifest.version) ||
      (
        manifest.processorArchitecture &&
        !sameWindowsIdentityValue(
          parsedPackagePath.architecture,
          manifest.processorArchitecture,
        )
      )
    )
  ) {
    throw new Error(
      `WindowsApps directory ${parsedPackagePath.packageDirectoryName} does not match AppxManifest.xml identity ${manifest.identityName} ${manifest.version} ${manifest.processorArchitecture || "<unspecified architecture>"}.`,
    );
  }

  if (
    packageCandidate &&
    parsedPackagePath &&
    (
      !sameWindowsIdentityValue(
        packageCandidate.packageFullName,
        parsedPackagePath.packageDirectoryName,
      ) ||
      !sameWindowsIdentityValue(
        packageCandidate.packageFamilyName,
        parsedPackagePath.packageFamilyName,
      )
    )
  ) {
    throw new Error(
      `MSIX registration identity ${packageCandidate.packageFullName} / ${packageCandidate.packageFamilyName} does not match WindowsApps path identity ${parsedPackagePath.packageDirectoryName} / ${parsedPackagePath.packageFamilyName}.`,
    );
  }
}

export function loadWindowsAppEnvironment(
  context: CodexfastContext,
  supportedWindowsAppVersions: Record<string, string>,
  runner: WindowsCommandRunner = run,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const powershell = resolveWindowsPowerShell();
  if (!powershell) {
    throw new Error(
      "Windows PowerShell was not found. codexfast does not request administrator privileges; install/restore Windows PowerShell or set the Windows app overrides after it is available.",
    );
  }
  context.toolchain.powershell = powershell;

  const configuredBundle = environment.CODEXFAST_APP_BUNDLE?.trim() ||
    context.paths.bundle.trim();
  let packageCandidate: WindowsPackageCandidate | null = null;
  let bundle = configuredBundle;
  let packageDiscoveryError: Error | null = null;
  let candidates: WindowsPackageCandidate[] = [];
  try {
    candidates = discoverWindowsPackages(powershell, runner);
  } catch (error) {
    packageDiscoveryError = asError(error);
  }
  if (!bundle) {
    if (packageDiscoveryError) {
      throw packageDiscoveryError;
    }
    packageCandidate = candidates[0] ?? null;
    if (!packageCandidate) {
      throw new Error(
        "OpenAI.Codex/OpenAI.CodexBeta MSIX was not discoverable for the current user. No administrator privileges were requested. Set CODEXFAST_APP_BUNDLE to the package directory; set CODEXFAST_APP_EXECUTABLE and CODEXFAST_APP_USER_MODEL_ID as needed.",
      );
    }
    bundle = packageCandidate.installLocation;
  } else {
    packageCandidate = candidates.find((candidate) =>
      windowsPathForComparison(candidate.installLocation) ===
        windowsPathForComparison(bundle)
    ) ?? null;
  }

  const appxManifest = join(bundle, "AppxManifest.xml");
  if (!existsSync(appxManifest)) {
    throw new Error(
      `AppxManifest.xml was not found or is not readable at ${appxManifest}. No administrator privileges were requested. Set CODEXFAST_APP_BUNDLE and CODEXFAST_APP_USER_MODEL_ID to accessible explicit values.`,
    );
  }
  let manifestXml: string;
  try {
    manifestXml = readFileSync(appxManifest, "utf8");
  } catch (error) {
    throw new Error(
      `AppxManifest.xml could not be read at ${appxManifest}: ${asError(error).message}. No administrator privileges were requested; use the CODEXFAST_APP_* overrides if needed.`,
    );
  }
  const manifest = parseAppxManifest(manifestXml);
  if (!windowsPackageNames.has(manifest.identityName)) {
    throw new Error(
      `Unsupported MSIX identity ${manifest.identityName}; expected OpenAI.Codex or OpenAI.CodexBeta.`,
    );
  }
  if (!sameWindowsIdentityValue(manifest.publisher, windowsOpenAiPublisher)) {
    throw new Error(
      `Unsupported MSIX publisher ${manifest.publisher}; expected ${windowsOpenAiPublisher}.`,
    );
  }

  const manifestVersionKey = `${manifest.identityName}+${manifest.version}`;
  const knownVersion = Object.prototype.hasOwnProperty.call(
    supportedWindowsAppVersions,
    manifestVersionKey,
  );
  if (!packageCandidate && !knownVersion) {
    const discoveryDetail = packageDiscoveryError
      ? ` Package discovery failed: ${packageDiscoveryError.message}.`
      : "";
    throw new Error(
      `Unlisted Windows versions require an exact current-user MSIX registration match for ${bundle}.${discoveryDetail} CODEXFAST_APP_* overrides cannot establish trust for automatic compatibility by themselves.`,
    );
  }

  const parsedPackagePath = parseWindowsAppsPackagePath(bundle);
  validateWindowsPackageIdentity(
    bundle,
    manifest,
    packageCandidate,
    parsedPackagePath,
  );
  const configuredAumid = environment.CODEXFAST_APP_USER_MODEL_ID?.trim() ?? "";
  if (configuredAumid && !/^[^!]+![^!]+$/u.test(configuredAumid)) {
    throw new Error(
      "CODEXFAST_APP_USER_MODEL_ID must use the PackageFamilyName!ApplicationId form.",
    );
  }
  const configuredExecutable = environment.CODEXFAST_APP_EXECUTABLE;
  const application = selectManifestApplication(
    manifest,
    configuredExecutable,
    applicationIdFromAumid(configuredAumid),
  );
  const executable = executablePathForWindowsApp(
    bundle,
    application.executable,
    configuredExecutable,
  );
  const resources = join(dirname(executable), "resources");
  const appAsar = join(resources, "app.asar");
  if (!existsSync(executable)) {
    throw new Error(
      `Codex executable not found: ${executable}. Set CODEXFAST_APP_EXECUTABLE to the installed executable path or its path relative to CODEXFAST_APP_BUNDLE.`,
    );
  }
  if (!existsSync(appAsar)) {
    throw new Error(`Codex app.asar not found: ${appAsar}`);
  }

  const registeredPackageFamilyName = packageCandidate?.packageFamilyName ||
    parsedPackagePath?.packageFamilyName || "";
  if (!registeredPackageFamilyName) {
    throw new Error(
      "Package Family Name could not be verified from the current-user MSIX registration or WindowsApps path. CODEXFAST_APP_USER_MODEL_ID cannot establish package identity by itself.",
    );
  }
  const configuredPackageFamilyName = packageFamilyNameFromAumid(
    configuredAumid,
  );
  if (
    configuredPackageFamilyName &&
    !sameWindowsIdentityValue(
      configuredPackageFamilyName,
      registeredPackageFamilyName,
    )
  ) {
    throw new Error(
      `CODEXFAST_APP_USER_MODEL_ID Package Family Name ${configuredPackageFamilyName} does not match the selected MSIX ${registeredPackageFamilyName}.`,
    );
  }
  const appUserModelId = configuredAumid ||
    deriveAppUserModelId(registeredPackageFamilyName, application.id);

  context.paths.bundle = bundle;
  context.paths.resources = resources;
  context.paths.infoPlist = "";
  context.paths.appxManifest = appxManifest;
  context.paths.executable = executable;
  context.paths.appAsar = appAsar;
  context.metadata.version = manifest.version;
  context.metadata.build = "MSIX";
  context.metadata.versionKey = `${manifest.identityName}+${manifest.version}`;
  context.metadata.packageName = manifest.identityName;
  context.metadata.packageFullName = packageCandidate?.packageFullName ||
    parsedPackagePath?.packageDirectoryName || "";
  context.metadata.publisher = manifest.publisher;
  context.metadata.packageFamilyName = registeredPackageFamilyName;
  context.metadata.applicationId = appUserModelId.slice(
    appUserModelId.indexOf("!") + 1,
  );
  context.metadata.appUserModelId = appUserModelId;
  context.metadata.packageRegistrationVerified = packageCandidate !== null;
  context.metadata.registeredPackageInstallLocations = candidates.map(
    (candidate) => candidate.installLocation,
  );
  context.metadata.supported = Object.prototype.hasOwnProperty.call(
    supportedWindowsAppVersions,
    context.metadata.versionKey,
  );
  context.metadata.compatibility = context.metadata.supported
    ? `supported (${supportedWindowsAppVersions[context.metadata.versionKey]}); runtime target verification required${configuredAumid ? "; explicit AUMID override" : ""}`
    : "unsupported";
}

function parseCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) {
    return null;
  }
  fields.push(value);
  return fields;
}

export function parseTasklistCsv(output: string): WindowsTask[] {
  const tasks: WindowsTask[] = [];
  const normalizedOutput = output.replace(/\u0000/g, "");
  for (const rawLine of normalizedOutput.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\uFEFF/u, "");
    if (!line.startsWith('"')) {
      continue;
    }
    const fields = parseCsvLine(line);
    const pid = Number.parseInt(fields?.[1] ?? "", 10);
    if (fields && fields[0] && Number.isInteger(pid) && pid > 0) {
      tasks.push({ imageName: fields[0], pid });
    }
  }
  return tasks;
}

function tasklistForImage(
  imageName: string,
  runner: WindowsCommandRunner,
): WindowsCommandResult {
  return runner("tasklist.exe", [
    "/FI",
    `IMAGENAME eq ${imageName}`,
    "/FO",
    "CSV",
    "/NH",
  ]);
}

export function checkWindowsCodexRunning(
  context: CodexfastContext,
  runner: WindowsCommandRunner = run,
): WindowsRunningCheck {
  if (process.env.CODEXFAST_TEST_CODEX_RUNNING === "1") {
    return { ok: true, running: true };
  }
  const snapshot = snapshotWindowsCodexTasks(context, runner);
  return snapshot.ok
    ? { ok: true, running: snapshot.tasks.length > 0 }
    : snapshot;
}

export function snapshotWindowsCodexTasks(
  context: CodexfastContext,
  runner: WindowsCommandRunner = run,
): WindowsTaskSnapshot {
  const names = new Set(windowsProcessNames);
  if (context.paths.executable) {
    names.add(win32.basename(context.paths.executable));
  }
  const tasks: WindowsTask[] = [];
  for (const imageName of names) {
    const result = tasklistForImage(imageName, runner);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.status}`;
      return {
        ok: false,
        message: `Cannot determine whether Codex is running because tasklist failed for ${imageName}: ${detail}`,
      };
    }
    for (const task of parseTasklistCsv(result.stdout)) {
      if (
        task.imageName.toLowerCase() === imageName.toLowerCase() &&
        !tasks.some((existing) => existing.pid === task.pid)
      ) {
        tasks.push(task);
      }
    }
  }
  if (tasks.length === 0) {
    return { ok: true, tasks: [] };
  }
  if (!context.paths.bundle || !context.toolchain.powershell) {
    return {
      ok: false,
      message:
        "Cannot distinguish Codex Desktop from Codex CLI processes because the MSIX bundle or PowerShell path is unavailable.",
    };
  }

  let identities: WindowsProcessIdentity[];
  try {
    identities = queryWindowsProcessIdentities(
      context.toolchain.powershell,
      tasks.map((task) => task.pid),
      runner,
    );
  } catch (error) {
    return {
      ok: false,
      message:
        `Cannot determine whether Codex Desktop is running: ${asError(error).message}`,
    };
  }
  const identitiesByPid = new Map(
    identities.map((identity) => [identity.pid, identity]),
  );
  const desktopTasks: WindowsTask[] = [];
  for (const task of tasks) {
    const identity = identitiesByPid.get(task.pid);
    if (!identity) {
      continue;
    }
    if (
      normalizedWindowsProcessName(identity.processName) !==
        normalizedWindowsProcessName(task.imageName)
    ) {
      continue;
    }
    if (!identity.executablePath) {
      return {
        ok: false,
        message:
          `Cannot determine whether PID ${task.pid} is Codex Desktop because its executable path is unavailable.`,
      };
    }
    const registeredBundleRoots = [
      context.paths.bundle,
      ...context.metadata.registeredPackageInstallLocations,
    ];
    if (
      registeredBundleRoots.some((bundleRoot) =>
        bundleRoot && windowsPathIsWithin(bundleRoot, identity.executablePath)
      )
    ) {
      desktopTasks.push(task);
    }
  }
  return { ok: true, tasks: desktopTasks };
}

export function buildWindowsActivationArguments(debugPort: number): string[] {
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65_535) {
    throw new Error(`Invalid remote debugging port: ${debugPort}`);
  }
  return [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
  ];
}

function quoteWindowsCommandLineArgument(argument: string): string {
  if (argument && !/[\s"]/.test(argument)) {
    return argument;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

export function windowsActivationCommandLine(debugPort: number): string {
  return buildWindowsActivationArguments(debugPort)
    .map(quoteWindowsCommandLineArgument)
    .join(" ");
}

export function applicationActivationPowerShellSource(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = @"
using System;
using System.Runtime.InteropServices;

namespace Codexfast.Windows {
  [Flags]
  public enum ActivateOptions : uint {
    None = 0x00000000
  }

  [ComImport]
  [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig]
    int ActivateApplication(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments,
      ActivateOptions options,
      out uint processId);
    [PreserveSig]
    int ActivateForFile(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      [MarshalAs(UnmanagedType.LPWStr)] string verb,
      out uint processId);
    [PreserveSig]
    int ActivateForProtocol(
      [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
      IntPtr itemArray,
      out uint processId);
  }

  [ComImport]
  [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
  class ApplicationActivationManager {}

  public static class Activation {
    public static uint Activate(string appUserModelId, string arguments) {
      var manager = (IApplicationActivationManager)new ApplicationActivationManager();
      uint processId;
      int result = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
      Marshal.ThrowExceptionForHR(result);
      return processId;
    }
  }
}
"@
Add-Type -TypeDefinition $source -Language CSharp
if ($env:CODEXFAST_ACTIVATION_COMPILE_ONLY -eq '1') {
  [Console]::Out.WriteLine('compiled')
  exit 0
}
$processId = [Codexfast.Windows.Activation]::Activate(
  $env:CODEXFAST_ACTIVATION_AUMID,
  $env:CODEXFAST_ACTIVATION_ARGUMENTS
)
[Console]::Out.WriteLine($processId)`;
}

function windowsActivationEnvironment(
  context: CodexfastContext | null,
  debugPort: number | null,
  compileOnly: boolean,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CODEXFAST_ACTIVATION_COMPILE_ONLY;
  delete env.CODEXFAST_ACTIVATION_AUMID;
  delete env.CODEXFAST_ACTIVATION_ARGUMENTS;
  if (compileOnly) {
    env.CODEXFAST_ACTIVATION_COMPILE_ONLY = "1";
  } else if (context && debugPort != null) {
    env.CODEXFAST_ACTIVATION_AUMID = context.metadata.appUserModelId;
    env.CODEXFAST_ACTIVATION_ARGUMENTS = windowsActivationCommandLine(debugPort);
  }
  return env;
}

export function compileWindowsActivationHelper(
  powershell: string,
  runner: WindowsCommandRunner = run,
): void {
  const result = runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    applicationActivationPowerShellSource(),
  ], {
    env: windowsActivationEnvironment(null, null, true),
  });
  if (result.status !== 0 || !result.stdout.split(/\r?\n/).includes("compiled")) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      `exit code ${result.status}`;
    throw new Error(`Windows activation helper compilation failed: ${detail}`);
  }
}

export function activateWindowsApplication(
  context: CodexfastContext,
  debugPort: number,
  runner: WindowsCommandRunner = run,
): number {
  const result = runner(context.toolchain.powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    applicationActivationPowerShellSource(),
  ], {
    env: windowsActivationEnvironment(context, debugPort, false),
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`IApplicationActivationManager failed: ${detail}`);
  }
  let pidLine = "";
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    if (/^\d+$/.test(line.trim())) {
      pidLine = line.trim();
    }
  }
  const pid = Number.parseInt(pidLine ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `IApplicationActivationManager returned an invalid process id: ${result.stdout.trim() || "<empty>"}`,
    );
  }
  return pid;
}

export function windowsProcessIdentityPowerShellSource(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$processIds = @(
  $env:CODEXFAST_PROCESS_IDS -split ',' |
    ForEach-Object { [int]$_.Trim() } |
    Where-Object { $_ -gt 0 }
)
$identities = @(
  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      continue
    }
    $executablePath = ''
    $startTimeUtc = ''
    $commandLine = ''
    try { $executablePath = $process.Path } catch {}
    try {
      $startTimeUtc = $process.StartTime.ToUniversalTime().ToString(
        'o',
        [System.Globalization.CultureInfo]::InvariantCulture
      )
    } catch {}
    try {
      $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId"
      if ($null -ne $cimProcess) {
        $commandLine = [string]$cimProcess.CommandLine
      }
    } catch {}
    [pscustomobject]@{
      Pid = $process.Id
      ProcessName = $process.ProcessName
      ExecutablePath = $executablePath
      StartTimeUtc = $startTimeUtc
      CommandLine = $commandLine
    }
  }
)
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $identities))`;
}

export function queryWindowsProcessIdentities(
  powershell: string,
  pids: number[],
  runner: WindowsCommandRunner = run,
): WindowsProcessIdentity[] {
  const uniquePids = [...new Set(pids)];
  if (
    uniquePids.length === 0 ||
    uniquePids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new Error(`Invalid Windows process ids: ${pids.join(", ")}`);
  }
  const env = {
    ...process.env,
    CODEXFAST_PROCESS_IDS: uniquePids.join(","),
  };
  const result = runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsProcessIdentityPowerShellSource(),
  ], { env });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(
      `Could not inspect process IDs ${uniquePids.join(", ")}: ${detail}`,
    );
  }
  const output = result.stdout.trim().replace(/^\uFEFF/u, "");
  if (!output) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Could not parse process identities for ${uniquePids.join(", ")}: ${asError(error).message}`,
    );
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const requestedPids = new Set(uniquePids);
  const identities: WindowsProcessIdentity[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") {
      throw new Error("A Windows process identity was not an object.");
    }
    const record = value as Record<string, unknown>;
    const identity: WindowsProcessIdentity = {
      pid: Number(record.Pid),
      processName: String(record.ProcessName ?? "").trim(),
      executablePath: String(record.ExecutablePath ?? "").trim(),
      startTimeUtc: String(record.StartTimeUtc ?? "").trim(),
      commandLine: String(record.CommandLine ?? "").trim(),
    };
    if (
      !requestedPids.has(identity.pid) ||
      identities.some((existing) => existing.pid === identity.pid) ||
      !identity.processName ||
      !identity.startTimeUtc ||
      !Number.isFinite(Date.parse(identity.startTimeUtc))
    ) {
      throw new Error(
        `Process identity for PID ${identity.pid || "<invalid>"} is incomplete or unexpected; refusing unsafe process ownership assumptions.`,
      );
    }
    identities.push(identity);
  }
  return identities;
}

export function queryWindowsProcessIdentity(
  powershell: string,
  pid: number,
  runner: WindowsCommandRunner = run,
): WindowsProcessIdentity | null {
  return queryWindowsProcessIdentities(powershell, [pid], runner)[0] ?? null;
}

type WindowsProcessTerminationHelperResult = {
  state: "exited" | "mismatch" | "completed";
  taskkillExitCode?: number;
  taskkillStdout?: string;
  taskkillStderr?: string;
  originalExited?: boolean;
};

export function windowsProcessTerminationPowerShellSource(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($env:CODEXFAST_TERMINATION_COMPILE_ONLY -eq '1') {
  [Console]::Out.WriteLine('compiled')
  exit 0
}
$processId = [int]$env:CODEXFAST_TERMINATE_PID
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($null -eq $process) {
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
    State = 'exited'
  })))
  exit 0
}
$handleAcquired = $false
try {
  $heldHandle = $process.Handle
  $handleAcquired = $true
} catch {}
if (-not $handleAcquired) {
  $process.Dispose()
  throw "Could not acquire a stable handle for PID $processId; refusing unsafe termination."
}
$actualPath = ''
$actualStartTime = $null
try { $actualPath = $process.Path } catch {}
try { $actualStartTime = $process.StartTime.ToUniversalTime() } catch {}
$expectedName = [System.IO.Path]::GetFileNameWithoutExtension(
  $env:CODEXFAST_TERMINATE_PROCESS_NAME
)
$expectedStartTime = [DateTime]::Parse(
  $env:CODEXFAST_TERMINATE_START_TIME_UTC,
  [System.Globalization.CultureInfo]::InvariantCulture,
  [System.Globalization.DateTimeStyles]::RoundtripKind
).ToUniversalTime()
$identityMatches =
  [System.StringComparer]::OrdinalIgnoreCase.Equals(
    $process.ProcessName,
    $expectedName
  ) -and
  [System.StringComparer]::OrdinalIgnoreCase.Equals(
    $actualPath,
    $env:CODEXFAST_TERMINATE_EXECUTABLE_PATH
  ) -and
  $null -ne $actualStartTime -and
  $actualStartTime.Ticks -eq $expectedStartTime.Ticks
if (-not $identityMatches) {
  $process.Dispose()
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
    State = 'mismatch'
  })))
  exit 0
}
$taskkill = [System.Diagnostics.Process]::new()
$taskkill.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$taskkill.StartInfo.FileName = 'taskkill.exe'
$taskkill.StartInfo.Arguments = "/PID $processId /T /F"
$taskkill.StartInfo.UseShellExecute = $false
$taskkill.StartInfo.CreateNoWindow = $true
$taskkill.StartInfo.RedirectStandardOutput = $true
$taskkill.StartInfo.RedirectStandardError = $true
[void]$taskkill.Start()
$taskkillStdout = $taskkill.StandardOutput.ReadToEnd()
$taskkillStderr = $taskkill.StandardError.ReadToEnd()
$taskkill.WaitForExit()
$taskkillExitCode = $taskkill.ExitCode
$originalExited = $process.HasExited
$taskkill.Dispose()
$process.Dispose()
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([pscustomobject]@{
  State = 'completed'
  TaskkillExitCode = $taskkillExitCode
  TaskkillStdout = $taskkillStdout
  TaskkillStderr = $taskkillStderr
  OriginalExited = $originalExited
})))`;
}

function windowsProcessTerminationEnvironment(
  identity: WindowsProcessIdentity | null,
  compileOnly: boolean,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CODEXFAST_TERMINATION_COMPILE_ONLY;
  delete env.CODEXFAST_TERMINATE_PID;
  delete env.CODEXFAST_TERMINATE_PROCESS_NAME;
  delete env.CODEXFAST_TERMINATE_EXECUTABLE_PATH;
  delete env.CODEXFAST_TERMINATE_START_TIME_UTC;
  if (compileOnly) {
    env.CODEXFAST_TERMINATION_COMPILE_ONLY = "1";
  } else if (identity) {
    env.CODEXFAST_TERMINATE_PID = String(identity.pid);
    env.CODEXFAST_TERMINATE_PROCESS_NAME = identity.processName;
    env.CODEXFAST_TERMINATE_EXECUTABLE_PATH = identity.executablePath;
    env.CODEXFAST_TERMINATE_START_TIME_UTC = identity.startTimeUtc;
  }
  return env;
}

export function compileWindowsProcessTerminationHelper(
  powershell: string,
  runner: WindowsCommandRunner = run,
): void {
  const result = runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsProcessTerminationPowerShellSource(),
  ], {
    env: windowsProcessTerminationEnvironment(null, true),
  });
  if (result.status !== 0 || !result.stdout.split(/\r?\n/).includes("compiled")) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      `exit code ${result.status}`;
    throw new Error(`Windows process termination helper compilation failed: ${detail}`);
  }
}

function runWindowsProcessTerminationHelper(
  identity: WindowsProcessIdentity,
  powershell: string,
  runner: WindowsCommandRunner,
): WindowsProcessTerminationHelperResult {
  const result = runner(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsProcessTerminationPowerShellSource(),
  ], {
    env: windowsProcessTerminationEnvironment(identity, false),
  });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() ||
      `exit code ${result.status}`;
    throw new Error(
      `Could not safely terminate launched PID ${identity.pid}: ${detail}`,
    );
  }
  const output = result.stdout.trim().replace(/^\uFEFF/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Could not parse process termination result for PID ${identity.pid}: ${asError(error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `Process termination result for PID ${identity.pid} was not an object.`,
    );
  }
  const value = parsed as Record<string, unknown>;
  const state = String(value.State ?? "");
  if (state !== "exited" && state !== "mismatch" && state !== "completed") {
    throw new Error(
      `Process termination result for PID ${identity.pid} had invalid state ${state || "<empty>"}.`,
    );
  }
  return {
    state,
    taskkillExitCode: value.TaskkillExitCode == null
      ? undefined
      : Number(value.TaskkillExitCode),
    taskkillStdout: value.TaskkillStdout == null
      ? undefined
      : String(value.TaskkillStdout),
    taskkillStderr: value.TaskkillStderr == null
      ? undefined
      : String(value.TaskkillStderr),
    originalExited: value.OriginalExited == null
      ? undefined
      : Boolean(value.OriginalExited),
  };
}

function normalizedWindowsProcessName(value: string): string {
  return value.trim().replace(/\.exe$/iu, "").toLowerCase();
}

export function sameWindowsProcessIdentity(
  left: WindowsProcessIdentity,
  right: WindowsProcessIdentity,
): boolean {
  if (
    left.pid !== right.pid ||
    normalizedWindowsProcessName(left.processName) !==
      normalizedWindowsProcessName(right.processName) ||
    left.startTimeUtc !== right.startTimeUtc
  ) {
    return false;
  }
  if (!left.executablePath || !right.executablePath) {
    return false;
  }
  return windowsPathForComparison(left.executablePath) ===
    windowsPathForComparison(right.executablePath);
}

export function validateWindowsProcessIdentityForLaunch(
  context: CodexfastContext,
  identity: WindowsProcessIdentity,
  activationStartedAt: number,
  activationCompletedAt: number,
  debugPort: number,
): void {
  const expectedProcessName = normalizedWindowsProcessName(
    win32.basename(context.paths.executable),
  );
  if (
    normalizedWindowsProcessName(identity.processName) !== expectedProcessName
  ) {
    throw new Error(
      `IApplicationActivationManager returned PID ${identity.pid} for ${identity.processName}, expected ${win32.basename(context.paths.executable)}. Refusing to claim process ownership.`,
    );
  }
  if (
    !identity.executablePath ||
    windowsPathForComparison(identity.executablePath) !==
      windowsPathForComparison(context.paths.executable)
  ) {
    throw new Error(
      `IApplicationActivationManager returned PID ${identity.pid} at ${identity.executablePath || "<unreadable>"}, expected ${context.paths.executable}. Refusing to claim process ownership.`,
    );
  }
  const processStartTime = Date.parse(identity.startTimeUtc);
  if (
    processStartTime < activationStartedAt - windowsActivationStartToleranceMs ||
    processStartTime > activationCompletedAt + windowsActivationStartToleranceMs
  ) {
    throw new Error(
      `IApplicationActivationManager returned PID ${identity.pid} with start time ${identity.startTimeUtc}, outside this activation window. Refusing to claim process ownership.`,
    );
  }
  const commandLine = identity.commandLine ?? "";
  const requiredArguments = buildWindowsActivationArguments(debugPort);
  for (const argument of requiredArguments) {
    const escapedArgument = argument.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?:^|\\s)"?${escapedArgument}"?(?=\\s|$)`, "u").test(commandLine)) {
      throw new Error(
        `IApplicationActivationManager returned PID ${identity.pid} without this launch's ${argument} argument. Refusing to claim process ownership.`,
      );
    }
  }
}

function tasklistContainsPid(
  pid: number,
  runner: WindowsCommandRunner,
): boolean {
  const result = runner("tasklist.exe", [
    "/FI",
    `PID eq ${pid}`,
    "/FO",
    "CSV",
    "/NH",
  ]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`tasklist failed while monitoring PID ${pid}: ${detail}`);
  }
  return parseTasklistCsv(result.stdout).some((task) => task.pid === pid);
}

export async function waitForWindowsProcessExit(
  identity: WindowsProcessIdentity,
  powershell: string,
  runner: WindowsCommandRunner = run,
  pollIntervalMs = windowsTaskPollIntervalMs,
  sleepFor = sleep,
): Promise<number> {
  while (tasklistContainsPid(identity.pid, runner)) {
    const current = queryWindowsProcessIdentity(
      powershell,
      identity.pid,
      runner,
    );
    if (!current || !sameWindowsProcessIdentity(identity, current)) {
      return 0;
    }
    await sleepFor(pollIntervalMs);
  }
  return 0;
}

export async function terminateWindowsProcessTree(
  identity: WindowsProcessIdentity,
  powershell: string,
  runner: WindowsCommandRunner = run,
  options: WindowsProcessLifecycleOptions = {},
): Promise<void> {
  const termination = runWindowsProcessTerminationHelper(
    identity,
    powershell,
    runner,
  );
  if (termination.state === "exited") {
    return;
  }
  if (termination.state === "mismatch") {
    throw new Error(
      `Refusing to terminate PID ${identity.pid} because it no longer belongs to the process launched by codexfast.`,
    );
  }
  const taskkillExitCode = termination.taskkillExitCode;
  if (!Number.isInteger(taskkillExitCode)) {
    throw new Error(
      `Process termination helper did not report a taskkill exit code for PID ${identity.pid}.`,
    );
  }
  if (taskkillExitCode !== 0) {
    if (termination.originalExited) {
      return;
    }
    const detail = termination.taskkillStderr?.trim() ||
      termination.taskkillStdout?.trim() || `exit code ${taskkillExitCode}`;
    throw new Error(
      `taskkill failed for launched PID ${identity.pid}: ${detail}`,
    );
  }
  if (termination.originalExited) {
    return;
  }

  const pollAttempts = options.terminationPollAttempts ??
    windowsTerminationPollAttempts;
  const pollIntervalMs = options.terminationPollIntervalMs ??
    windowsTerminationPollIntervalMs;
  const sleepFor = options.sleep ?? sleep;
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const remaining = queryWindowsProcessIdentity(
      powershell,
      identity.pid,
      runner,
    );
    if (!remaining || !sameWindowsProcessIdentity(identity, remaining)) {
      return;
    }
    if (attempt + 1 < pollAttempts) {
      await sleepFor(pollIntervalMs);
    }
  }
  throw new Error(
    `Launched PID ${identity.pid} was still running after taskkill completed.`,
  );
}

export function launchWindowsCodexProcess(
  context: CodexfastContext,
  debugPort: number,
  runner: WindowsCommandRunner = run,
  options: WindowsProcessLifecycleOptions = {},
): WindowsRuntimeProcess {
  if (context.metadata.packageRegistrationVerified) {
    const registeredPackage = discoverWindowsPackages(
      context.toolchain.powershell,
      runner,
    ).find((candidate) =>
      sameWindowsIdentityValue(
        candidate.packageFullName,
        context.metadata.packageFullName,
      )
    );
    if (
      !registeredPackage ||
      !sameWindowsIdentityValue(
        registeredPackage.packageFamilyName,
        context.metadata.packageFamilyName,
      ) ||
      windowsPathForComparison(registeredPackage.installLocation) !==
        windowsPathForComparison(context.paths.bundle) ||
      !sameWindowsIdentityValue(
        registeredPackage.publisher,
        context.metadata.publisher,
      )
    ) {
      throw new Error(
        `The selected MSIX registration changed after compatibility inspection: ${context.metadata.packageFullName}.`,
      );
    }
  } else if (
    context.runtimeCompatibility.source === "signature-compatible-update"
  ) {
    throw new Error(
      "An unlisted Windows version cannot be activated without an exact registered PackageFullName.",
    );
  }
  const preActivationSnapshot = snapshotWindowsCodexTasks(context, runner);
  if (!preActivationSnapshot.ok) {
    throw new Error(preActivationSnapshot.message);
  }
  if (preActivationSnapshot.tasks.length > 0) {
    throw new Error(
      "Codex started after the initial process check. Fully quit Codex and retry so codexfast cannot attach to an existing instance.",
    );
  }

  const activationStartedAt = Date.now();
  const pid = activateWindowsApplication(context, debugPort, runner);
  const activationCompletedAt = Date.now();
  if (preActivationSnapshot.tasks.some((task) => task.pid === pid)) {
    throw new Error(
      `IApplicationActivationManager returned pre-existing PID ${pid}; refusing to claim or terminate it.`,
    );
  }
  let identity: WindowsProcessIdentity | null = null;
  try {
    identity = queryWindowsProcessIdentity(
      context.toolchain.powershell,
      pid,
      runner,
    );
    if (!identity) {
      throw new Error(
        `IApplicationActivationManager returned PID ${pid}, but it exited before codexfast could establish ownership.`,
      );
    }
    validateWindowsProcessIdentityForLaunch(
      context,
      identity,
      activationStartedAt,
      activationCompletedAt,
      debugPort,
    );
  } catch (error) {
    throw new Error(
      `${asError(error).message} Activation returned PID ${pid}; it was not terminated because safe ownership could not be established.`,
    );
  }

  let observedExited = false;
  const sleepFor = options.sleep ?? sleep;
  return {
    pid,
    identity,
    waitForExit: async () => {
      if (observedExited) {
        return 0;
      }
      const exitCode = await waitForWindowsProcessExit(
        identity,
        context.toolchain.powershell,
        runner,
        options.pollIntervalMs ?? windowsTaskPollIntervalMs,
        sleepFor,
      );
      observedExited = true;
      return exitCode;
    },
    terminateTree: async () => {
      if (observedExited) {
        return;
      }
      await terminateWindowsProcessTree(
        identity,
        context.toolchain.powershell,
        runner,
        options,
      );
      observedExited = true;
    },
  };
}
