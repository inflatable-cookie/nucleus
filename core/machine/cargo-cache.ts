import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Queue agents share downloaded Cargo dependencies through one per-user Cargo home.
 * Incremental builds are off (Tom, 2026-10-15): on macOS each rebuild leaves a fresh
 * set of unpacked debug-info `.o` files in target/debug/deps that Cargo never removes,
 * and incremental/ grows beside them; task targets reached 55–80 GB. */
export function sharedCargoEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { CARGO_HOME: resolve(environment.CARGO_HOME || join(homedir(), ".cargo")), CARGO_INCREMENTAL: "0" };
}
