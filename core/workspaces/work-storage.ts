import { dataHome } from "../../shared/data-home.mjs";
import type { WorkStorageInput, WorkStorageState } from "../../shared/schema/work-storage";
import {
  assertWorkPlacementAvailable,
  type CheckoutVolumeInfo,
} from "./checkout-volume";
import {
  getWorkPlacement,
  previewSavedWorkPlacement,
  previewWorkPlacement,
  writeWorkSettings,
  type WorkPlacement,
  type WorkPlacementUpdate,
} from "./work-root.mjs";

/** Fixture seams for the guard; production reads the configured volume and diskutil. */
export interface WorkStorageOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  observe?: (mount: string) => CheckoutVolumeInfo;
  read?: (mount: string) => CheckoutVolumeInfo;
}

/** The resolved placement as the Storage page reads it. */
export function workStorageState(placement: WorkPlacement): WorkStorageState {
  const defaults = placement.defaults;
  const overrides = {
    workRoot: placement.overrides.workRoot ?? null,
    ...Object.fromEntries(
      (Object.keys(defaults) as Array<keyof typeof defaults>).map(field => [
        field,
        placement.overrides[field] ?? null,
      ]),
    ),
  } as WorkStorageState["overrides"];
  return {
    workRoot: placement.workRoot,
    workVolumeId: placement.volumeId ?? null,
    worktreesRoot: placement.worktreesRoot,
    backupRoot: placement.backupRoot,
    projectQaRoot: placement.projectQaRoot,
    scratchRoot: placement.scratchRoot,
    custodianRoot: placement.custodianRoot,
    defaults,
    overrides,
    retired: {
      worktreesRoot: placement.retired.worktreesRoot ?? null,
      backupRoot: placement.retired.backupRoot ?? null,
      projectQaRoot: placement.retired.projectQaRoot ?? null,
    },
    retainedRoots: placement.retainedRoots,
    appliesOnRestart: true,
  };
}

/** Read the work-volume placement the service and its children use. */
export function readWorkStorage(options: WorkStorageOptions = {}): WorkStorageState {
  return workStorageState(
    getWorkPlacement(options.dataDir ?? dataHome(), options.env),
  );
}

/**
 * Settings → Storage: persist the operator's paths and answer with the placement
 * now on disk. Every candidate path is resolved and guarded before anything is
 * written — canonical, absolute, strictly inside `workRoot`, on the pinned volume,
 * no redirected component — once as the `settings.json` values stand on their own
 * and again as they resolve under this process's environment overrides, and the
 * guard then runs over the resolved volume and its existing components. Nothing is
 * written when any of it refuses, and a saved change applies when the service next
 * starts.
 */
export function saveWorkStorage(
  input: WorkStorageInput,
  options: WorkStorageOptions = {},
): WorkStorageState {
  const dataDir = options.dataDir ?? dataHome();
  const env = options.env ?? process.env;
  const update: WorkPlacementUpdate = {
    workRoot: input.workRoot,
    workVolumeId: input.workVolumeId,
    worktreesRoot: input.worktreesRoot,
    backupRoot: input.backupRoot,
    projectQaRoot: input.projectQaRoot,
    scratchRoot: input.scratchRoot,
    custodianRoot: input.custodianRoot,
  };
  // Both are needed. The saved placement is validated with no environment
  // override at all, so an override set in this process cannot mask a stored path
  // that would break the next start; the effective placement is then proved on the
  // volume this save actually writes to.
  previewSavedWorkPlacement(update, dataDir);
  const candidate = previewWorkPlacement(update, dataDir, env);
  assertWorkPlacementAvailable(candidate, {
    observe: options.observe,
    read: options.read,
  });
  writeWorkSettings(dataDir, update);
  return workStorageState(getWorkPlacement(dataDir, env));
}
