export interface StagedBuild { root: string; revision: string; buildId: string; elapsedMs?: number }
export interface MainTarget { key: string; revision?: string; staged?: StagedBuild }
export interface MainChannelConfig {
  channel?: string;
  repository?: string;
  scratch?: string;
  rollback?: string;
  ignoredRevision?: string;
}
export class MainChannel {
  constructor(config: MainChannelConfig);
  command(command: string, args: string[], cwd?: string, environment?: NodeJS.ProcessEnv): Promise<string>;
  buildNode(): Promise<string>;
  startService(node: string, args: string[], root: string, environment: NodeJS.ProcessEnv): Promise<void>;
  proveStartup(staged: Pick<StagedBuild, "root">): Promise<void>;
  abandon(staged: Pick<StagedBuild, "root">): Promise<void>;
  static open(sourcePath: string): Promise<MainChannel | null>;
  target(): Promise<MainTarget | null>;
  build(revision: string): Promise<StagedBuild>;
  pending(): Promise<{ root: string; target: MainTarget } | null>;
  prepare(staged: StagedBuild, target: MainTarget): Promise<void>;
  activated(target: MainTarget): Promise<void>;
}
export function configureChannel(channel: string, repository?: string, scratch?: string): Promise<unknown>;
export function requestRollback(): Promise<unknown>;
export function pruneVersions(versions: string, keep: Set<string>): Promise<void>;
