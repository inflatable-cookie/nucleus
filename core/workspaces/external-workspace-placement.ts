import type { ExternalWorkspaceCatalogView } from '../host/types';
export type { ExternalWorkspaceCatalogView } from '../host/types';
import { resolve } from "node:path";
import type { ExternalWorkspacePlacement } from "../host/adapter";
const sameDirectory = (left?: string | null, right?: string | null) =>
  Boolean(left) && Boolean(right) && resolve(left!) === resolve(right!);
export function externalWorkspaceArchivePlacement(current: ExternalWorkspaceCatalogView, workspaceId: string, directory: string, allowWorktree = false):
  { ok: true; observed: ExternalWorkspacePlacement } | { ok: false; reason: string } {
  if (!current) return { ok: false, reason: `Workspace ${workspaceId} is not listed in the catalog` };
  if (!sameDirectory(current.workspaceDirectory, directory)) return { ok: false, reason: `Workspace ${workspaceId} no longer has its recorded directory` };
  const kind = current.workspaceKind;
  if (!kind) return { ok: false, reason: `Workspace ${workspaceId} placement kind is unreadable` };
  const checkout = current.project?.checkout;
  if (kind === 'worktree') {
    // A worktree placement is a removal risk. Only the clean, published source
    // proof that the caller demands after this check may authorize it, and the
    // descriptor must still name this exact directory when it names one.
    if (!allowWorktree) return { ok: false, reason: `Workspace ${workspaceId} is a worktree placement; Paseo archive can run worktree teardown on it` };
    if (checkout && !sameDirectory(checkout.cwd, directory)) return { ok: false, reason: `Workspace ${workspaceId} placement names another checkout directory` };
    return { ok: true, observed: { kind, isPaseoOwnedWorktree: Boolean(checkout?.isPaseoOwnedWorktree), mainRepoRoot: checkout?.mainRepoRoot ?? null } };
  }
  if (!checkout) return { ok: false, reason: `Workspace ${workspaceId} placement is unreadable; the catalog archive cannot be proven non-destructive` };
  if (!sameDirectory(checkout.cwd, directory)) return { ok: false, reason: `Workspace ${workspaceId} placement names another checkout directory` };
  if (checkout.isPaseoOwnedWorktree !== false) return { ok: false, reason: `Workspace ${workspaceId} placement is Paseo-owned; Paseo archive could remove its directory` };
  if ((checkout.mainRepoRoot ?? null) !== null) return { ok: false, reason: `Workspace ${workspaceId} placement names a main repository; Paseo archive could remove its directory` };
  if (current.gitRuntime?.isPaseoOwnedWorktree === true) return { ok: false, reason: `Workspace ${workspaceId} Git runtime reports a Paseo-owned worktree` };
  return { ok: true, observed: { kind, isPaseoOwnedWorktree: false, mainRepoRoot: null } };
}
