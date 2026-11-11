/** Where the data home came from: an explicit selection, an existing store, or the default. */
export type DataHomeSource = "override" | "store" | "default";

export interface DataHomeResolution {
  /** The one directory this process uses. */
  root: string;
  /** Why: an explicit override, an existing Nucleus store, or the creation default. */
  source: DataHomeSource;
}

/** One path under a data home, the module that owns it, and whether it is durable. */
export interface DataHomeEntrySpec {
  path: string;
  kind: "durable" | "ephemeral" | "derived";
  owner: string;
}

export const CURRENT_DATA_HOME_LEAF: string;
export const DATA_HOME_ENV: string;
export const STORE_MARKERS: readonly string[];
export const DATA_HOME_ENTRIES: readonly DataHomeEntrySpec[];

export function isDataHomeError(error: unknown): boolean;
export function joinPath(...parts: string[]): string;
export function homeDirectory(env?: NodeJS.ProcessEnv): string;
export function holdsStore(root: string, stat?: (path: string) => unknown): boolean;
export function resolveDataHome(env?: NodeJS.ProcessEnv): DataHomeResolution;
export function dataHome(env?: NodeJS.ProcessEnv): string;
