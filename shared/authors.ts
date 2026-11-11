/**
 * The models that authored a task: the review independence set. Pure, so the
 * runtime selector, the retained-restart guard, the verdict-time guard and the
 * board's demand preview read one definition.
 */
type Contributor = { agentId?: string | null; profile?: { model?: string | null } | null };
type AuthoredTask = {
  agentId?: string | null; runId?: string | null;
  entrypoint?: string;
  workerModel?: string | null; workerModels?: readonly string[]; profile?: { model: string } | null;
  /** Retired Queue authors; their recorded model is author evidence like the current one. */
  retiredWorkers?: readonly Contributor[];
  /** Author-side proof executions (Spec 055): their models are author evidence too. */
  proofExecutions?: readonly Contributor[];
  reviewEntry?: { authorDeclaration: { models: readonly string[] } } | null;
  resolution?: { externalOwnerRevisions?: ReadonlyArray<{ actor: { role: string }; observations?: { sourceOwner?: { model?: string | null }; owner?: { model?: string | null } } | null }> } | null;
};

/**
 * Actual observed source-owner models supplement the unchanged intake
declaration. A recorded later revision whose observation is absent (retained
older receipts, or a relay without a source observation) still names an author
whose model is unknown: it contributes the opaque marker, never nothing.
 */
export function externalAuthorModels(task: AuthoredTask): string[] {
  return (task.resolution?.externalOwnerRevisions ?? []).flatMap(receipt => {
    const observed = receipt.observations?.sourceOwner ?? (receipt.actor.role === "project_owner" ? receipt.observations?.owner : undefined);
    if (!observed) return ["default"];
    const model = observed.model;
    return !model || model.split("/").at(-1)?.toLowerCase() === "unknown" ? ["default"] : [model];
  });
}

/**
 * Model keys that name no concrete model. A provider-qualified `provider/unknown`
 * is as opaque as a blank route: neither can prove review independence.
 */
const OPAQUE_MODEL_KEYS = new Set(["default", "unknown"]);

/**
 * One model string as runtime compares it; a blank, missing, `default` or
 * `unknown` model is the opaque "default". Whitespace-only components are blank.
 */
export function authorModelKey(value: string | null | undefined): string {
  const key = value?.split("/").at(-1)?.trim().toLowerCase() ?? "";
  return !key || OPAQUE_MODEL_KEYS.has(key) ? "default" : key;
}

/**
 * Every recorded author model string for a task, before normalization: the
 * current and prior Queue authors, the declared and observed external authors,
 * the author-side proof executor models, and any supplied revision runs. The
 * literal "default" marks a contributor whose model was never recorded.
 *
 * `revisionRuns` is optional because only a store reader can supply it. A run
 * bound to a distinct agent with no recorded model is that unknown contributor;
 * a run bound to the task's own recorded author (or to no agent at all) adds no
 * author of its own.
 */
export function taskAuthorModels(task: AuthoredTask, revisionRuns: readonly Contributor[] = []): string[] {
  // Review-entry tasks record their reviewer selection in worker fields; those
  // fields are not source authors. The external author declaration and actual
  // revision runs provide the author evidence for these tasks.
  const current = task.entrypoint === "review" ? "" : task.workerModel ?? task.profile?.model ?? "";
  const knownAuthorAgents = new Set([task.agentId, ...(task.retiredWorkers ?? []).map(item => item.agentId)].filter(Boolean));
  const revision = revisionRuns.flatMap(run => {
    const recorded = run.profile?.model?.trim();
    if (recorded) return [recorded];
    return run.agentId && !knownAuthorAgents.has(run.agentId) ? ["default"] : [];
  });
  const retired = (task.retiredWorkers ?? []).flatMap(item => item.profile?.model ? [item.profile.model] : []);
  const executors = (task.proofExecutions ?? []).flatMap(record => record.profile?.model ? [record.profile.model] : []);
  // A bound Queue worker/run still proves an author exists even when its
  // model was never recorded. Without that identity, these fields describe
  // the retained reviewer and must not enter the source author set.
  const unknownReviewEntryAuthor = task.entrypoint === "review" && (task.agentId || task.runId) && !revision.length ? ["default"] : [];
  return [
    ...(task.entrypoint === "review" ? [] : task.workerModels ?? []), ...(task.reviewEntry?.authorDeclaration.models ?? []), ...externalAuthorModels(task),
    ...executors, ...retired, ...(current ? [current] : []), ...revision, ...unknownReviewEntryAuthor,
  ];
}

/**
 * The Queue authoring worker whose head is under review, as runtime compares
 * models: its recorded model key, `"default"` when such a worker exists but its
 * model is unknown, and `null` when no Queue worker authored any part of the
 * task. Absent is not unknown: a workerless external-PR review entry carries
 * its declared and observed external authors instead of a manufactured worker.
 */
export function queueAuthorModelKey(task: AuthoredTask): string | null {
  // A proof-only task has no source author. Its retained reviewer may also
  // host the native operator GO question, but that does not make the reviewer
  // an author of the merged source.
  if (task.entrypoint === 'proof') return null;
  const model = task.entrypoint === "review" ? "" : task.workerModel ?? task.profile?.model ?? "";
  const authored = task.entrypoint !== "review" && Boolean(model || task.agentId || task.runId || task.workerModels?.length || task.retiredWorkers?.length);
  return authored ? authorModelKey(model) : null;
}

/** Every author model key, normalized as runtime compares them; "default" marks an opaque author. */
export function taskAuthorModelKeys(task: AuthoredTask, revisionRuns: readonly Contributor[] = []): Set<string> {
  return new Set(taskAuthorModels(task, revisionRuns).map(authorModelKey));
}
