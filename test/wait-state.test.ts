import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { submissionSchema, summarizeTask, taskHoldKind, taskDetailView } from '../shared/contracts';
import {
  CAPACITY_WAIT_PREFIX, PROJECT_IN_FLIGHT_WAIT_PREFIX, PREREQUISITE_WAIT_PREFIX, deriveWaitState, inFlightSlotWaitReason, prerequisiteCannotComplete, qaCapacityWaitReason,
  waitDeclarationSchema, waitReasonFor, waitReasonStates, waitStateForReason, waitStateLabels, waitStateViewSchema, waitStates,
} from '../shared/wait-state';

const head = 'a'.repeat(40);

/** Every current waiting reason Queue itself writes for the declared states. */
const SLOT_ACTION = 'Free a task slot or raise the limit; Nucleus dispatches when capacity allows';
const IN_FLIGHT_ACTION = 'Wait for in-flight tasks to finish; Nucleus starts work when the project is under its cap';
const QA_ACTION = 'Waits for machine-wide QA capacity; it starts automatically when admitted';
const PREREQUISITE_WAIT_ACTION = 'Wait for the prerequisite to finish; Nucleus dispatches this task automatically';
const PREREQUISITE_FIX_ACTION = 'Correct the dependency list before dispatch (set_dependencies): drop the missing, removed, cancelled or goal-unmet prerequisite';
/** `Store.dependencyWait` writes the prerequisite's own id, a UUID, before its status. */
const dep = '11111111-2222-3333-4444-555555555555';
const currentReasons: Array<{ reason: string; state: string; owner: string; nextAction: string }> = [
  { reason: `${CAPACITY_WAIT_PREFIX} Global concurrent task-slot limit reached`, state: 'waiting_capacity', owner: 'operator', nextAction: SLOT_ACTION },
  { reason: `${CAPACITY_WAIT_PREFIX} Project concurrent task-slot limit reached`, state: 'waiting_capacity', owner: 'operator', nextAction: SLOT_ACTION },
  { reason: inFlightSlotWaitReason(1), state: 'waiting_capacity', owner: 'operator', nextAction: SLOT_ACTION },
  { reason: inFlightSlotWaitReason(4), state: 'waiting_capacity', owner: 'operator', nextAction: SLOT_ACTION },
  { reason: `${PROJECT_IN_FLIGHT_WAIT_PREFIX}25 of 12 tasks in flight for this project`, state: 'waiting_capacity', owner: 'operator', nextAction: IN_FLIGHT_ACTION },
  { reason: qaCapacityWaitReason(1), state: 'waiting_capacity', owner: 'Queue QA scheduler', nextAction: QA_ACTION },
  { reason: qaCapacityWaitReason(7), state: 'waiting_capacity', owner: 'Queue QA scheduler', nextAction: QA_ACTION },
  // A prerequisite still able to finish: Queue resumes this task automatically.
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): running`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): blocked`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): needs_attention`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  // A free-form title that contains a terminal word is still an ordinary wait: the status is the generated suffix.
  { reason: `${PREREQUISITE_WAIT_PREFIX} Fix: removed before completion (${dep}): running`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Cancelled: retry later (${dep}): working`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} missing: nothing real (${dep}): queued`, state: 'waiting_prerequisite', owner: 'Queue', nextAction: PREREQUISITE_WAIT_ACTION },
  // Only done satisfies a prerequisite; a terminal cancelled one can never finish, so the operator acts.
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): cancelled`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  // A prerequisite that can never finish: the operator corrects the dependency list.
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): removed before completion`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} ${dep}: missing`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  // Mixed entries: one uncompletable prerequisite makes the whole wait unclosable, so the operator acts.
  { reason: `${PREREQUISITE_WAIT_PREFIX} ${dep}: missing; Ship the parser (${dep}): running`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): running; ${dep}: missing`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): cancelled; Other (${dep}): running`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
  { reason: `${PREREQUISITE_WAIT_PREFIX} Other (${dep}): running; Ship the parser (${dep}): cancelled`, state: 'waiting_prerequisite', owner: 'operator', nextAction: PREREQUISITE_FIX_ACTION },
];

/** Reasons that are operational progress, not one of the five declared waits. */
const operationalReasons = [
  'Transient provider error; resuming the same worker thread in 30s. Evidence: rate limited',
  'Waiting for repository integration turn',
  'Waiting for dispatch',
  "Worker's QA run is running under Queue's scheduler",
  "Worker's validation is still running in the worktree: effigy qa",
  'Repository hook main.task.pre_merge holds this transition: refused',
  'Merge outcome is uncertain; GitHub evidence is incomplete, so Queue is holding the integration turn',
  'Retained worker profile is disabled or unavailable',
];

test('Spec 043 (a): every current waiting reason maps to exactly one state with an owner and a next action', () => {
  for (const { reason, state, owner, nextAction } of currentReasons) {
    const matches = waitReasonStates.filter(entry => reason.startsWith(entry.prefix) && (!entry.matches || entry.matches(reason)));
    assert.equal(matches.length, 1, `${reason} must match exactly one declared reason entry`);
    assert.equal(matches[0].state, state);
    assert.equal(matches[0].owner, owner);
    assert.equal(matches[0].nextAction, nextAction);
    assert.equal(waitReasonFor(reason)?.owner, owner);
    assert.equal(waitStateForReason(reason), reason.startsWith('Waiting for QA capacity') ? state : null);
    const context = reason.startsWith(CAPACITY_WAIT_PREFIX) || reason.startsWith(PROJECT_IN_FLIGHT_WAIT_PREFIX) ? { slotAdmissionReason: reason }
      : reason.startsWith(PREREQUISITE_WAIT_PREFIX) ? { dependencyWait: reason } : {};
    const wait = deriveWaitState({ phase: 'queued', reason, holdKind: null, holdOwner: null, originAgentId: 'origin' }, context);
    assert.ok(wait, `${reason} must derive a wait state`);
    assert.equal(wait.state, state);
    assert.equal(wait.owner, owner, `${reason} must name the reason's owner`);
    assert.equal(wait.nextAction, nextAction, `${reason} must name the reason's next action`);
    assert.equal(wait.decisionId, undefined, 'only needs_operator_input links a decision');
  }
});

test('Spec 043 (a): a removed, missing or terminal-cancelled prerequisite names the operator and the dependency correction, not an impossible wait', () => {
  const task = { phase: 'queued', reason: '', holdKind: null, holdOwner: null, originAgentId: 'origin' } as const;
  const running = `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): running`;
  const removed = `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): removed before completion`;
  const missing = `${PREREQUISITE_WAIT_PREFIX} ${dep}: missing`;
  const cancelled = `${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): cancelled`;
  assert.equal(deriveWaitState({ ...task, reason: running }, { dependencyWait: running })?.owner, 'Queue');
  assert.equal(deriveWaitState({ ...task, reason: running }, { dependencyWait: running })?.nextAction, PREREQUISITE_WAIT_ACTION);
  for (const reason of [removed, missing, cancelled]) {
    const wait = deriveWaitState({ ...task, reason }, { dependencyWait: reason });
    assert.equal(wait?.state, 'waiting_prerequisite', 'all prerequisite reasons keep the one state');
    assert.equal(waitStateLabels[wait!.state], 'Waiting for prerequisite');
    assert.equal(wait?.owner, 'operator', `${reason} needs the operator, not Queue`);
    assert.equal(wait?.nextAction, PREREQUISITE_FIX_ACTION);
    assert.equal(prerequisiteCannotComplete(reason), true);
  }
  assert.equal(prerequisiteCannotComplete(running), false, 'a running prerequisite can still finish');
  assert.equal(prerequisiteCannotComplete(`${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): blocked`), false, 'a blocked prerequisite can still finish');
  assert.equal(prerequisiteCannotComplete(`${PREREQUISITE_WAIT_PREFIX} Ship the parser (${dep}): needs_attention`), false, 'a needs_attention prerequisite can still finish');
  // A free-form title is never read as a status: the generated suffix decides.
  for (const title of ['Fix: removed before completion', 'Cancelled upstream', 'missing: not found', 'Fix (again): cancelled; then resumed']) {
    const titled = `${PREREQUISITE_WAIT_PREFIX} ${title} (${dep}): running`;
    assert.equal(prerequisiteCannotComplete(titled), false, `title ${JSON.stringify(title)} is not a status`);
    assert.equal(deriveWaitState({ ...task, reason: titled }, { dependencyWait: titled })?.owner, 'Queue', `title ${JSON.stringify(title)} keeps Queue's automatic wait`);
    assert.equal(deriveWaitState({ ...task, reason: titled }, { dependencyWait: titled })?.nextAction, PREREQUISITE_WAIT_ACTION);
  }
  // A non-id token before a missing status is title text, not a generated missing entry.
  assert.equal(prerequisiteCannotComplete(`${PREREQUISITE_WAIT_PREFIX} task-2: missing`), false, 'a titled missing status is not a generated entry');
});

test('Spec 043 (a): the four structured states derive from durable facts, and only a declaration names source rights', () => {
  const mergeHold = deriveWaitState({ phase: 'verifying', reason: 'Waiting for prerequisites', holdKind: 'merge', holdOwner: 'agent-hold', originAgentId: 'origin' });
  assert.equal(mergeHold?.state, 'merge_hold', 'stale prerequisite text at verifying still yields merge_hold');
  assert.equal(mergeHold?.owner, 'agent-hold');
  const currentPrereq = deriveWaitState({ phase: 'verifying', reason: 'Waiting for prerequisites', holdKind: 'merge', holdOwner: 'agent-hold', originAgentId: 'origin', mergeHeld: true },
    { dependencyWait: `${PREREQUISITE_WAIT_PREFIX} Source (${dep}): working` });
  assert.equal(currentPrereq?.state, 'waiting_prerequisite', 'a current prerequisite outranks a merge hold');

  const inheritedOwner = deriveWaitState({ phase: 'verifying', reason: 'Merge held by operator; release to continue', holdKind: 'merge', holdOwner: null, originAgentId: 'origin' });
  assert.equal(inheritedOwner?.owner, 'origin', 'a hold with no recorded owner inherits the origin');

  const decision = deriveWaitState({ phase: 'blocked', reason: 'Awaiting the operator ruling', holdKind: null, holdOwner: null, originAgentId: 'origin' }, { decisionId: 'dec-1' });
  assert.equal(decision?.state, 'needs_operator_input');
  assert.equal(decision?.owner, 'operator');
  assert.equal(decision?.decisionId, 'dec-1', 'needs_operator_input links the Spec 032 decision');

  const declared = deriveWaitState({ phase: 'awaiting_review', reason: 'Waiting on upstream rights', holdKind: null, holdOwner: null, originAgentId: 'origin' },
    { declaration: { state: 'needs_source_rights', owner: 'operator', nextAction: 'Grant source rights', decisionId: null } });
  assert.equal(declared?.state, 'needs_source_rights', 'only an explicit declaration sets source rights');
  assert.equal(declared?.owner, 'operator');
  assert.equal(declared?.nextAction, 'Grant source rights');

  // Free text never invents source rights or any other state.
  for (const reason of ['Needs source rights', 'source-rights pending', 'waiting for source rights', 'Needs operator input']) {
    assert.equal(deriveWaitState({ phase: 'blocked', reason, holdKind: null, holdOwner: null, originAgentId: 'origin' }), null, `${reason} is free text, not a declaration`);
    assert.equal(waitStateForReason(reason), null);
  }
});

test('Spec 043 (a): the owner and next action come from the matched waiting reason, not from the state alone', () => {
  const task = { phase: 'queued', reason: '', holdKind: null, holdOwner: null, originAgentId: 'origin' } as const;
  // A task-slot wait clears by freeing a slot.
  const slotReason = `${CAPACITY_WAIT_PREFIX} Global concurrent task-slot limit reached`;
  const slot = deriveWaitState({ ...task, reason: slotReason }, { slotAdmissionReason: slotReason });
  assert.equal(slot?.state, 'waiting_capacity');
  assert.equal(waitStateLabels[slot!.state], 'Waiting for capacity');
  assert.equal(slot?.owner, 'operator');
  assert.equal(slot?.nextAction, 'Free a task slot or raise the limit; Nucleus dispatches when capacity allows');
  assert.equal(waitReasonFor(slotReason)?.owner, 'operator');
  // A project-validation wait is in the separate machine-wide QA scheduler and clears itself.
  const qaReason = qaCapacityWaitReason(3);
  const qa = deriveWaitState({ ...task, phase: 'closing', reason: qaReason });
  assert.equal(qa?.state, 'waiting_capacity', 'both capacity waits keep the waiting_capacity state');
  assert.equal(waitStateLabels[qa!.state], 'Waiting for capacity');
  assert.equal(qa?.owner, 'Queue QA scheduler');
  assert.equal(qa?.nextAction, 'Waits for machine-wide QA capacity; it starts automatically when admitted');
  assert.equal(waitReasonFor(qaReason)?.owner, 'Queue QA scheduler');
  // The two capacity entries share a state but never share an owner or action.
  assert.notEqual(waitReasonFor(slotReason)?.owner, waitReasonFor(qaReason)?.owner);
  assert.notEqual(waitReasonFor(slotReason)?.nextAction, waitReasonFor(qaReason)?.nextAction);
});

test('Spec 043 (a): needs_operator_input requires its Spec 032 decision and no other wait state may carry one', () => {
  const base = { owner: 'operator', nextAction: 'Do the thing' };
  // A linked decision is required for operator input and refused everywhere else.
  assert.equal(waitDeclarationSchema.safeParse({ ...base, state: 'needs_operator_input', decisionId: 'dec-1' }).success, true);
  assert.equal(waitDeclarationSchema.safeParse({ ...base, state: 'needs_source_rights' }).success, true, 'the decision id defaults to null');
  assert.equal(waitDeclarationSchema.safeParse({ ...base, state: 'needs_operator_input', decisionId: null }).success, false, 'operator input without its decision is refused');
  assert.equal(waitDeclarationSchema.safeParse({ ...base, state: 'needs_operator_input' }).success, false, 'operator input must not rely on the null default');
  for (const state of waitStates.filter(candidate => candidate !== 'needs_operator_input'))
    assert.equal(waitDeclarationSchema.safeParse({ ...base, state, decisionId: 'dec-1' }).success, false, `${state} must not carry a decisionId`);
  // The derived view enforces the same invariant at the board boundary.
  assert.equal(waitStateViewSchema.safeParse({ ...base, state: 'needs_operator_input' }).success, false);
  assert.equal(waitStateViewSchema.safeParse({ ...base, state: 'merge_hold', decisionId: 'dec-1' }).success, false);
  assert.equal(waitStateViewSchema.safeParse({ ...base, state: 'needs_operator_input', decisionId: 'dec-1' }).success, true);
  // deriveWaitState revalidates a declaration instead of forwarding it.
  const task = { phase: 'blocked', reason: '', holdKind: null, holdOwner: null, originAgentId: 'origin' } as const;
  assert.throws(() => deriveWaitState(task, { declaration: { state: 'needs_operator_input', owner: 'operator', nextAction: 'Ask the operator', decisionId: null } }),
    /needs_operator_input requires the Spec 032 decisionId/);
  assert.throws(() => deriveWaitState(task, { declaration: { state: 'needs_source_rights', owner: 'operator', nextAction: 'Grant rights', decisionId: 'dec-1' } }),
    /needs_source_rights must not carry a decisionId/);
  assert.equal(deriveWaitState(task, { declaration: { state: 'needs_operator_input', owner: 'operator', nextAction: 'Ask the operator', decisionId: 'dec-1' } })?.decisionId, 'dec-1');
});

test('Spec 043 (a): operational progress and an ordinary dispatch hold are not declared waits', () => {
  for (const reason of operationalReasons) {
    assert.equal(waitStateForReason(reason), null, `${reason} is progress detail`);
    assert.equal(deriveWaitState({ phase: 'working', reason, holdKind: null, holdOwner: null, originAgentId: 'origin' }), null);
  }
  assert.equal(deriveWaitState({ phase: 'queued', reason: 'Waiting for design', holdKind: 'dispatch', holdOwner: 'operator', originAgentId: 'origin' }), null, 'a dispatch hold keeps its Spec 040 badge, not a wait state');
});

test('Spec 043 (a): every wait state has a board label and is reachable from a current reason or an explicit declaration', () => {
  const reachable = new Set<string>(currentReasons.map(entry => entry.state));
  reachable.add(deriveWaitState({ phase: 'verifying', reason: '', holdKind: 'merge', holdOwner: 'o', originAgentId: 'origin' })!.state);
  reachable.add(deriveWaitState({ phase: 'blocked', reason: '', holdKind: null, holdOwner: null, originAgentId: 'origin' }, { decisionId: 'd' })!.state);
  reachable.add(deriveWaitState({ phase: 'awaiting_review', reason: '', holdKind: null, holdOwner: null, originAgentId: 'origin' },
    { declaration: { state: 'needs_source_rights', owner: 'operator', nextAction: 'Grant source rights', decisionId: null } })!.state);
  for (const state of waitStates) {
    assert.ok(reachable.has(state), `${state} must be reachable`);
    assert.ok(waitStateLabels[state].length > 0, `${state} must have a board label`);
  }
  assert.deepEqual([...reachable].sort(), [...waitStates].sort());
});

test('Spec 043 (a): the summary and detail projections carry the same derived wait state', () => {
  const store = new Store(':memory:');
  try {
    const add = (id: string) => store.insert(submissionSchema.parse({
      submissionId: id, title: id, repoPath: '/fixture', planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin',
    }), 'host', 'handoff', head);
    const capacity = add('capacity');
    store.update(capacity.id, { reason: `${CAPACITY_WAIT_PREFIX} Project concurrent task-slot limit reached` });
    const summary = summarizeTask(store.task(capacity.id), false, false, { slotAdmissionReason: `${CAPACITY_WAIT_PREFIX} Project concurrent task-slot limit reached` });
    assert.equal(summary.waitState?.state, 'waiting_capacity');
    assert.ok(summary.waitState?.owner && summary.waitState.nextAction);
    assert.equal(taskDetailView(store.task(capacity.id), { slotAdmissionReason: `${CAPACITY_WAIT_PREFIX} Project concurrent task-slot limit reached` }).waitState?.state, 'waiting_capacity');

    const held = add('held');
    store.update(held.id, { held: true, mergeHold: true, holdOwner: 'agent-hold', reason: 'Waiting for prerequisites' });
    assert.equal(taskHoldKind(store.task(held.id)), 'merge');
    assert.equal(summarizeTask(store.task(held.id)).waitState, undefined, 'a queued merge hold is a secondary flag, not the wait');
    assert.equal('waitState' in taskDetailView(store.task(held.id)), false, 'stale prerequisite text does not invent a wait');
    assert.ok(summarizeTask(store.task(held.id)).holds?.merge, 'board summary still names the merge fence');

    const linked = add('linked');
    assert.equal(summarizeTask(store.task(linked.id), false, false, { decisionId: 'dec-linked' }).waitState?.decisionId, 'dec-linked');
    assert.equal(taskDetailView(store.task(linked.id), { decisionId: 'dec-linked' }).waitState?.state, 'needs_operator_input');

    const plain = add('plain');
    assert.equal('waitState' in summarizeTask(store.task(plain.id)), false, 'a task in no declared wait omits the field');
    assert.equal('waitState' in taskDetailView(store.task(plain.id)), false);
  } finally { store.close(); }
});

test('stale wait reasons do not outweigh current decision, prerequisite or slot facts; a merge hold yields to a current slot refusal', () => {
  const stale = { phase: 'blocked', reason: CAPACITY_WAIT_PREFIX + ' Project concurrent task-slot limit reached', holdKind: null, holdOwner: null, originAgentId: 'origin' } as const;
  assert.equal(deriveWaitState(stale), null, 'stale task-slot capacity text is not a current refusal');
  assert.equal(deriveWaitState(stale, { decisionId: 'decision-1' })?.state, 'needs_operator_input');
  const dependency = PREREQUISITE_WAIT_PREFIX + 'Source task (' + dep + '): working';
  const prerequisite = deriveWaitState(stale, { dependencyWait: dependency, prerequisiteOwner: dep, prerequisiteReason: 'Wait for the source task' });
  assert.equal(prerequisite?.state, 'waiting_prerequisite');
  assert.equal(prerequisite?.owner, dep);
  assert.equal(prerequisite?.reason, 'Wait for the source task');
  assert.equal(prerequisite?.nextAction, 'Wait for the listed prerequisites; Nucleus will notify the owner. Explicitly revise or retry a changes-requested task after the notice');
  assert.equal(deriveWaitState(stale, { slotAdmissionReason: CAPACITY_WAIT_PREFIX + ' Project concurrent task-slot limit reached' })?.state, 'waiting_capacity');
  assert.equal(deriveWaitState({ ...stale, holdKind: 'merge', mergeHeld: true }, { slotAdmissionReason: CAPACITY_WAIT_PREFIX + ' Project concurrent task-slot limit reached' })?.state, 'waiting_capacity', 'a merge-held task waiting for a slot shows the capacity wait');
  assert.equal(deriveWaitState({ phase: 'verifying', reason: '', holdKind: 'merge', holdOwner: 'agent-hold', originAgentId: 'origin', mergeHeld: true })?.state, 'merge_hold', 'merge_hold is primary only when otherwise ready to merge');
});
