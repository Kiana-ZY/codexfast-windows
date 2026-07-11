import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodexfastContext } from "./cli-context.mts";
import { childEnvWithAutomaticUpdateSetting } from "./cli-update-settings.mts";
import { resolveCommand, run } from "./cli-utils.mts";

export type MacRunningCheck =
  | { ok: true; running: boolean }
  | { ok: false; message: string };

export type MacRuntimeProcess = {
  pid: number;
  waitForExit: () => Promise<number>;
  terminateTree: () => void;
};

export function checkMacCodexRunning(): MacRunningCheck {
  if (process.env.CODEXFAST_TEST_CODEX_RUNNING === "1") {
    return { ok: true, running: true };
  }

  const pgrepBin = resolveCommand("pgrep");
  if (!pgrepBin) {
    return {
      ok: false,
      message:
        "Cannot determine whether Codex.app is running because pgrep was not found.",
    };
  }

  for (const processName of ["Codex", "ChatGPT"]) {
    const result = run(pgrepBin, ["-x", processName]);
    if (result.status === 0) {
      return { ok: true, running: true };
    }
    if (result.status !== 1) {
      return {
        ok: false,
        message: `Cannot determine whether Codex.app is running because pgrep failed with exit code ${result.status}.`,
      };
    }
  }
  return { ok: true, running: false };
}

function macCodexExecutablePathCandidates(
  context: CodexfastContext,
): string[] {
  return [
    join(context.paths.bundle, "Contents", "MacOS", "Codex"),
    join(context.paths.bundle, "Contents", "MacOS", "ChatGPT"),
  ];
}

function macCodexExecutablePath(context: CodexfastContext): string | null {
  return macCodexExecutablePathCandidates(context).find((candidate) =>
    existsSync(candidate)
  ) ?? null;
}

function waitForMacProcessExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(exitCode);
    };

    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 0));
  });
}

function terminateMacProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

export function launchMacCodexProcess(
  context: CodexfastContext,
  debugPort: number,
): MacRuntimeProcess {
  const executable = macCodexExecutablePath(context);
  if (!executable) {
    throw new Error(
      `Codex executable not found: tried ${macCodexExecutablePathCandidates(context).join(", ")}`,
    );
  }

  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: childEnvWithAutomaticUpdateSetting(),
    },
  );
  child.on("error", () => undefined);
  const exit = waitForMacProcessExit(child);
  child.unref();
  return {
    pid: child.pid ?? 0,
    waitForExit: () => exit,
    terminateTree: () => terminateMacProcessTree(child),
  };
}
