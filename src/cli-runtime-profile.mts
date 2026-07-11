export const windowsRuntimePatchTargets = [
  {
    id: "speed-setting-destructured-option-count",
    label: "Speed setting",
  },
  {
    id: "speed-service-tier-allowance-26601",
    label: "Speed service tier allowance",
  },
  {
    id: "speed-service-tier-request-allowance-26707",
    label: "Speed service tier request allowance",
  },
  {
    id: "speed-service-tier-conversation-fallback-26707",
    label: "Speed service tier conversation fallback",
  },
  {
    id: "intelligence-speed-menu-options-boolean-code",
    label: "Composer Intelligence Speed menu",
  },
  {
    id: "service-tier-slash-command",
    label: "Fast slash command",
  },
  {
    id: "gpt5x-model-list-options",
    label: "GPT-5.x model list",
  },
  {
    id: "gpt56-model-query-selector",
    label: "GPT-5.6 model query selector",
  },
] as const;

export const runtimePatchWindowsRequiredInitialLabels =
  windowsRuntimePatchTargets.map((target) => target.label);

export const runtimePatchWindowsTargetIds = windowsRuntimePatchTargets.map(
  (target) => target.id,
);

export function runtimePatcherSourceWithTargetFilter(
  patcherSource: string,
  filterDeclaration: string,
): string {
  return `${patcherSource}
${filterDeclaration}
function __codexfastCountSignatureMatches(content, signature) {
  const flags = signature.flags.includes("g") ? signature.flags : signature.flags + "g";
  const matcher = new RegExp(signature.source, flags);
  let count = 0;
  let match;
  while ((match = matcher.exec(content)) !== null) {
    count += 1;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return count;
}
function __codexfastCompatibilityCounts(content, spec) {
  return {
    guardedCount: __codexfastCountSignatureMatches(content, spec.guardedSignature),
    patchedCount: __codexfastCountSignatureMatches(content, spec.patchedSignature),
    legacyPatchedCount: spec.legacyPatchedSignature ? __codexfastCountSignatureMatches(content, spec.legacyPatchedSignature) : 0,
  };
}
function inspectRuntimePatchCompatibility(_resourcePath, body) {
  const results = [];
  for (const spec of TARGET_SPECS) {
    if (!__codexfastShouldUseTarget(spec)) continue;
    const counts = __codexfastCompatibilityCounts(body, spec);
    const totalCount = counts.guardedCount + counts.patchedCount + counts.legacyPatchedCount;
    if (totalCount === 0) continue;
    let state = "ambiguous";
    let replacementVerified = false;
    if (counts.guardedCount === 1 && counts.patchedCount === 0 && counts.legacyPatchedCount === 0) {
      state = "guarded";
      const patchedContent = replaceContent(body, spec.guardedSignature, spec.applyReplacement);
      const after = __codexfastCompatibilityCounts(patchedContent, spec);
      replacementVerified = patchedContent !== body && after.guardedCount === 0 && after.patchedCount === 1 && after.legacyPatchedCount === 0;
    } else if (counts.guardedCount === 0 && counts.patchedCount === 1 && counts.legacyPatchedCount === 0) {
      state = "patched";
      replacementVerified = true;
    } else if (counts.guardedCount === 0 && counts.patchedCount === 0 && counts.legacyPatchedCount === 1 && spec.normalizeReplacement) {
      state = "legacy-patched";
      const normalizedContent = replaceContent(body, spec.legacyPatchedSignature, spec.normalizeReplacement);
      const after = __codexfastCompatibilityCounts(normalizedContent, spec);
      replacementVerified = normalizedContent !== body && after.guardedCount === 0 && after.patchedCount === 1 && after.legacyPatchedCount === 0;
    }
    results.push({ id: spec.id, label: spec.label, state, replacementVerified, ...counts });
  }
  return results;
}
applyRuntimePatchesToBody = function(_resourcePath, body) {
  let content = body;
  const matchedLabels = [];
  const patchedLabels = [];
  const alreadyPatchedLabels = [];
  for (const spec of TARGET_SPECS) {
    if (!__codexfastShouldUseTarget(spec)) {
      continue;
    }
    const match = inspectSpec(content, spec);
    if (!match) {
      continue;
    }
    matchedLabels.push(spec.label);
    if (match.guarded) {
      content = replaceContent(content, spec.guardedSignature, spec.applyReplacement);
      patchedLabels.push(spec.label);
      continue;
    }
    if (match.legacyPatched) {
      content = replaceContentOrThrow(content, spec.legacyPatchedSignature, spec.normalizeReplacement, spec.label);
      patchedLabels.push(spec.label);
      continue;
    }
    if (match.patched) {
      alreadyPatchedLabels.push(spec.label);
    }
  }
  return { content, matchedLabels, patchedLabels, alreadyPatchedLabels };
};`;
}

export function runtimePatcherSourceForWindows(
  patcherSource: string,
): string {
  const allowedTargetIds = JSON.stringify(runtimePatchWindowsTargetIds);
  return runtimePatcherSourceWithTargetFilter(
    patcherSource,
    `
const __codexfastWindowsTargetIds = new Set(${allowedTargetIds});
const __codexfastShouldUseTarget = (spec) => __codexfastWindowsTargetIds.has(spec.id);`,
  );
}
