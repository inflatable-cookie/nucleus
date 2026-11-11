import type { spawn } from "node:child_process";
import type { ServiceRoll } from "../service-roll";
import type { ServiceStartupFailure } from "./discovery";

export interface StagedBuild { root: string; revision: string; buildId: string; elapsedMs?: number }
export interface MainTarget { key: string; revision?: string; staged?: StagedBuild }
export interface MainChannelConfig {
  channel?: string;
  repository?: string;
  scratch?: string;
  rollback?: string;
  ignoredRevision?: string;
}
export interface BridgeMainChannel {
  command(command: string, args: string[], cwd?: string, environment?: NodeJS.ProcessEnv): Promise<string>;
  buildNode(): Promise<string>;
  startService(node: string, args: string[], root: string, environment: NodeJS.ProcessEnv): Promise<void>;
  proveStartup(staged: Pick<StagedBuild, "root">): Promise<void>;
  abandon(staged: Pick<StagedBuild, "root">): Promise<void>;
  target(): Promise<MainTarget | null>;
  build(revision: string): Promise<StagedBuild>;
  pending(): Promise<{ root: string; target: MainTarget } | null>;
  prepare(staged: StagedBuild, target: MainTarget): Promise<void>;
  activated(target: MainTarget): Promise<void>;
}

/** Concrete process and file effects are supplied at composition, never loaded by the bridge. */
export interface BridgeProcessActions {
  openMainChannel(sourcePath: string): Promise<BridgeMainChannel | null>;
  verifyVersion(root: string): Promise<any>;
  activateVersion(root: string): Promise<void>;
  processCpuMs(pid: number): Promise<number | null>;
  spawn: typeof spawn;
  pidAlive(pid: number): boolean;
  writeOwnedJson(path: string, value: unknown): void;
  removeServiceStartupFailure(dataDir: string): void;
  writeServiceRoll(dataDir: string, roll: ServiceRoll): void;
  writeServiceStartupFailure(dataDir: string, failure: ServiceStartupFailure): void;
  consumeServiceRollRequest(dataDir: string): { force: boolean } | null;
  clearMaintenance(dataDir: string, pid: number): void;
  clearMigration(dataDir: string, pid: number): void;
  clearStandbyReady(dataDir: string, pid: number): void;
  standbyIsReady(dataDir: string, pid: number): boolean;
  startupExtensionMs(dataDir: string, pid: number, token: string | undefined, now?: number): number;
}
