import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { digest, type Store } from "../store/store";

/** Queue-owned isolated checkouts live outside repositories. */
const ISOLATION_DIR = "isolation";
export const WARM_CANDIDATE_NAME = "prospective-merge-warm";
/** Queue data directory that owns isolated checkouts for this store. Tests point the store at a temp directory. */
export const isolationDataDirFor = (store: Pick<Store, "path">): string => {
  if (store.path === ":memory:") throw new Error("Queue-owned checkouts require the Queue data directory");
  const dir = dirname(store.path);
  try { return realpathSync(dir); } catch { return resolve(dir); }
};
export const isolationRootFor = (dataDir: string, gitCommonDir: string) => join(dataDir, ISOLATION_DIR, digest(gitCommonDir));
export const isolationPathFor = (dataDir: string, gitCommonDir: string, eventId: string) => join(isolationRootFor(dataDir, gitCommonDir), eventId);
export const warmCandidatePathFor = (dataDir: string, gitCommonDir: string) => join(isolationRootFor(dataDir, gitCommonDir), WARM_CANDIDATE_NAME);
/** True when `path` is a Queue-owned checkout under the data-home isolation root. */
export const isOwnedIsolationPath = (path: string, dataDir: string, gitCommonDir: string): boolean =>
  path.startsWith(`${isolationRootFor(dataDir, gitCommonDir)}/`);

