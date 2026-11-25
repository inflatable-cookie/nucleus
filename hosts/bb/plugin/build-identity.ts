/**
 * The Nucleus build this plugin package came from (Spec 062, phase 7).
 *
 * Historical installed packages carried a build identity. The plugin announces
 * it on the executor declaration so the old service can reject another build.
 * The private sidebar proof installs from source and announces no build.
 *
 * The file name and accepted shape match the old package's build record.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The build record written into historical packaged plugins. */
export const NUCLEUS_BUILD_FILE = "nucleus-build.json";

// The packaged build's full SHA-256, or a source service's shorter identity; the
// service compares the announced value against its own build exactly.
const BUILD_ID = /^[a-f0-9]{8,64}$/;

function readFrom(directory: string): string | null {
  try {
    const record = JSON.parse(
      readFileSync(join(directory, NUCLEUS_BUILD_FILE), "utf8"),
    ) as {
      buildId?: unknown;
    };
    return typeof record.buildId === "string" && BUILD_ID.test(record.buildId)
      ? record.buildId
      : null;
  } catch {
    return null;
  }
}

/**
 * The build id this plugin was packaged from, or null.
 *
 * The module lives in `dist/` in a built plugin and in the package root in a
 * checkout, so both layouts are read; anything else answers null rather than a
 * guess.
 */
export function readNucleusBuild(moduleUrl: string): string | null {
  let directory: string;
  try {
    directory = dirname(fileURLToPath(moduleUrl));
  } catch {
    return null;
  }
  return readFrom(directory) ?? readFrom(dirname(directory));
}
