import { compiledIdentity } from "../runtime.mjs";
/**
 * Shared service build identity. Pure module: importable by the bridge side
 * (which must never load the runtime) and by the service itself.
 */
import { RPC_METHOD_NAMES } from "../rpc-catalogue";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, buildIdentity } from "./protocol";

/** Manual override, including the one-time roll from the old fixed identity. */
export const SERVICE_BUILD = "40";

/**
 * The checkout this module was loaded from.
 *
 * Resolved on demand and never at import time. The Paseo plugin host loads the
 * bridge side as a CJS bundle, where `import.meta` is empty, so resolving this at
 * module scope throws `Invalid URL` and fails the entire plugin load. Callers with
 * a better anchor pass it instead: the bridge uses the host's own registry entry.
 */
export function sourcePathFromModule(): string {
  const url = import.meta.url;
  if (!url) throw new Error("Cannot resolve the installed plugin path in this loading format");
  return fileURLToPath(new URL("../..", url));
}

/** Hash the exact backend source bytes, independent of Git or directory iteration order. */
export function backendSourceDigest(sourcePath: string): string {
  if (compiledIdentity) return compiledIdentity.digest;
  const hash = createHash("sha256");
  let count = 0;
  const add = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) add(join(path, name));
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      hash.update(JSON.stringify([relative(sourcePath, path).split("\\").join("/"), bytes.length]));
      hash.update(bytes);
      count++;
    } else {
      throw new Error(`Backend source is not a regular file or directory: ${path}`);
    }
  };
  try {
    add(join(sourcePath, "core"));
    add(join(sourcePath, "service"));
    add(join(sourcePath, "shared"));
    add(join(sourcePath, "hosts"));
    add(join(sourcePath, "bin", "queue-service.mjs"));
    if (!count) throw new Error("Backend source set is empty");
    return hash.digest("hex");
  } catch (error) {
    throw new Error(`Cannot read backend source set at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A caller that already hashed the source passes its digest so identity and digest describe the same bytes. */
export function serviceBuildIdentity(sourcePath: string, generation = SERVICE_BUILD, digest = backendSourceDigest(sourcePath)): string {
  if (compiledIdentity) return compiledIdentity.buildId;
  return buildIdentity(generation, RPC_METHOD_NAMES, digest);
}

let publishedBuildId: string | null = null;

/**
 * The identity this process publishes, computed once from the source it started
 * with. Memoised deliberately: a service that recomputed it on every call could
 * not report that its own bytes had gone stale beneath it.
 */
export function currentServiceBuildId(): string {
  if (!publishedBuildId) publishedBuildId = serviceBuildIdentity(sourcePathFromModule());
  return publishedBuildId;
}

export const SERVICE_PROTOCOL_VERSION = PROTOCOL_VERSION;
