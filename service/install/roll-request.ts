import { onRepositorySyncRollRequest } from "../../core/forge/roll-request";
import { writeAtomicOwnedFile } from "../../core/machine/owned-file.mjs";
import { installBase } from "./install.mjs";
import { execFileSync } from "node:child_process";
import { dataHome } from "../../shared/data-home.mjs";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sourcePathFromModule } from "../../shared/service/build";
import { normalizeRepositoryOrigin } from "../../shared/lanes";

import { SERVICE_ROLL_REQUEST_FILE as SHARED_SERVICE_ROLL_REQUEST_FILE } from "../../shared/service/discovery";
export const SERVICE_ROLL_REQUEST_FILE = SHARED_SERVICE_ROLL_REQUEST_FILE;

/** Bind the service's advisory effect to the core port during runtime startup. */
export function registerServiceRollRequest(): void {
  onRepositorySyncRollRequest(requestServiceRollAfterRepositorySync);
}

/** Ask the bridge to check its registered source after Queue syncs that checkout. */
export function requestServiceRollAfterRepositorySync(
  repositoryPath: string,
  options: { sourcePath?: string; dataDir?: string; force?: boolean } = {},
): boolean {
  try {
    const sourcePath = options.sourcePath ?? sourcePathFromModule();
    if (realpathSync(repositoryPath) !== realpathSync(sourcePath)) {
      if (!existsSync(join(sourcePath, "manifest.json"))) return false;
      const channel = JSON.parse(readFileSync(join(installBase(), "channel.json"), "utf8"));
      if (channel.channel !== "main") return false;
      let matches = false;
      try { matches = realpathSync(channel.repository) === realpathSync(repositoryPath); } catch { /* remote URL */ }
      if (!matches) {
        const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repositoryPath, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        const remoteOrigin = normalizeRepositoryOrigin(remote);
        const channelOrigin = normalizeRepositoryOrigin(channel.repository);
        if (!remoteOrigin || remoteOrigin !== channelOrigin) return false;
      }
    }

    const dataDir = options.dataDir ?? dataHome();
    const target = join(dataDir, SERVICE_ROLL_REQUEST_FILE);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeAtomicOwnedFile(target, options.force ? "force\n" : "");
    return true;
  } catch (error) {
    console.warn("service roll request could not be recorded:", error);
    return false;
  }
}

/** Consume one advisory request; the regular digest watch remains the fallback. */
export function consumeServiceRollRequest(dataDir: string): { force: boolean } | null {
  const path = join(dataDir, SERVICE_ROLL_REQUEST_FILE);
  try {
    const text = readFileSync(path, "utf8").trim();
    rmSync(path);
    return { force: text === "force" };
  } catch {
    return null;
  }
}
