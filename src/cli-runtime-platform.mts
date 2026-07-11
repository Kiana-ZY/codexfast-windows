import type { CodexfastContext } from "./cli-context.mts";
import {
  checkMacCodexRunning,
  launchMacCodexProcess,
} from "./cli-platform-macos.mts";
import {
  checkWindowsCodexRunning,
  launchWindowsCodexProcess,
} from "./cli-platform-windows.mts";

export type RuntimeRunningCheck =
  | { ok: true; running: boolean }
  | { ok: false; message: string };

export type RuntimeLaunchProcess = {
  pid: number;
  waitForExit: () => Promise<number>;
  terminateTree: () => void | Promise<void>;
};

export type RuntimeLaunchPlatformOperations = {
  checkRunning: (context: CodexfastContext) => RuntimeRunningCheck;
  launch: (
    context: CodexfastContext,
    debugPort: number,
  ) => RuntimeLaunchProcess;
};

export const defaultRuntimeLaunchPlatformOperations: RuntimeLaunchPlatformOperations = {
  checkRunning: (context) => {
    if (context.platform === "win32") {
      return checkWindowsCodexRunning(context);
    }
    return checkMacCodexRunning();
  },
  launch: (context, debugPort) => {
    if (context.platform === "win32") {
      return launchWindowsCodexProcess(context, debugPort);
    }
    return launchMacCodexProcess(context, debugPort);
  },
};
