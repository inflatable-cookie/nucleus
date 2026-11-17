/**
 * The Nucleus build this plugin package came from (Spec 062, phase 7).
 *
 * The release build writes `nucleus-build.json` beside the built plugin it ships
 * under `bb-plugin/`, recording the Nucleus build id. The plugin reads it from its
 * own install and announces it on the executor declaration; the service refuses a
 * plugin from another build with a message that names both and the fix. A plugin
 * installed from a source checkout carries no such file, announces nothing, and is
 * exactly what the private proofs install.
 *
 * The file name and the accepted shape are pinned against `shared/bb-plugin-build.ts`
 * by `test/bb-plugin-install.test.ts`: this package builds from its own directory
 * alone, so it cannot import the shared module across a copy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file the release build writes into the packaged plugin. */
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
