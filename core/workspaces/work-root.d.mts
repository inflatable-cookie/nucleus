export interface WorkStorage { root: string; volumeId?: string }
export interface LocalWorkspacePlacement {
  workRoot: string;
  volumeId?: string;
  activeRoot: string;
  defaultRoot: string;
  retainedRoots: string[];
}
export interface WorkVolume { MountPoint?: string; VolumeUUID?: string; Internal?: boolean; Writable?: boolean; WritableVolume?: boolean }
export function getWorkStorage(dataDir?: string, env?: NodeJS.ProcessEnv): WorkStorage;
export function getWorkRoot(dataDir?: string, env?: NodeJS.ProcessEnv): string;
export function getLocalWorkspacePlacement(dataDir?: string, env?: NodeJS.ProcessEnv): LocalWorkspacePlacement;
export function validSubpathInsideMount(mount: string, value: string, label: string): string;
export function recordedWorkRoots(records: unknown[]): string[];
export function initializeWorkRoot(dataDir: string, env?: NodeJS.ProcessEnv, options?: { records?: unknown[]; observe?: (root: string) => WorkVolume }): WorkStorage;
export function readWorkVolume(root: string): WorkVolume;
