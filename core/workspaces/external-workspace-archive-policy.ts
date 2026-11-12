import { historicalWireLabel } from "../../shared/wire-labels";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { settledThreadStatuses } from "../../shared/host";
import type { HostWorkspaceRef, HostThreadInventory, HostTerminalInventory } from "../../shared/host";
import type { WorkspaceContinuationHostCalls } from "./workspace-continuation";
import type { AgentObservation, ExternalWorkspacePlacement, ExternalWorktreeSource, ExternalWorkspaceCatalog, ExternalWorkspaceArchiveInput, ExternalWorkspaceArchiveOutcome, ExternalWorkspaceSourceExpectation } from "../host/adapter";
import { git, gitRaw, originBranchContaining } from "../git/index";
import { externalWorkspaceArchivePlacement } from "./external-workspace-placement";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * The ignored runtime roots Queue's existing build-output cleanup policy treats
 * as disposable (`core/workspaces/worktree-cleanup.ts`: Cargo targets, node_modules and
 * the harness caches). Any other ignored branch boundary is real local material
 * a folder removal would lose, so it holds the entry.
 */
// `.northstar-cache` is the retired cache folder name; recorded checkouts may still hold one.
const DISPOSABLE_IGNORED_ROOTS = new Set(["node_modules", "target", ".effigy", ".northstar-cache"]);
const disposableIgnoredEntry = (path: string) =>
  path.replace(/\/+$/, "").split("/").some(segment => DISPOSABLE_IGNORED_ROOTS.has(segment));
/** The preserved folder's Git identity as the source proof recorded it. */
const sourceIdentity = (source: ExternalWorktreeSource) => `${source.commonDir}\u0000${source.branch}\u0000${source.head}`;
/** Bounded porcelain inventory: matching ignored branches instead of every leaf. */
async function worktreeStatusInventory(directory: string): Promise<Array<{ status: string; path: string }>> {
  const tokens = (await gitRaw(directory, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all")).split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token) continue;
    const status = token.slice(0, 2), path = token.slice(3);
    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") index++;
    entries.push({ status, path });
  }
  return entries;
}

export class ExternalWorkspaceArchive {
  constructor(private readonly host: ExternalWorkspaceArchiveHost) {}
  /**
   * Spec 017 worktree amendment: every catalog registration listed at exactly
   * this preserved folder. The complete active inventory is walked to its
   * positive end; an incomplete read is an explicit refusal, never a guess. An
   * archived entry is not addressable through this API, so the inventory names
   * what the daemon currently lists at this exact path.
   */
  async externalWorkspaceCatalog(directory: string): Promise<ExternalWorkspaceCatalog> {
    let entries: Awaited<ReturnType<typeof this.host.workspaceHost.workspaceInventory>>;
    try { entries = await this.host.workspaceHost.workspaceInventory(); }
    catch (error) { return { ok: false, reason: `Workspace catalog could not be read: ${errorMessage(error)}` }; }
    const wanted = resolve(directory);
    return { ok: true, entries: entries
      .filter(entry => Boolean(entry.workspaceDirectory) && resolve(entry.workspaceDirectory!) === wanted)
      .map(entry => {
        const placement = externalWorkspaceArchivePlacement(entry, entry.id, entry.workspaceDirectory!, true);
        return placement.ok
          ? { workspaceId: entry.id, directory: entry.workspaceDirectory!, placement: placement.observed }
          : { workspaceId: entry.id, directory: entry.workspaceDirectory!, placement: null, reason: placement.reason };
      }) };
  }
  /**
   * Spec 017: archive one merged review-entry task's external workspace *entry*.
   *
   * Tom's 2026-10-25 amendment: a worktree placement may be archived even though
   * Paseo's teardown can remove its folder, but only after the exact workspace,
   * repository, common directory, branch and directory identity and the
   * canonical remote are proved, the tracked/index/untracked tree and every
   * unexpected ignored path are clean, and the actual HEAD is reachable from a
   * branch the canonical origin advertises now. The proof is taken after the
   * awaited inventories and re-read after its own awaited fetch, so a concurrent
   * edit cannot reuse a stale result; nothing here resolves, resets, cleans,
   * stashes, rewrites or pushes. A non-worktree placement keeps the original
   * catalog-only proof.
   *
   * Every catalog registration listed at the same exact folder is checked before
   * any call that may remove shared backing: a foreign or active thread there,
   * or an unreadable registration, protects the folder. Only this task's own
   * entries are ever archived. After the native answer the catalog is observed
   * again; a gone entry is a success, with the folder present (and its Git
   * identity unchanged) or, under the worktree permission, absent and recorded
   * as a removal. Nothing here ever re-sends the archive.
   */
  async archiveExternalWorkspace(input: ExternalWorkspaceArchiveInput): Promise<ExternalWorkspaceArchiveOutcome> {
    const refuse = (reason: string, extra: { observed?: ExternalWorkspacePlacement; participants?: string[] } = {}): ExternalWorkspaceArchiveOutcome => ({ status: 'refused', reason, ...extra });
    const fail = (reason: string, extra: { observed?: ExternalWorkspacePlacement; participants?: string[] } = {}): ExternalWorkspaceArchiveOutcome => ({ status: 'failed', reason, ...extra });
    const workspace = this.host.workspaceHost.workspaceRef(input.workspaceId);
    let current: ReturnType<typeof workspace.current> = null;
    try { await workspace.refresh(); current = workspace.current(); }
    catch (error) { return refuse(`Workspace catalog could not be read: ${errorMessage(error)}`); }
    const placement = externalWorkspaceArchivePlacement(current, input.workspaceId, input.directory, true);
    if (!placement.ok) return refuse(placement.reason);
    const observed = placement.observed;
    const worktree = observed.kind === 'worktree';
    // A folder that is already gone is only safe under an earlier authorized
    // removal of this exact shared path; otherwise it is an unexpected removal,
    // not an inference that absent files were clean. A folder that came back is
    // no longer described by that removal, so it needs a fresh source proof.
    if (input.folderRemoval) {
      if (!/^[a-f0-9]{40}$/.test(input.folderRemoval.head) || !input.folderRemoval.workspaceId)
        return refuse('The recorded removal of the shared folder is incomplete; inspect before retrying');
      if (existsSync(input.directory))
        return refuse('The preserved folder reappeared after its recorded removal; inspect it before archiving another registration');
    } else if (!existsSync(input.directory)) {
      return fail(`The preserved folder ${input.directory} is absent without an authorized removal; nothing was sent`);
    }
    // The SDK has no workspace filter, so the inventory is every thread the
    // daemon lists, archived included, walked to its actual positive end by the host.
    const registrations = [...new Set([input.workspaceId, ...input.samePathWorkspaceIds])];
    const inventory = await this.host.workspaceHost.workspaceThreads(registrations);
    if (!inventory.ok) return refuse(inventory.reason, { observed });
    const participants: string[] = [];
    const alreadyArchived = new Set<string>();
    for (const agent of inventory.threads) {
      const inTarget = agent.workspaceId === input.workspaceId;
      if (!agent.id) return refuse('Workspace thread inventory holds an unreadable thread', { observed });
      // A thread Queue created for this task carries its task label; an attached
      // role is a recorded identity on the task. Anything else is foreign, and a
      // foreign thread in any registration at this exact folder protects it.
      const owned = historicalWireLabel(agent.labels, 'task') === input.taskId || input.ownedAgentIds.has(agent.id);
      if (!owned) return refuse(`Workspace ${agent.workspaceId} holds thread ${agent.id}, which is not this task's`, { observed });
      if (agent.activeTurn || agent.pendingPermissionKinds.length || !settledThreadStatuses.includes(agent.status))
        return refuse(`Waiting for workspace thread ${agent.id} in ${agent.workspaceId} to become idle`, { observed });
      if (!inTarget) continue; // Another registration's threads are checked, never archived here.
      // An archived thread cannot hold a turn, and the daemon may no longer
      // answer for it by id; the inventory's own archived fact is its proof.
      if (agent.archived) alreadyArchived.add(agent.id);
      participants.push(agent.id);
    }
    // Fresh observation of every live-listed thread of the target entry:
    // inventory state alone is not liveness or current ownership.
    for (const agentId of participants.filter(id => !alreadyArchived.has(id))) {
      let state: AgentObservation | null = null;
      try { state = await this.host.observe(agentId); } catch { state = null; }
      if (!state || state.id !== agentId) return refuse(`Workspace thread ${agentId} could not be observed`, { observed, participants });
      if (state.workspaceId !== input.workspaceId) return refuse(`Workspace thread ${agentId} changed workspace`, { observed, participants });
      if (state.active || state.activeTurnId || state.permissions || !settledThreadStatuses.includes(state.status))
        return refuse(`Waiting for workspace thread ${agentId} to become idle`, { observed, participants });
    }
    // Paseo's archive kills every terminal in the workspace; an entry (or a
    // registration sharing its backing) with a shell in it is not this task's to
    // close, and a removal would strand it either way.
    for (const workspaceId of registrations) {
      const terminals = await this.host.workspaceHost.workspaceTerminals(workspaceId);
      if (!terminals.ok) return refuse(terminals.reason, { observed, participants });
      if (terminals.terminals.length) return refuse(`Workspace ${workspaceId} holds ${terminals.terminals.length} terminal session(s); archiving the entry would kill them`, { observed, participants });
    }
    // The source proof is the only thing that may authorize removing this
    // folder, and it runs after every awaited inventory so none of them can lend
    // it stale evidence.
    let source: ExternalWorktreeSource | null = null;
    if (worktree && !input.folderRemoval) {
      const proved = await this.host.proveExternalWorktreeSource(input.directory, input.expected);
      if ('reason' in proved) return refuse(proved.reason, { observed, participants });
      source = proved.source;
    }
    // The preserved folder's Git identity immediately before the native call.
    // Both paths need it: a present folder must come back unchanged on the
    // catalog-only path too, and a worktree proof must also match its recorded
    // source identity.
    const identityBefore = await this.host.preservedGitIdentity(input.directory);
    if (!input.allowed(observed, participants, source)) return { status: 'declined', reason: 'Workspace catalog archive held by task identity, ownership or a hold' };
    let result: { archivedAt?: string | null; error?: string | null } | null = null;
    try { result = await workspace.archive(input.requestId); }
    catch (error) { return { status: 'uncertain', reason: `Paseo workspace.archive failed: ${errorMessage(error)}`, observed, participants }; }
    const native = { archivedAt: result?.archivedAt ?? null, error: result?.error ?? null };
    const present = await this.host.catalogEntryPresent(workspace);
    if (present) return { status: 'uncertain', reason: native.error ? `Paseo workspace.archive failed: ${native.error}` : 'Paseo workspace.archive left the catalog entry listed', observed, participants, native };
    const folderPresent = existsSync(input.directory);
    if (!folderPresent) {
      // A removal is accepted only under the freshly proved worktree permission
      // (or the durable chain of one); a non-worktree folder must survive.
      if (!worktree) return fail(`Paseo workspace.archive removed the preserved folder ${input.directory}`, { observed, participants });
      return { status: 'archived', observed, participants, native, folderPresent: false };
    }
    const identityAfter = await this.host.preservedGitIdentity(input.directory);
    if (identityAfter !== identityBefore || (source && identityAfter !== sourceIdentity(source)))
      return fail(`Paseo workspace.archive changed the preserved Git identity of ${input.directory}`, { observed, participants });
    return { status: 'archived', observed, participants, native, folderPresent: true };
  }
  /**
   * The clean, published source proof for a worktree the platform may remove.
   *
   * HEAD must be an ancestor of a branch the canonical origin advertises *now*
   * (`originBranchContaining` fetches and then re-reads the advertisement, so a
   * stale tracking ref, a deleted branch, a PR number or the recorded merge
   * alone proves nothing), under an explicit `merge:<base>` fallback for a head
   * whose exact commit already landed on the integration branch. Every fact is
   * read again after that awaited fetch; a changed HEAD, status, branch, common
   * directory or origin refuses.
   */
  async proveExternalWorktreeSource(directory: string, expected: ExternalWorkspaceSourceExpectation): Promise<{ source: ExternalWorktreeSource } | { reason: string }> {
    const reason = (value: string) => ({ reason: value });
    const read = async (): Promise<ExternalWorktreeSource> => {
      const canonical = await realpath(directory);
      if (canonical !== resolve(directory)) throw Error(`the folder is reached through a link to ${canonical}`);
      const top = await realpath(await git(directory, 'rev-parse', '--show-toplevel'));
      if (top !== canonical) throw Error('the folder is not its own worktree root');
      const common = await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const repositoryCommon = await git(expected.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      if (common !== repositoryCommon) throw Error('the worktree belongs to another repository');
      const branch = await git(directory, 'branch', '--show-current');
      if (!branch) throw Error('the worktree has no branch');
      if (branch !== expected.branch) throw Error(`the worktree is on branch ${branch}, not ${expected.branch}`);
      const remote = await git(directory, 'remote', 'get-url', 'origin');
      if (!remote) throw Error('the worktree has no origin remote');
      // The canonical remote is the recorded repository checkout's own origin;
      // any other remote (a fork, an alternate) publishes nothing Queue trusts.
      const canonicalRemote = await git(expected.repoPath, 'remote', 'get-url', 'origin');
      if (!canonicalRemote) throw Error(`the recorded repository ${expected.repoPath} has no canonical origin remote`);
      if (canonicalRemote !== remote) throw Error(`origin ${remote} is not the canonical remote ${canonicalRemote}`);
      const expectedOrigin = normalizeRepositoryOrigin(expected.repository ?? '');
      if (expectedOrigin && normalizeRepositoryOrigin(remote) !== expectedOrigin)
        throw Error(`origin ${remote} is not the recorded canonical repository ${expected.repository}`);
      const head = await git(directory, 'rev-parse', 'HEAD');
      if (!/^[a-f0-9]{40}$/.test(head)) throw Error(`HEAD ${head || 'is unreadable'}`);
      const inventory = await worktreeStatusInventory(directory);
      const dirty = inventory.filter(entry => entry.status !== '!!');
      if (dirty.length) throw Error(`${dirty.length} tracked, index or untracked change(s) remain (${dirty[0]!.path})`);
      const ignored = inventory.filter(entry => entry.status === '!!').map(entry => entry.path.replace(/\/+$/, ''));
      const unexpected = ignored.filter(path => !disposableIgnoredEntry(path));
      if (unexpected.length) throw Error(`ignored content the cleanup policy does not own remains (${unexpected[0]})`);
      return { head, branch, directory, commonDir: common, remote, publication: '', ignored: ignored.sort() };
    };
    let first: ExternalWorktreeSource;
    try { first = await read(); }
    catch (error) { return reason(`Worktree source could not be proved clean and owned: ${errorMessage(error)}`); }
    try {
      const containing = await originBranchContaining(directory, first.head, [expected.branch, expected.baseBranch]);
      first.publication = containing ? `origin/${containing}` : '';
    } catch (error) { return reason(`Worktree publication could not be observed at the canonical remote: ${errorMessage(error)}`); }
    if (!first.publication) {
      // A deleted branch is still safe when the exact head is the recorded merged
      // commit on an advertised base: the same commit object is on the remote.
      try {
        const advertised = new Map((await git(directory, 'ls-remote', '--heads', 'origin'))
          .split('\n').filter(Boolean).map(line => line.split(/\s+/)).filter(([sha, ref]) => /^[a-f0-9]{40}$/.test(sha ?? '') && ref?.startsWith('refs/heads/'))
          .map(([sha, ref]) => [ref!.slice('refs/heads/'.length), sha!] as const));
        const base = advertised.get(expected.baseBranch);
        if (base) {
          await git(directory, 'fetch', 'origin', `+refs/heads/${expected.baseBranch}:refs/remotes/origin/${expected.baseBranch}`);
          const fetched = await git(directory, 'rev-parse', `refs/remotes/origin/${expected.baseBranch}`);
          const live = advertised.get(expected.baseBranch);
          if (fetched === live && await git(directory, 'merge-base', '--is-ancestor', first.head, fetched).then(() => true, () => false))
            first.publication = `merge:origin/${expected.baseBranch}`;
        }
      } catch (error) { return reason(`Worktree publication could not be observed at the canonical remote: ${errorMessage(error)}`); }
    }
    if (!first.publication) return reason(`Worktree HEAD ${first.head} is on no branch the canonical remote advertises now`);
    // Re-read every fact after the awaited publication proof: a concurrent edit,
    // commit or remote change never reuses the earlier result.
    let second: ExternalWorktreeSource;
    try { second = await read(); }
    catch (error) { return reason(`Worktree source changed while it was being proved: ${errorMessage(error)}`); }
    if (second.head !== first.head) return reason(`Worktree HEAD changed from ${first.head} to ${second.head} while it was being proved`);
    if (JSON.stringify({ ...second, publication: '', ignored: [] }) !== JSON.stringify({ ...first, publication: '', ignored: [] }))
      return reason('Worktree identity or clean state changed while it was being proved');
    if (JSON.stringify(second.ignored) !== JSON.stringify(first.ignored))
      return reason('Worktree ignored contents changed while it was being proved');
    return { source: first };
  }
  /** A positive catalog observation, or `true` when it cannot be read: never a success from an unreadable answer. */
  async catalogEntryPresent(workspace: HostWorkspaceRef): Promise<boolean> {
    try { await workspace.refresh(); return Boolean(workspace.current()); } catch { return true; }
  }
  /** The preserved folder's Git identity (common dir, branch and head), or null when it has none. */
  async preservedGitIdentity(directory: string): Promise<string | null> {
    try {
      const common = await git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const branch = await git(directory, 'branch', '--show-current');
      const head = await git(directory, 'rev-parse', 'HEAD');
      return `${common}\u0000${branch}\u0000${head}`;
    } catch { return null; }
  }
}

export interface ExternalWorkspaceArchiveHost {
  readonly workspaceHost: WorkspaceContinuationHostCalls & {
    workspaceThreads(ids: string[]): Promise<HostThreadInventory>;
    workspaceTerminals(id: string): Promise<HostTerminalInventory>;
  };
  proveExternalWorktreeSource(directory: string, expected: ExternalWorkspaceSourceExpectation): Promise<{ source: ExternalWorktreeSource } | { reason: string }>;
  catalogEntryPresent(workspace: HostWorkspaceRef): Promise<boolean>;
  preservedGitIdentity(directory: string): Promise<string | null>;
  observe(id: string): Promise<AgentObservation | null>;
}
