import { existsSync } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Task } from "../../shared/contracts";
import type { HookRecord, HookEventName, MergeCandidate, NormalizedHookDefinition } from "../../shared/hooks";
import { blobDigest, discoverManifest, repositoryIsGitCheckout } from "../hooks/hook-manifest";
import { gitText, gitTextEnv, statusEntries, verifyMergeCandidate } from "../git/git-snapshot";
import { gitRaw, formatGitError } from "../git/git-command";
import { digest, now, type Store } from "../store/store";
import { isolationPathFor, warmCandidatePathFor, isOwnedIsolationPath } from "../hooks/hook-isolation";
import { executablePath, hookHoldReason, type HookContext, type HookEmissionResult, type ProspectiveMergeRequest, type ProspectiveMergeOutcome } from "../hooks/hook-context";

interface ProspectiveMergeContext {
  store: Pick<Store, "task" | "tasks" | "hookEvent" | "hookEvents" | "events" | "event">;
  isolationDataDir(): string;
  gitCommonDir(task: Pick<Task, "repoPath">): Promise<string>;
  integrationBase(task: Task): Promise<string>;
  removeIsolatedCheckout(task: Task, path: string, force: boolean): Promise<void>;
  save(record: HookRecord, changes: Partial<HookRecord>): HookRecord;
  emit(event: HookEventName, task: Task, context: HookContext, accept?: (hook: NormalizedHookDefinition) => boolean): Promise<HookEmissionResult>;
}

/** Exact candidate construction and validation; occurrence delivery stays with RepositoryHooks. */
export class ProspectiveMerge {
  constructor(private readonly context: ProspectiveMergeContext) {}
  private get store() { return this.context.store; }
  private get isolationDataDir() { return this.context.isolationDataDir; }
  private get gitCommonDir() { return this.context.gitCommonDir; }
  private get integrationBase() { return this.context.integrationBase; }
  private get removeIsolatedCheckout() { return this.context.removeIsolatedCheckout; }
  private get save() { return this.context.save; }
  private get emit() { return this.context.emit; }

  /**
   * The candidate's program bytes must equal the pinned policy blob. A lane that
   * rewrites the required gate in its own prospective tree is an operational hold
   * rather than a licence for Queue to execute unreviewed policy content.
   */
  async prospectiveProgramDrift(root: string, record: HookRecord): Promise<string | null> {
    if (record.program.kind !== "repository") return null;
    const file = executablePath(root, record.program.executable);
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile() || (info.mode & 0o111) === 0) return "Prospective-merge candidate is missing the pinned hook program";
    if (blobDigest(await readFile(file)) !== record.program.executable.digest) return "Prospective-merge candidate changes the pinned hook program; repository policy must be reviewed and merged before it gates a merge";
    return null;
  }

  /** Deterministic Queue-owned path for one exact prospective merge candidate. */
  async prospectiveCandidatePath(task: Task, candidate: Pick<MergeCandidate, "integrationBase" | "reviewedHead">): Promise<string> {
    const eventId = digest(`prospective-merge\n${task.id}\n${candidate.integrationBase}\n${candidate.reviewedHead}`).slice(0, 48);
    return isolationPathFor(this.isolationDataDir(), await this.gitCommonDir(task), eventId);
  }

  /** Reuse is reserved for the task currently holding the repository integration turn. */
  holdsCandidateTurn(task: Task, tasks = this.store.tasks()): boolean {
    const current = this.store.task(task.id);
    const sequence = current?.resolution.integrationTurn?.sequence;
    const active = (owner: Task) => {
      if (!owner.resolution.integrationTurn || ["blocked", "error", "cancelled", "needs_attention"].includes(owner.phase)) return false;
      if (owner.resolution.mergeIntent && !owner.resolution.mergedCommit) return true;
      return !owner.resolution.attention && ["verifying", "merging", "syncing", "closing"].includes(owner.phase);
    };
    if (sequence == null || !active(current)) return false;
    return !tasks.some(other => other.id !== task.id && other.repoPath === task.repoPath &&
      active(other) && other.resolution.integrationTurn!.sequence < sequence);
  }

  async warmCandidatePath(task: Task): Promise<string> {
    return warmCandidatePathFor(this.isolationDataDir(), await this.gitCommonDir(task));
  }

  /**
   * Prove the warm checkout is Queue's own before any command runs in it.
   *
   * Ownership is a trust anchor and cannot be repaired: a foreign Git identity, a
   * changed root, owner or remote, or an attached branch falls back to a fresh
   * candidate. Dirt and bookkeeping pins are not trust anchors, so they are
   * repaired by the resync and proven afterwards instead.
   */
  async proveWarmOwnership(task: Pick<Task, "repoPath">, path: string, common: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !(await lstat(join(path, ".git"))).isDirectory()) throw new Error("warm checkout has a foreign Git identity");
    if (await gitText(path, "rev-parse", "--show-toplevel") !== path) throw new Error("warm checkout root changed");
    if (await gitText(path, "config", "--local", "queue.warmOwner") !== common) throw new Error("warm checkout owner changed");
    if (await gitText(path, "remote", "get-url", "origin") !== await gitText(task.repoPath, "remote", "get-url", "origin")) throw new Error("warm checkout remote changed");
    if (await gitText(path, "symbolic-ref", "-q", "HEAD").catch(() => "") !== "") throw new Error("warm checkout is attached to a branch");
  }

  async proveWarmCandidate(task: Task, path: string, common: string): Promise<void> {
    await this.proveWarmOwnership(task, path, common);
    const [integrationBase, reviewedHead, commit, tree] = await Promise.all([
      gitText(path, "config", "--local", "queue.warmBase"), gitText(path, "config", "--local", "queue.warmHead"),
      gitText(path, "config", "--local", "queue.warmCommit"), gitText(path, "config", "--local", "queue.warmTree"),
    ]);
    if (await gitText(path, "rev-list", "--parents", "-n", "1", commit) !== `${commit} ${integrationBase} ${reviewedHead}`) throw new Error("warm checkout parents changed");
    if ((await statusEntries(path)).length) throw new Error("warm checkout has tracked, untracked or ignored changes");
    await verifyMergeCandidate(path, { integrationBase, reviewedHead, commit, tree });
  }

  /**
   * Build the exact normal merge candidate in a Queue-owned checkout.
   * The candidate uses the same parent order (`base`, then `head`) and the same
   * three-way merge semantics as the configured GitHub `merge` operation, and
   * names only Queue's own synthetic commit: it never claims the eventual
   * server-generated merge identity. A conflict is reported before any hook
   * runs; neither the worker branch nor the canonical checkout is touched.
   */
  async buildProspectiveCandidate(task: Task, path: string, base: string, head: string, warm = false): Promise<{ kind: "built"; candidate: MergeCandidate } | { kind: "conflict"; detail: string } | { kind: "error"; detail: string } | { kind: "fallback"; detail: string }> {
    try {
      for (const commit of [base, head]) {
        if ((await gitRaw(task.repoPath, ["cat-file", "-e", `${commit}^{commit}`])).code === 0) continue;
        await gitRaw(task.repoPath, ["fetch", "origin", commit]);
        if ((await gitRaw(task.repoPath, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return { kind: "error", detail: `the commit ${commit} is not available to Queue` };
      }
      const common = await gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (!isOwnedIsolationPath(path, this.isolationDataDir(), common)) return { kind: "error", detail: "the candidate checkout is outside the Queue-owned isolation root" };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // The synthetic candidate objects belong to the canonical object store so
      // the recorded identity stays auditable after the disposable checkout is
      // removed. HEAD, index and worktree are never touched.
      // `merge-tree --write-tree` performs the same three-way merge Git would use
      // for a merge commit; its first output line is the resulting tree. Exit 1
      // means conflicts, which stop the gate before any hook process starts.
      const merged = await gitRaw(task.repoPath, ["merge-tree", "--write-tree", base, head]);
      const lines = merged.stdout.toString("utf8").split("\n").map(line => line.trim()).filter(Boolean);
      if (merged.code === 1) return { kind: "conflict", detail: lines.slice(1, 4).join("; ") || "the pinned base and accepted head do not merge cleanly" };
      if (merged.code !== 0) return { kind: "error", detail: formatGitError(["merge-tree", "--write-tree", base, head], merged.code, merged.signal, merged.stderr) };
      const tree = lines[0] ?? "";
      if (!/^[a-f0-9]{40}$/.test(tree)) return { kind: "error", detail: "git merge-tree returned no merge tree" };
      // Deterministic synthetic identity: identical pinned inputs reproduce the
      // same candidate commit, so a restart proves or rebuilds the same object.
      const date = await gitText(task.repoPath, "show", "-s", "--format=%cI", base);
      const commit = await gitTextEnv(task.repoPath, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        "-c", "user.name=Nucleus", "-c", "user.email=queue@nucleus.invalid",
        "commit-tree", tree, "-p", base, "-p", head, "-m", "Nucleus prospective merge candidate");
      if (!/^[a-f0-9]{40}$/.test(commit)) return { kind: "error", detail: "the prospective merge commit could not be created" };
      const origin = await gitText(task.repoPath, "remote", "get-url", "origin").catch(() => "");
      const candidate: MergeCandidate = { integrationBase: base, reviewedHead: head, commit, tree };
      if (warm) {
        if (existsSync(path)) {
          try { await this.proveWarmOwnership(task, path, common); }
          catch (error) { return { kind: "fallback", detail: error instanceof Error ? error.message : String(error) }; }
          try {
            await gitText(path, "fetch", "--no-tags", "--", task.repoPath, base, head, commit);
            await gitText(path, "reset", "--hard", base);
            await gitText(path, "checkout", "--detach", commit);
            // The pre-merge hook runs inside this checkout, so it leaves build
            // output, caches and ignored files behind. Cleaning is part of the
            // resync: without it every later pass proved the checkout dirty and
            // rebuilt a fresh candidate, which is what the warm checkout exists to
            // avoid. Identity and ownership were proven above, and the exact
            // candidate is proven again below.
            // A single -f preserves a directory containing a .git, and this checkout's tooling
            // leaves a nested repository under .effigy/. The proof below requires zero ignored
            // entries, so a single force could never reach it: the warm path failed its own
            // invariant on every pass. Two forces remove nested repositories too, after the
            // ownership proof above and with the candidate proven again below.
            await gitText(path, "clean", "-xfdff");
          } catch (error) { return { kind: "fallback", detail: error instanceof Error ? error.message : String(error) }; }
        } else {
          try {
            await gitText(task.repoPath, "clone", "--shared", "--no-checkout", "--", task.repoPath, path);
            if (origin) await gitText(path, "remote", "set-url", "origin", origin);
            await gitText(path, "checkout", "--detach", base);
            await gitText(path, "checkout", "--detach", commit);
            await gitText(path, "config", "--local", "queue.warmOwner", common);
          } catch (error) { return { kind: "fallback", detail: error instanceof Error ? error.message : String(error) }; }
        }
        for (const [key, value] of [["queue.warmBase", base], ["queue.warmHead", head], ["queue.warmCommit", commit], ["queue.warmTree", tree]])
          await gitText(path, "config", "--local", key, value);
      } else {
        await this.removeIsolatedCheckout(task, path, true);
        await gitText(task.repoPath, "clone", "--shared", "--no-checkout", "--", task.repoPath, path);
        if (origin) await gitText(path, "remote", "set-url", "origin", origin);
        await gitText(path, "checkout", "--detach", commit);
      }
      await verifyMergeCandidate(path, candidate);
      if (warm) {
        // A warm proof failure is a reason to build a fresh candidate, not to hold the lane.
        // The outer catch maps every remaining exception to `error`, which skips the fallback
        // the other warm failures deliberately use - so a warm-checkout problem parked a lane
        // that a disposable checkout would have built.
        try { await this.proveWarmCandidate(task, path, common); }
        catch (error) { return { kind: "fallback", detail: error instanceof Error ? error.message : String(error) }; }
      }
      return { kind: "built", candidate };
    } catch (error) { return { kind: "error", detail: error instanceof Error ? error.message : String(error) }; }
  }

  /**
   * Ensure the occurrence's pinned candidate checkout exists and holds exactly
   * the pinned synthetic commit. A missing or displaced candidate is rebuilt
   * from the pinned inputs, never from the current branch state.
   */
  async ensureProspectiveCandidate(task: Task, record: HookRecord): Promise<{ ok: true } | { ok: false; detail: string }> {
    const candidate = record.mergeCandidate;
    if (!candidate) return { ok: false, detail: "The prospective-merge occurrence lost its pinned candidate identity" };
    const warm = await this.warmCandidatePath(task);
    const disposable = await this.prospectiveCandidatePath(task, candidate);
    const owned = new Set([warm, disposable]);
    let path = record.workspace?.path ?? disposable;
    if (!owned.has(path))
      return { ok: false, detail: "The prospective-merge occurrence names a foreign candidate checkout" };
    if (existsSync(path)) {
      try {
        if (path === warm) {
          const common = await gitText(task.repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
          await this.proveWarmCandidate(task, path, common);
        }
        await verifyMergeCandidate(path, candidate); return { ok: true };
      }
      catch { /* A displaced Queue-owned candidate is replaced from its pinned inputs. */ }
    }
    if (path === warm) path = disposable;
    const built = await this.buildProspectiveCandidate(task, path, candidate.integrationBase, candidate.reviewedHead);
    if (built.kind === "conflict") return { ok: false, detail: `Prospective-merge candidate no longer merges cleanly: ${built.detail}` };
    if (built.kind === "error" || built.kind === "fallback") return { ok: false, detail: `Prospective-merge candidate could not be rebuilt: ${built.detail}` };
    if (built.candidate.commit !== candidate.commit || built.candidate.tree !== candidate.tree)
      return { ok: false, detail: "The prospective-merge candidate is not reproducible from its pinned inputs" };
    this.save(this.store.hookEvent(record.id)!, { workspace: { path, head: candidate.commit } });
    return { ok: true };
  }

  /**
   * Evaluate every required read-only `prospective_merge` `task.pre_merge` hook
   * against the exact normal merge result. The candidate is isolated and the
   * worker branch and canonical checkout are never written. Base movement after
   * a result invalidates it as operationally stale without a semantic refusal,
   * and one current candidate is rebuilt per normal lifecycle pass.
   */
  async prospectiveMergeGate(task: Task, request: ProspectiveMergeRequest): Promise<ProspectiveMergeOutcome> {
    if (!repositoryIsGitCheckout(task.repoPath)) return { kind: "none" };
    const reviewedHead = request.head;
    let staleDetail: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let base: string;
      try { base = await this.integrationBase(task); }
      catch (error) { return { kind: "hold", detail: `Prospective merge requires a clean synchronized integration base: ${error instanceof Error ? error.message : String(error)}`, records: [] }; }
      const discovery = await discoverManifest(task.repoPath, base);
      if (!discovery) return { kind: "none" };
      const bound = discovery.manifest.hooks.filter(hook => hook.events.includes("task.pre_merge") && hook.target === "prospective_merge");
      if (!bound.length) return { kind: "none" };
      const disposablePath = await this.prospectiveCandidatePath(task, { integrationBase: base, reviewedHead });
      const warmPath = await this.warmCandidatePath(task);
      const repositoryTasks = this.store.tasks().filter(owner => owner.repoPath === task.repoPath);
      const occupied = repositoryTasks.some(owner =>
        this.store.hookEvents(owner.id).some(record => record.workspace?.path === warmPath));
      const warmEvents = repositoryTasks
        .flatMap(owner => this.store.events(owner.id))
        .filter(event => event.kind === "pre_merge_warm_candidate_created" || event.kind === "pre_merge_warm_candidate_missing");
      const lastBuilt = Math.max(0, ...warmEvents.filter(event => event.kind === "pre_merge_warm_candidate_created").map(event => event.id));
      const lastMissing = Math.max(0, ...warmEvents.filter(event => event.kind === "pre_merge_warm_candidate_missing").map(event => event.id));
      const warmExists = existsSync(warmPath);
      const useWarm = this.holdsCandidateTurn(task, repositoryTasks) && !occupied && (warmExists || !lastBuilt || lastMissing > lastBuilt);
      if (!warmExists && lastBuilt && lastMissing < lastBuilt) this.store.event(task.id, "pre_merge_warm_candidate_missing", warmPath);
      let path = useWarm ? warmPath : disposablePath;
      // Durable creation intent precedes the Queue-owned checkout, exactly as for
      // an integration write. The path is deterministic for this candidate, so a
      // restart never creates a second one.
      this.store.event(task.id, "pre_merge_candidate_intent", `${base} ${reviewedHead} ${path}`);
      const buildStarted = Date.now();
      let built = await this.buildProspectiveCandidate(task, path, base, reviewedHead, useWarm);
      if (built.kind === "fallback") {
        this.store.event(task.id, "pre_merge_warm_candidate_fallback", built.detail);
        path = disposablePath;
        this.store.event(task.id, "pre_merge_candidate_intent", `${base} ${reviewedHead} ${path}`);
        built = await this.buildProspectiveCandidate(task, path, base, reviewedHead);
      }
      this.store.event(task.id, "pre_merge_candidate_build_duration", `${Date.now() - buildStarted}ms ${path === warmPath ? "warm" : "fresh"}`);
      if (built.kind === "conflict") return { kind: "conflict", base, detail: built.detail };
      if (built.kind === "error" || built.kind === "fallback") return { kind: "hold", detail: `Prospective merge candidate could not be built: ${built.detail}`, records: [] };
      if (path === warmPath) this.store.event(task.id, "pre_merge_warm_candidate_created", `${built.candidate.commit} ${path}`);
      this.store.event(task.id, "pre_merge_candidate_created", `${built.candidate.commit} ${built.candidate.tree} ${path}`);
      const pinned = { ...built.candidate, path };
      const hookStarted = Date.now();
      const outcome = await this.emit("task.pre_merge", task, {
        event: "task.pre_merge", baseCommit: base, candidate: pinned,
        delivery: { prUrl: request.prUrl ?? null, prNumber: request.prNumber ?? null, head: reviewedHead, review: request.review ?? null, summary: request.summary ?? request.review ?? "" },
      }, hook => hook.target === "prospective_merge");
      this.store.event(task.id, "pre_merge_hook_duration", `${Date.now() - hookStarted}ms`);
      // Recheck the integration base after the result. Movement is operational
      // staleness: it spends no semantic revision round and never turns a stale
      // pass or refusal into success.
      let after: string | null = null;
      try { after = await this.integrationBase(task); } catch { after = null; }
      if (after !== base) {
        staleDetail = `the integration base moved from ${base} to ${after ?? "a state Nucleus could not prove"} during the prospective merge`;
        await this.supersedeStaleCandidate(task, outcome.records, staleDetail, built.candidate);
        this.store.event(task.id, "pre_merge_candidate_stale", staleDetail);
        try { if (path !== warmPath) await this.removeIsolatedCheckout(task, path, true); }
        catch (error) { return { kind: "hold", detail: `Stale prospective-merge candidate cleanup requires reconciliation: ${error instanceof Error ? error.message : String(error)}`, records: [] }; }
        continue;
      }
      const uncertain = outcome.records.filter(record => record.state === "uncertain");
      let settled = outcome.records;
      if (!uncertain.length) {
        try { if (path !== warmPath) await this.removeIsolatedCheckout(task, path, true); }
        catch (error) { return { kind: "hold", detail: `Prospective-merge candidate cleanup requires reconciliation: ${error instanceof Error ? error.message : String(error)}`, records: outcome.records }; }
        // Settled occurrences release the checkout. A warm checkout remains
        // available for the next candidate without pinning this occurrence.
        settled = outcome.records.map(record => {
          const current = this.store.hookEvent(record.id) ?? record;
          return current.workspace?.path === path ? this.save(current, { workspace: null }) : current;
        });
      }
      if (outcome.hold) {
        // A confirmed parsed refusal is an ordinary semantic finding; every
        // other hold (uncertainty, malformed transport, drift) is operational.
        const refusal = settled.findLast(record => (record.state === "blocked" || record.state === "failed") && record.result !== null);
        if (refusal) return { kind: "refused", base, records: settled };
        return { kind: "hold", detail: hookHoldReason(outcome), records: settled };
      }
      return { kind: "ok", base, reviewedHead, records: settled };
    }
    return { kind: "hold", detail: `The prospective merge candidate did not settle before the next lifecycle pass: ${staleDetail ?? "the integration base kept moving"}`, records: [] };
  }

  /** Retain a stale candidate occurrence as failed audit evidence without recording a semantic finding. */
  async supersedeStaleCandidate(task: Task, records: HookRecord[], detail: string, candidate: MergeCandidate): Promise<void> {
    for (const record of records) {
      const current = this.store.hookEvent(record.id);
      if (!current || !["result", "blocked", "failed"].includes(current.state)) continue;
      if (current.mergeCandidate?.commit !== candidate.commit) continue;
      const summary = `Superseded without a semantic finding: ${detail}`;
      this.save(current, { state: "failed", error: summary, summary, workspace: null, processId: null, reconciledAt: now() });
      this.store.event(task.id, "hook_occurrence_superseded", `${current.hookId} ${current.event} ${current.eventId}: ${summary}`);
    }
  }
}
