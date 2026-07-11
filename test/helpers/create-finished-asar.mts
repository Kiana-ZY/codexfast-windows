import { createPackage } from "@electron/asar";
import { rmSync } from "node:fs";
import { finished } from "node:stream/promises";

export async function createFinishedAsar(
  source: string,
  destination: string,
): Promise<void> {
  rmSync(destination, { force: true });
  const stream = await createPackage(source, destination);
  await finished(stream);
}
