export interface WorkStorage { root: string; volumeId?: string }
export interface LocalWorkspacePlacement {
  workRoot: string;
  volumeId?: string;
  activeRoot: string;
  defaultRoot: string;
  retainedRoots: string[];
}
/** Every work-volume class default a fresh install derives from `workRoot`. */
export interface WorkPlacementDefaults {
  worktreesRoot: string;
  backupRoot: string;
  projectQaRoot: string;
  scratchRoot: string;
  custodianRoot: string;
}
/** The retired `<workRoot>/queue/...` locations existing data may still live in. */
export interface RetiredWorkPlacement {
  worktreesRoot?: string;
  backupRoot?: string;
  projectQaRoot?: string;
}
/** The work-volume locations Nucleus writes, and the ones it still reads. */
export interface WorkPlacement {
  workRoot: string;
  volumeId?: string;
  worktreesRoot: string;
  backupRoot: string;
  projectQaRoot: string;
  scratchRoot: string;
  custodianRoot: string;
  defaults: WorkPlacementDefaults;
  retired: RetiredWorkPlacement;
  /** The classes whose saved path differs from the portable default, by field. */
  overrides: Partial<WorkPlacementDefaults>;
  retainedRoots: string[];
}
/** One Storage save: `undefined` leaves a class alone; `null` or `''` restores its default. */
export interface WorkPlacementUpdate {
  workRoot?: string | null;
  workVolumeId?: string | null;
  worktreesRoot?: string | null;
  backupRoot?: string | null;
  projectQaRoot?: string | null;
  scratchRoot?: string | null;
  custodianRoot?: string | null;
}
export interface WorkVolume { MountPoint?: string; VolumeUUID?: string; Internal?: boolean; Writable?: boolean; WritableVolume?: boolean }
export function getWorkStorage(dataDir?: string, env?: NodeJS.ProcessEnv): WorkStorage;
export function getWorkRoot(dataDir?: string, env?: NodeJS.ProcessEnv): string;
export function getWorkPlacement(dataDir?: string, env?: NodeJS.ProcessEnv): WorkPlacement;
export function getWorkClassPath(field: keyof WorkPlacementDefaults, dataDir?: string, env?: NodeJS.ProcessEnv): string;
export function getRetiredWorkClassPath(field: keyof WorkPlacementDefaults, dataDir?: string, env?: NodeJS.ProcessEnv): string | null;
export function getLocalWorkspacePlacement(dataDir?: string, env?: NodeJS.ProcessEnv): LocalWorkspacePlacement;
export function defaultWorkPlacement(root: string): WorkPlacementDefaults;
export function retiredWorkPlacement(root: string): RetiredWorkPlacement;
export function mergedWorkSettings(dataDir: string, update?: WorkPlacementUpdate): Record<string, unknown>;
export function previewWorkPlacement(update?: WorkPlacementUpdate, dataDir?: string, env?: NodeJS.ProcessEnv): WorkPlacement;
/** The placement the saved settings would mean with no environment override. */
export function previewSavedWorkPlacement(update?: WorkPlacementUpdate, dataDir?: string): WorkPlacement;
export function writeWorkSettings(dataDir: string, update?: WorkPlacementUpdate): Record<string, unknown>;
export function validSubpathInsideMount(mount: string, value: string, label: string): string;
export function recordedWorkRoots(records: unknown[]): string[];
export function initializeWorkRoot(dataDir: string, env?: NodeJS.ProcessEnv, options?: { records?: unknown[]; observe?: (root: string) => WorkVolume }): WorkStorage;
export function readWorkVolume(root: string): WorkVolume;
