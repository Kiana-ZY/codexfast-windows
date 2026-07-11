import { printLine } from "./cli-utils.mts";

export type CliExitStatus = {
  exitCode: number;
};

export type CliActionDetails = {
  codexfastVersion: string;
  platform: string;
  bundle: string;
  resources: string;
  appxManifest: string;
  executable: string;
  appAsar: string;
  version: string;
  build: string;
  compatibility: string;
  packageName: string;
  packageFullName: string;
  publisher: string;
  packageFamilyName: string;
  applicationId: string;
  appUserModelId: string;
  patchTargets: string[];
  compatibilitySource: string;
  appAsarSha256: string;
};

export function printActionHeaderBlock(action: string, details: CliActionDetails): void {
  printLine("");
  printLine(`Action: ${action}`);
  printLine(`codexfast version: ${details.codexfastVersion}`);
  printLine(`Platform: ${details.platform}`);
  if (details.platform === "win32") {
    printLine(`MSIX package: ${details.packageName}`);
    printLine(`PackageFullName: ${details.packageFullName}`);
    printLine(`Publisher: ${details.publisher}`);
    printLine(`MSIX directory: ${details.bundle}`);
    printLine(`AppxManifest: ${details.appxManifest}`);
    printLine(`Executable: ${details.executable}`);
    printLine(`app.asar: ${details.appAsar}`);
    printLine(`Package Family Name: ${details.packageFamilyName}`);
    printLine(`Application Id: ${details.applicationId}`);
    printLine(`AUMID: ${details.appUserModelId}`);
    printLine(`Detected MSIX version: ${details.version}`);
    printLine(`Compatibility source: ${details.compatibilitySource}`);
    printLine(`app.asar SHA-256: ${details.appAsarSha256}`);
    printLine(`Required patch targets: ${details.patchTargets.join(", ")}`);
  }
  printLine(`Resources: ${details.resources}`);
  if (details.platform !== "win32") {
    printLine(`Detected version: ${details.version}`);
    printLine(`Detected build: ${details.build}`);
  }
  printLine(`Compatibility: ${details.compatibility}`);
  printLine("Mode: self-contained single file");
  printLine("");
}

export function printExitCode(exitCode: number): CliExitStatus {
  printLine(`Exit code: ${exitCode}`);
  return { exitCode };
}

export function printExitBlock(exitCode: number): CliExitStatus {
  printLine("");
  return printExitCode(exitCode);
}
