import type { HostInitLockRule } from "../../../core/host/types";
import type {
  HostWorkspacePlacement,
  HostWorkspaceRecord,
} from "../../../shared/host";

/** Exact lock reason Paseo leaves on a worktree it was still creating. */
export const PASEO_INIT_LOCK_REASON = "initializing";

/** Paseo's worktree initialization lock rule: only the exact `"initializing"` reason is host-owned. */
export const PASEO_INIT_LOCK_RULE: HostInitLockRule = {
  hostLabel: "Paseo",
  expectedReason: PASEO_INIT_LOCK_REASON,
  matches: (lockReason: string) => lockReason === PASEO_INIT_LOCK_REASON,
};

/**
 * Raw Paseo workspace descriptor shape (`@getpaseo/server`
 * `describeWorkspaceRecord` / `workspace-registry-model`). Interpreted here at
 * the Paseo adapter boundary into host-neutral placement and provenance facts.
 */
export interface PaseoNativeWorkspacePlacementRecord {
  readonly workspaceDirectory?: string | null;
  readonly workspaceKind?: string | null;
  readonly project?: {
    readonly checkout?: {
      readonly cwd?: string;
      readonly isPaseoOwnedWorktree?: boolean;
      readonly mainRepoRoot?: string | null;
    } | null;
  } | null;
  readonly gitRuntime?: { readonly isPaseoOwnedWorktree?: boolean } | null;
}

export interface PaseoNativeWorkspaceRecord
  extends PaseoNativeWorkspacePlacementRecord {
  readonly projectRootPath: string;
  readonly projectId?: string | null;
  readonly worktreeSlug?: string | null;
}

/**
 * Translate Paseo's native placement fields into host-neutral placement and
 * provenance facts. Absent or non-boolean ownership flags stay null/omitted so
 * downstream placement checks fail closed and never broaden permission.
 */
export function paseoWorkspacePlacement(
  native: PaseoNativeWorkspacePlacementRecord | null | undefined,
): HostWorkspacePlacement | null {
  if (!native || typeof native !== "object") return null;
  const checkout = native.project?.checkout;
  const runtimeRaw = native.gitRuntime?.isPaseoOwnedWorktree;
  const runtimeHostOwnedWorktree =
    runtimeRaw === undefined || runtimeRaw === null
      ? null
      : typeof runtimeRaw === "boolean"
        ? runtimeRaw
        : true;
  return {
    kind: native.workspaceKind ?? null,
    ...(checkout
      ? {
          checkoutDirectory: checkout.cwd ?? "",
          hostOwnedWorktree:
            typeof checkout.isPaseoOwnedWorktree === "boolean"
              ? checkout.isPaseoOwnedWorktree
              : null,
          mainRepoRoot: checkout.mainRepoRoot ?? null,
        }
      : {}),
    runtimeHostOwnedWorktree,
    provenance: "paseo",
  };
}

/** Normalize one native Paseo workspace record into `HostWorkspaceRecord`. */
export function paseoWorkspaceRecord(
  native: PaseoNativeWorkspaceRecord | null | undefined,
): HostWorkspaceRecord | null | undefined {
  if (!native) return native;
  return {
    projectRootPath: native.projectRootPath,
    workspaceDirectory: native.workspaceDirectory,
    projectId: native.projectId,
    worktreeSlug: native.worktreeSlug,
    placement: paseoWorkspacePlacement(native),
  };
}
