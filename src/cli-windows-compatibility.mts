import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, posix, relative } from "node:path";
import {
  ReadOnlyAsarArchive,
  readOnlyFileContentSnapshotSync,
  readOnlyFileSnapshotSync,
  type ReadOnlyAsarFile,
  type ReadOnlyFileSnapshot,
} from "./cli-asar.mts";
import type {
  CodexfastContext,
  RuntimeCompatibilityProfile,
} from "./cli-context.mts";
import {
  applyRuntimePatchesToResponseBodyWithSource,
  inspectRuntimePatchCompatibilityWithSource,
  type RuntimePatchCompatibilityMatch,
} from "./cli-runtime-patcher.mts";
import { parseAppxManifest } from "./cli-platform-windows.mts";
import {
  runtimePatcherSourceForWindows,
  windowsRuntimePatchTargets,
} from "./cli-runtime-profile.mts";

type WindowsArchiveTargetMatch = {
  inspection: RuntimePatchCompatibilityMatch;
  archivePath: string;
  content: string;
  contentSha256: string;
};

function isJavaScriptArchiveEntry(entry: ReadOnlyAsarFile): boolean {
  return entry.path.toLowerCase().endsWith(".js");
}

function contentSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rendererRuntimePaths(
  archiveFiles: ReadOnlyAsarFile[],
  targetArchivePaths: string[],
): Map<string, string> {
  const rendererRoots = archiveFiles
    .filter((entry) => entry.path === "index.html" || entry.path.endsWith("/index.html"))
    .map((entry) => posix.dirname(entry.path))
    .map((root) => root === "." ? "" : root);
  const candidates = rendererRoots.map((root) => ({
    root,
    runtimePaths: targetArchivePaths.map((archivePath) =>
      root ? posix.relative(root, archivePath) : archivePath
    ),
  })).filter(({ runtimePaths }) =>
    runtimePaths.every((runtimePath) =>
      !runtimePath.startsWith("../") &&
      !posix.isAbsolute(runtimePath) &&
      /^(?:assets|\.vite\/build)\/[^/]+\.js$/u.test(runtimePath)
    )
  );
  if (candidates.length !== 1) {
    const roots = candidates.map((candidate) => candidate.root || "<root>");
    throw new Error(
      `Could not determine one renderer root for Windows runtime resources${roots.length > 0 ? `; candidates: ${roots.join(", ")}` : ""}.`,
    );
  }
  return new Map(
    targetArchivePaths.map((archivePath, index) => [
      archivePath,
      candidates[0].runtimePaths[index],
    ]),
  );
}

function assertFileSnapshot(
  label: string,
  expected: ReadOnlyFileSnapshot,
  actual: ReadOnlyFileSnapshot,
): void {
  if (
    expected.sha256 !== actual.sha256 ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs
  ) {
    throw new Error(`${label} changed after compatibility inspection.`);
  }
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
}

function assertManifestMatchesContext(
  context: CodexfastContext,
  manifestXml: string,
): void {
  const manifest = parseAppxManifest(manifestXml);
  if (
    manifest.identityName !== context.metadata.packageName ||
    manifest.version !== context.metadata.version ||
    manifest.publisher !== context.metadata.publisher
  ) {
    throw new Error(
      "AppxManifest.xml identity changed after Windows package discovery.",
    );
  }
  const application = manifest.applications.find((candidate) =>
    candidate.id.toLowerCase() === context.metadata.applicationId.toLowerCase()
  );
  if (!application) {
    throw new Error(
      `AppxManifest.xml no longer defines Application Id ${context.metadata.applicationId}.`,
    );
  }
  const contextExecutable = normalizedRelativePath(
    relative(context.paths.bundle, context.paths.executable),
  );
  if (normalizedRelativePath(application.executable) !== contextExecutable) {
    throw new Error(
      `AppxManifest.xml executable ${application.executable} no longer matches ${contextExecutable}.`,
    );
  }
}

export function inspectWindowsRuntimeCompatibility(
  context: CodexfastContext,
  patcherSource: string,
  knownVersionDescription: string | undefined,
): RuntimeCompatibilityProfile {
  const filteredPatcherSource = runtimePatcherSourceForWindows(patcherSource);
  const expectedTargets = new Map<string, (typeof windowsRuntimePatchTargets)[number]>(
    windowsRuntimePatchTargets.map((target) => [target.id, target]),
  );
  const matchesByTargetId = new Map<string, WindowsArchiveTargetMatch[]>();
  const targetFileContents = new Map<string, string>();
  const targetFilePatchedHashes = new Map<string, string>();
  const archive = ReadOnlyAsarArchive.open(context.paths.appAsar);
  let appAsarSha256 = "";
  try {
    for (const entry of archive.files) {
      if (!isJavaScriptArchiveEntry(entry)) {
        continue;
      }
      const bodyBuffer = archive.readFile(entry);
      const body = bodyBuffer.toString("utf8");
      const inspections = inspectRuntimePatchCompatibilityWithSource(
        filteredPatcherSource,
        entry.path,
        body,
      );
      if (inspections.length === 0) {
        continue;
      }
      const hash = contentSha256(bodyBuffer);
      targetFileContents.set(entry.path, body);
      for (const inspection of inspections) {
        if (!expectedTargets.has(inspection.id)) {
          throw new Error(
            `Unexpected Windows runtime target ${inspection.id} in ${entry.path}.`,
          );
        }
        const matches = matchesByTargetId.get(inspection.id) ?? [];
        matches.push({
          inspection,
          archivePath: entry.path,
          content: body,
          contentSha256: hash,
        });
        matchesByTargetId.set(inspection.id, matches);
      }
    }

    for (const target of windowsRuntimePatchTargets) {
      const matches = matchesByTargetId.get(target.id) ?? [];
      if (matches.length === 0) {
        throw new Error(
          `Windows compatibility inspection did not find required target: ${target.label} (${target.id}).`,
        );
      }
      if (matches.length !== 1) {
        throw new Error(
          `Windows compatibility inspection found ambiguous target ${target.label} (${target.id}) in: ${matches.map((match) => match.archivePath).join(", ")}.`,
        );
      }
      const match = matches[0];
      const counts = match.inspection;
      if (
        match.inspection.label !== target.label ||
        match.inspection.state === "ambiguous" ||
        !match.inspection.replacementVerified ||
        counts.guardedCount + counts.patchedCount + counts.legacyPatchedCount !== 1
      ) {
        throw new Error(
          `Windows compatibility inspection could not verify ${target.label} (${target.id}) in ${match.archivePath}: state=${match.inspection.state}, guarded=${counts.guardedCount}, patched=${counts.patchedCount}, legacy=${counts.legacyPatchedCount}.`,
        );
      }
    }

    for (const [archivePath, body] of targetFileContents) {
      const targetLabels = windowsRuntimePatchTargets
        .filter((target) =>
          (matchesByTargetId.get(target.id) ?? []).some((match) =>
            match.archivePath === archivePath
          )
        )
        .map((target) => target.label);
      const firstPass = applyRuntimePatchesToResponseBodyWithSource(
        filteredPatcherSource,
        archivePath,
        body,
      );
      for (const label of targetLabels) {
        if (
          !firstPass.patchedLabels.includes(label) &&
          !firstPass.alreadyPatchedLabels.includes(label)
        ) {
          throw new Error(
            `Combined Windows patch verification did not observe ${label} in ${archivePath}.`,
          );
        }
      }
      const secondPass = applyRuntimePatchesToResponseBodyWithSource(
        filteredPatcherSource,
        archivePath,
        firstPass.content,
      );
      if (secondPass.content !== firstPass.content) {
        throw new Error(
          `Combined Windows patch verification was not idempotent for ${archivePath}.`,
        );
      }
      for (const label of targetLabels) {
        if (!secondPass.alreadyPatchedLabels.includes(label)) {
          throw new Error(
            `Combined Windows patch verification did not re-recognize ${label} in ${archivePath}.`,
          );
        }
      }
      targetFilePatchedHashes.set(
        archivePath,
        contentSha256(firstPass.content),
      );
    }

    appAsarSha256 = archive.sha256();
    archive.assertUnchanged();
  } finally {
    archive.close();
  }

  const targetMatches = windowsRuntimePatchTargets.map((target) =>
    (matchesByTargetId.get(target.id) ?? [])[0]
  );
  const archivePaths = [...new Set(
    targetMatches.map((match) => match.archivePath),
  )];
  const runtimePaths = rendererRuntimePaths(archive.files, archivePaths);
  const appxManifest = readOnlyFileContentSnapshotSync(
    context.paths.appxManifest,
  );
  assertManifestMatchesContext(
    context,
    appxManifest.content.toString("utf8"),
  );
  const appxSignaturePath = join(context.paths.bundle, "AppxSignature.p7x");
  if (!existsSync(appxSignaturePath)) {
    throw new Error(`MSIX signature file not found: ${appxSignaturePath}.`);
  }
  const appxSignature = readOnlyFileSnapshotSync(appxSignaturePath);
  const targets = targetMatches.map((match, index) => ({
    id: windowsRuntimePatchTargets[index].id,
    label: windowsRuntimePatchTargets[index].label,
    archivePath: match.archivePath,
    runtimePath: runtimePaths.get(match.archivePath)!,
    contentSha256: match.contentSha256,
    patchedContentSha256: targetFilePatchedHashes.get(match.archivePath)!,
    state: match.inspection.state as "guarded" | "patched" | "legacy-patched",
  }));

  return {
    source: knownVersionDescription
      ? "whitelist-signatures"
      : "signature-compatible-update",
    appAsarSha256,
    appAsarSize: archive.initialStat.size,
    appAsarMtimeMs: archive.initialStat.mtimeMs,
    appxManifestSha256: appxManifest.sha256,
    appxManifestSize: appxManifest.size,
    appxManifestMtimeMs: appxManifest.mtimeMs,
    appxSignaturePath,
    appxSignatureSha256: appxSignature.sha256,
    appxSignatureSize: appxSignature.size,
    appxSignatureMtimeMs: appxSignature.mtimeMs,
    resourcePaths: [...new Set(targets.map((target) => target.runtimePath))],
    targets,
  };
}

export function applyWindowsRuntimeCompatibility(
  context: CodexfastContext,
  patcherSource: string,
  supportedWindowsAppVersions: Record<string, string>,
): void {
  const knownVersionDescription =
    supportedWindowsAppVersions[context.metadata.versionKey];
  const profile = inspectWindowsRuntimeCompatibility(
    context,
    patcherSource,
    knownVersionDescription,
  );
  context.runtimeCompatibility = profile;
  context.metadata.supported = true;
  context.metadata.compatibility = knownVersionDescription
    ? `supported (${knownVersionDescription}); runtime target patterns statically verified; runtime target verification required`
    : "unlisted registered update; all required runtime target patterns statically verified; runtime target verification required";
}

export function verifyWindowsRuntimeCompatibilitySnapshot(
  context: CodexfastContext,
): void {
  const profile = context.runtimeCompatibility;
  if (profile.source === "none") {
    throw new Error("Windows runtime compatibility profile is missing.");
  }
  assertFileSnapshot(
    "app.asar",
    {
      sha256: profile.appAsarSha256,
      size: profile.appAsarSize,
      mtimeMs: profile.appAsarMtimeMs,
    },
    readOnlyFileSnapshotSync(context.paths.appAsar),
  );
  assertFileSnapshot(
    "AppxManifest.xml",
    {
      sha256: profile.appxManifestSha256,
      size: profile.appxManifestSize,
      mtimeMs: profile.appxManifestMtimeMs,
    },
    readOnlyFileSnapshotSync(context.paths.appxManifest),
  );
  assertFileSnapshot(
    "AppxSignature.p7x",
    {
      sha256: profile.appxSignatureSha256,
      size: profile.appxSignatureSize,
      mtimeMs: profile.appxSignatureMtimeMs,
    },
    readOnlyFileSnapshotSync(profile.appxSignaturePath),
  );
}
