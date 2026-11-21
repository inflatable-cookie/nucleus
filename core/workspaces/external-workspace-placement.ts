import type { ExternalWorkspaceCatalogView } from "../host/types";
export type { ExternalWorkspaceCatalogView } from "../host/types";
import { resolve } from "node:path";
import type { ExternalWorkspacePlacement } from "../host/adapter";

const sameDirectory = (left?: string | null, right?: string | null) =>
  Boolean(left) && Boolean(right) && resolve(left!) === resolve(right!);

/**
 * Prove whether an external catalog entry's normalized placement and provenance
 * permit a catalog-only archive (or a source-gated worktree teardown when
 * `allowWorktree` is true). Missing, unproved, or conflicting evidence always
 * refuses.
 */
export function externalWorkspaceArchivePlacement(
  current: ExternalWorkspaceCatalogView,
  workspaceId: string,
  directory: string,
  allowWorktree = false,
):
  | { ok: true; observed: ExternalWorkspacePlacement }
  | { ok: false; reason: string } {
  if (!current)
    return {
      ok: false,
      reason: `Workspace ${workspaceId} is not listed in the catalog`,
    };
  if (!sameDirectory(current.workspaceDirectory, directory))
    return {
      ok: false,
      reason: `Workspace ${workspaceId} no longer has its recorded directory`,
    };
  const placement = current.placement;
  const kind = placement?.kind;
  if (!kind)
    return {
      ok: false,
      reason: `Workspace ${workspaceId} placement kind is unreadable`,
    };
  const observedBase = (
    hostOwnedWorktree: boolean,
    mainRepoRoot: string | null,
  ): ExternalWorkspacePlacement => ({
    kind,
    hostOwnedWorktree,
    mainRepoRoot,
    ...(placement.provenance ? { provenance: placement.provenance } : {}),
  });
  if (kind === "worktree") {
    // A worktree placement is a removal risk. Only the clean, published source
    // proof that the caller demands after this check may authorize it, and the
    // descriptor must still name this exact directory when it names one.
    if (!allowWorktree)
      return {
        ok: false,
        reason: `Workspace ${workspaceId} is a worktree placement; host archive can run worktree teardown on it`,
      };
    if (
      placement.checkoutDirectory !== undefined &&
      placement.checkoutDirectory !== null &&
      !sameDirectory(placement.checkoutDirectory, directory)
    )
      return {
        ok: false,
        reason: `Workspace ${workspaceId} placement names another checkout directory`,
      };
    return {
      ok: true,
      observed: observedBase(
        Boolean(placement.hostOwnedWorktree),
        placement.mainRepoRoot ?? null,
      ),
    };
  }
  if (
    placement.checkoutDirectory === undefined ||
    placement.checkoutDirectory === null
  )
    return {
      ok: false,
      reason: `Workspace ${workspaceId} placement is unreadable; the catalog archive cannot be proven non-destructive`,
    };
  if (!sameDirectory(placement.checkoutDirectory, directory))
    return {
      ok: false,
      reason: `Workspace ${workspaceId} placement names another checkout directory`,
    };
  if (placement.hostOwnedWorktree !== false)
    return {
      ok: false,
      reason: `Workspace ${workspaceId} placement is host-owned; host archive could remove its directory`,
    };
  if ((placement.mainRepoRoot ?? null) !== null)
    return {
      ok: false,
      reason: `Workspace ${workspaceId} placement names a main repository; host archive could remove its directory`,
    };
  if (placement.runtimeHostOwnedWorktree === true)
    return {
      ok: false,
      reason: `Workspace ${workspaceId} Git runtime reports a host-owned worktree`,
    };
  return { ok: true, observed: observedBase(false, null) };
}
