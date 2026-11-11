import { useTaskDraft, type TaskDrafts } from "./drafts";
import { Text, View } from "react-native";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRpc, Icon } from "../shell";
import { ActionButton, Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { type Task, type TaskNext, type UiQueueState, holdsOf } from "../../shared/contracts";
import { operationStateLabel, type QueueOperation } from "../../shared/operations";
import { workerThinking } from "../../shared/pool";
import { formatTelemetryDuration } from "../../shared/telemetry";
import { ProjectQaFailures, ProjectQaLogWriteErrors, ProjectQaSteps } from "../planning-panel";
import { attention, budgetSummary } from "../board/text";
import { HeavyRunStatus } from "../board/badges";
import { taskIdentityFields, RawRecords, DetailField, type BoardAct } from "./parts";
import { VerbReference, NORMAL_USAGE, choiceTag, SelectedProfilePolicy, RoutingPolicyLines } from "./next-section";
import { ProjectValidationSection, CompactTelemetrySummary } from "../telemetry-parts";
import type { TaskDetailRead, TaskQaRun } from "./task-dialog";
import { decisionAge } from "../../shared/pipeline-board";
import type { BoardNavigation } from "../shell/types";

/**
 * Bounded queued/running/attention feedback for one task's durable operations.
 * A pending operation disables only the controls for the affected task; nothing
 * here creates a global loading state or a new page.
 */
function OperationState({ operations, c }: { operations: QueueOperation[]; c: Colors }) {
  if (!operations.length) return null;
  return <View style={{ gap: 4 }}>
    {operations.slice(0, 4).map(operation => {
      const attention = operation.state === "needs_attention" || operation.state === "failed";
      const color = attention ? c.statusWarning : operation.state === "succeeded" ? c.foregroundMuted : c.accent;
      return <View key={operation.id} style={{ ...row, flexWrap: "nowrap", gap: 6 }}>
        <Icon name={attention ? "TriangleAlert" : operation.state === "succeeded" ? "Check" : "LoaderCircle"} size={12} color={color} />
        <Text numberOfLines={2} selectable accessibilityLabel={operationStateLabel(operation)} style={{ color, fontSize: 12, flex: 1, minWidth: 0 }}>
          {operationStateLabel(operation)}{operation.diagnostic ? ` · ${operation.diagnostic}` : ""}
        </Text>
      </View>;
    })}
  </View>;
}

/**
 * The Technical tab: hooks, review entry, routing, disposition, controls and escalation.
 * It owns its form state, so typing a reason re-renders this tab, not the board.
 */
export function TechnicalTab({ task, drafts, detailQuery, nextQuery, state, qaRun: taskQaRun, pendingOperation, compact, busy, act, navigation, onClose, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; nextQuery: UseQueryResult<TaskNext>; state: UiQueueState | undefined; qaRun: TaskQaRun | undefined; pendingOperation: boolean; compact: boolean; busy: boolean; act: BoardAct; drafts: TaskDrafts; navigation?: BoardNavigation; onClose: () => void; c: Colors }) {
  const queryClient = useQueryClient();
  const setTask = useRpc(api.taskControl), removeTask = useRpc(api.removeTask);
  const [disposeReason, setDisposeReason] = useTaskDraft(drafts, "disposeReason", "");
  const [withdrawReason, setWithdrawReason] = useTaskDraft(drafts, "withdrawReason", "");
  const [escalationAnswer, setEscalationAnswer] = useTaskDraft(drafts, "escalationAnswer", "");
  const [replacementId, setReplacementId] = useTaskDraft(drafts, "replacementId", "");
  const [workDisposition, setWorkDisposition] = useTaskDraft<"preserve" | "archive_if_empty" | "retained_by_replacement">(drafts, "workDisposition", "archive_if_empty");
  const [holdReason, setHoldReason] = useTaskDraft(drafts, "holdReason", "");
  const [routingOpen, setRoutingOpen] = useTaskDraft(drafts, "routingOpen", false);
  const [routingReason, setRoutingReason] = useTaskDraft(drafts, "routingReason", "");
  const [routingScope, setRoutingScope] = useTaskDraft<Task["scope"]>(drafts, "routingScope", "general");
  const [routingComplexity, setRoutingComplexity] = useTaskDraft<Task["complexity"]>(drafts, "routingComplexity", null);
  const [routingPreferred, setRoutingPreferred] = useTaskDraft(drafts, "routingPreferred", "");
  const [routingRequired, setRoutingRequired] = useTaskDraft(drafts, "routingRequired", false);
  const [routingThinking, setRoutingThinking] = useTaskDraft(drafts, "routingThinking", "");
  const [routingRequests, setRoutingRequests] = useTaskDraft<Record<"worker"|"reviewer"|"coordinator",{profileId:string;reason:string;required:boolean}>>(drafts, "routingRequests", {worker:{profileId:"",reason:"",required:false},reviewer:{profileId:"",reason:"",required:false},coordinator:{profileId:"",reason:"",required:false}});
  const taskSummaryStop = state?.tasks.find(item => item.id === task.id)?.stopRecord;
  // nucleus#1000: the one withdrawal rule, shared with the applied control —
  // pending thread-stop requests only, or any fence parked in needs_attention.
  const canWithdrawCancellation = Boolean(task.disposition && task.disposition.kind === "cancel" &&
    ((["intent", "draining"].includes(task.disposition.status) &&
      task.disposition.effects.every(effect => effect.kind === "stop_thread" && effect.result === null && effect.resultAt === null && !effect.uncertain)) ||
      task.disposition.status === "needs_attention"));
  const canChangeRouting=Boolean(!task.removedAt&&["queued","needs_attention"].includes(task.phase)&&!task.agentIntent&&!task.agentId);
  const routingProfiles=(state?.pool??[]).filter(entry=>entry.enabled).map(entry=>({entry,profile:state?.profiles.find(profile=>profile.id===entry.profileId)})).filter(item=>item.profile?.available);
  const taskOperations = detailQuery.data?.operations ?? [];
  const stalledIncident = task.resolution.incident?.cause === "stalled_turn" && task.resolution.incident.status !== "resolved"
    ? task.resolution.incident : null;
  const stalledTurnStop = task.resolution.stalledTurnStop ?? null;
  const escalatedEpisode = task.resolution.incident?.status === "escalated" || task.resolution.recovery?.status === "escalated";
  return <View style={{ gap: 12 }}>
    {nextQuery.data?.workerDemandStep && <Text accessibilityLabel={`Worker demand ${nextQuery.data.workerDemandStep}`} style={{ ...muted(c), fontSize: 12 }}>Worker demand · {nextQuery.data.workerDemandStep}</Text>}
    {nextQuery.data && <RoutingPolicyLines policy={nextQuery.data.routingPolicy} c={c} />}
    {nextQuery.data && <VerbReference verbs={nextQuery.data.verbs} c={c} />}
    {taskSummaryStop && <DetailSection title="Stop details" c={c}>
      <Text accessibilityLabel={`Stop category ${taskSummaryStop.reason}`} selectable style={{ ...muted(c), fontSize: 12 }}>Stop category · {taskSummaryStop.reason}</Text>
      {taskSummaryStop.suggestedVerbs.length > 0 && <Text accessibilityLabel={`Suggested owner verbs ${taskSummaryStop.suggestedVerbs.join(", ")}`} selectable style={{ ...muted(c), fontSize: 12 }}>Suggested owner verbs · {taskSummaryStop.suggestedVerbs.join(", ")}</Text>}
    </DetailSection>}
    <DetailSection title="Task identity" c={c}>
      <View style={{ ...row, alignItems: "flex-start", gap: 14 }}>
        {taskIdentityFields(task).filter((field) => !field.raw).map((field) => (
          <DetailField key={field.label} label={field.label} value={field.value} c={c} compact={compact} />
        ))}
      </View>
      <RawRecords label="Raw IDs and records" c={c}>
        <View style={{ ...row, alignItems: "flex-start", gap: 14 }}>
          {taskIdentityFields(task).filter((field) => field.raw).map((field) => (
            <DetailField key={field.label} label={field.label} value={field.value} c={c} compact={compact} />
          ))}
        </View>
      </RawRecords>
    </DetailSection>
    {Boolean(detailQuery.data?.hooks.length) && (
      <DetailSection title="Repository hooks" c={c}>
        {detailQuery.data!.hooks.filter((hook) => hook.replay)
          .length > 0 && (
          <Text
            selectable
            style={{ ...muted(c), fontSize: 12 }}
          >
            Automatic exact-identity replays{" "}
            {
              detailQuery.data!.hooks.filter(
                (hook) => hook.replay,
              ).length
            }{" "}
            · at most 2 advances per held event, superseded
            occurrences retained
          </Text>
        )}
        {detailQuery.data?.hooks.map((hook) => (
          <View
            key={hook.id}
            style={{
              gap: 4,
              paddingBottom: 8,
              borderBottomWidth: 1,
              borderBottomColor: c.border,
            }}
          >
            <Text
              style={{
                color: [
                  "blocked",
                  "failed",
                  "uncertain",
                ].includes(hook.state)
                  ? c.statusWarning
                  : c.foreground,
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {hook.hookId} · {hook.event} · {hook.state}
            </Text>
            {hook.target === "reviewed_head" && (
              <Text selectable style={muted(c)}>
                Reviewed-head target · exact head{" "}
                {hook.baseCommit.slice(0, 12)}
              </Text>
            )}
            <RawRecords label={`Replay, commit and program evidence for ${hook.hookId}`} c={c}>
              {hook.replay && (
                <Text selectable style={muted(c)}>
                  Automatic replay {hook.replay.ordinal} of 2 ·
                  occurrence {hook.replay.fromOccurrence} →{" "}
                  {hook.occurrence} · base{" "}
                  {hook.replay.baseCommit.slice(0, 12)} · from{" "}
                  {hook.replay.fromEventId}
                </Text>
              )}
              {hook.replayIntent && !hook.replay && (
                <Text selectable style={muted(c)}>
                  Automatic replay {hook.replayIntent.ordinal} of
                  2 recorded at base{" "}
                  {hook.replayIntent.baseCommit.slice(0, 12)}
                  {hook.state === "blocked"
                    ? " · awaiting the fresh occurrence"
                    : " · superseded by the fresh occurrence"}
                </Text>
              )}
              {hook.target === "prospective_merge" && (
                <Text selectable style={muted(c)}>
                  Prospective merge target · base{" "}
                  {hook.mergeCandidate?.integrationBase.slice(
                    0,
                    12,
                  ) ?? "unpinned"}{" "}
                  · reviewed head{" "}
                  {hook.mergeCandidate?.reviewedHead.slice(
                    0,
                    12,
                  ) ?? "unpinned"}{" "}
                  · candidate{" "}
                  {hook.mergeCandidate?.commit.slice(0, 12) ??
                    "unpinned"}
                </Text>
              )}
              <Text selectable style={muted(c)}>
                {hook.program.kind === "trusted_runner"
                  ? `Trusted runner ${hook.program.runner} · revision ${hook.program.revision} · ${hook.program.digest} · ${hook.program.hostId} · ${hook.program.versionLabel || "no version label"} · ${hook.program.os}/${hook.program.architecture}`
                  : hook.program.kind === "tool"
                    ? `Tool ${hook.program.name} · ${hook.program.path} · ${hook.program.digest}`
                  : hook.program.kind === "unavailable_tool"
                    ? `Tool ${hook.program.name} · ${hook.program.error}`
                  : hook.program.kind === "repository"
                    ? `Repository program ${hook.program.executable.path}@${hook.program.executable.digest}`
                    : `Trusted runner ${hook.program.runner} · unavailable before spawn`}
              </Text>
            </RawRecords>
            {(hook.error || hook.summary) && (
              <Text
                selectable
                style={{
                  color: hook.error
                    ? c.statusWarning
                    : c.foregroundMuted,
                  fontSize: 12,
                }}
              >
                {hook.error || hook.summary}
              </Text>
            )}
          </View>
        ))}
      </DetailSection>
    )}
    {task.reviewEntry && (
      <DetailSection title="Review entry" c={c}>
        <Text selectable style={muted(c)}>
          External PR #{task.reviewEntry.prNumber} · head{" "}
          {task.reviewEntry.verifiedHead} · base{" "}
          {task.reviewEntry.verifiedBase}
        </Text>
        <Text selectable style={muted(c)}>
          Declared authors:{" "}
          {task.reviewEntry.authorDeclaration.models.join(", ")}{" "}
          · GitHub{" "}
          {task.reviewEntry.authorDeclaration.githubAuthor} ·{" "}
          {task.reviewEntry.authorDeclaration.authoringSystem}
        </Text>
        <Text selectable style={muted(c)}>
          Attested by{" "}
          {task.reviewEntry.authorDeclaration.attestedBy} ·{" "}
          {task.reviewEntry.authorDeclaration.provenance}
        </Text>
        <Text style={muted(c)}>
          {task.reviewEntry.preserveWorkspace
            ? "External workspace is preserved for operator cleanup."
            : "Intake-created workspace is archived after successful closeout; cancellation preserves it."}
        </Text>
      </DetailSection>
    )}
    <DetailSection c={c}>
      {task.heavyRun && <HeavyRunStatus run={task.heavyRun} c={c} detail />}
      {task.budget && (
        <Text
          accessibilityLabel={`Budget: ${budgetSummary(task.budget)}${task.budget.exhausted ? `; reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}` : ""}`}
          style={{
            color: task.budget.exhausted ? c.statusWarning : c.foregroundMuted,
            fontSize: 12,
            lineHeight: 17,
          }}
        >
          Budget · {budgetSummary(task.budget)}
          {task.budget.exhausted ? ` · reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}` : ""}
        </Text>
      )}
      {(task.originError || task.originLookupError) && (
        <Text style={{ color: c.statusWarning, fontSize: 12 }}>
          Origin routing:{" "}
          {task.originError || task.originLookupError}
        </Text>
      )}
      {stalledIncident && (
        <DetailSection title="Stalled turn" c={c}>
          <Text
            selectable
            style={{ ...muted(c), fontSize: 12 }}
          >
            Run {stalledIncident.runId} · detected turn{" "}
            {stalledIncident.turnId ?? "unknown"}
            {stalledTurnStop
              ? ` · stop ${stalledTurnStop.status} for turn ${stalledTurnStop.turnId}`
              : " · the run still owns its task"}
          </Text>
          {stalledTurnStop && (
            <Text
              selectable
              style={{ ...muted(c), fontSize: 12 }}
            >
              {stalledTurnStop.detail ||
                (stalledTurnStop.status === "sent"
                  ? "Waiting for Nucleus to observe inactivity; the run lease stays held and no replacement starts automatically."
                  : "")}
            </Text>
          )}
          <Text style={{ ...muted(c), fontSize: 12 }}>
            Use restart in Next to stop the exact turn and
            continue the run; Nucleus waits for observed
            inactivity first.
          </Text>
        </DetailSection>
      )}
      {(() => {
        const fences = holdsOf(task);
        return (
          <>
            {fences.dispatch && (
              <Text
                accessibilityLabel="Dispatch hold owner and reason"
                style={{ ...muted(c), fontSize: 12 }}
              >
                Dispatch held by{" "}
                {api.holdOwnerOf(task, fences.dispatch.owner)} ·{" "}
                {fences.dispatch.reason} ·{" "}
                {fences.dispatch.at
                  ? decisionAge(fences.dispatch.at)
                  : "age not recorded"}
              </Text>
            )}
            {fences.merge && (
              <Text
                accessibilityLabel="Merge hold owner and reason"
                style={{ ...muted(c), fontSize: 12 }}
              >
                Merge held by{" "}
                {api.holdOwnerOf(task, fences.merge.owner)} ·{" "}
                {fences.merge.reason} ·{" "}
                {fences.merge.at
                  ? decisionAge(fences.merge.at)
                  : "age not recorded"}
              </Text>
            )}
          </>
        );
      })()}
      {task.phase === "queued" && !holdsOf(task).dispatch && (
        <Field
          c={c}
          label="Hold reason (required to hold)"
          value={holdReason}
          onChange={setHoldReason}
        />
      )}
      <OperationState operations={taskOperations} c={c} />
      <View style={row}>
        {task.agentId && navigation?.openAgent && (
          <Button
            small
            c={c}
            text="Open worker"
            onPress={() =>
              navigation.openAgent({ agentId: task.agentId! })
            }
          />
        )}
        {task.workspaceId && navigation?.openWorkspace && (
          <Button
            small
            c={c}
            text="Open workspace"
            onPress={() =>
              navigation.openWorkspace({
                workspaceId: task.workspaceId!,
              })
            }
          />
        )}
        {!task.removedAt &&
          [
            "queued",
            "blocked",
            "error",
            "needs_attention",
            "cancelled",
            "done",
          ].includes(task.phase) && (
            <ActionButton
              c={c}
              action="remove"
              label="Remove task from queue"
              disabled={busy || pendingOperation}
              onPress={() =>
                void act(async () => {
                  const result = await removeTask({
                    taskId: task.id,
                    version: task.version,
                  });
                  // A slow removal returns its accepted operation instead of the task: keep the detail open so the
                  // pending removal stays visible in the operation state above. Only a settled removed task closes it.
                  if ("accepted" in result) return;
                  // Saturation accepts nothing: surface the reason and retry delay instead of silently keeping the
                  // task, so the operator knows to retry once the queue drains. The detail stays open.
                  if ("backpressured" in result)
                    throw new Error(
                      `Removal backpressured, nothing was removed: ${result.reason} Retry in about ${Math.max(1, Math.round(result.retryAfterMs / 1000))}s.`,
                    );
                  if (result.removedAt) onClose();
                })
              }
            />
          )}
        {holdsOf(task).merge &&
          task.phase !== "queued" &&
          [
            "working",
            "awaiting_review",
            "reviewing",
            "changes_requested",
            "verifying",
            "merging",
          ].includes(task.phase) &&
          !task.resolution.mergeIntent && (
            <Button
              small
              c={c}
              disabled={busy}
              text="Release hold"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "release",
                    kind: "merge",
                  }),
                )
              }
            />
          )}
        {task.phase === "queued" && (
          <>
            <ActionButton
              c={c}
              action={holdsOf(task).dispatch ? "resume" : "pause"}
              disabled={
                busy ||
                (Boolean(holdsOf(task).dispatch)
                  ? false
                  : !holdReason.trim())
              }
              label={
                holdsOf(task).dispatch
                  ? "Release task"
                  : "Hold task"
              }
              tip={holdsOf(task).dispatch || holdReason.trim() ? undefined : "Hold task: give a hold reason first"}
              onPress={() =>
                void act(async () => {
                  const dispatch = holdsOf(task).dispatch;
                  await setTask(
                    dispatch
                      ? {
                          taskId: task.id,
                          version: task.version,
                          action: "release",
                          kind: "dispatch",
                        }
                      : {
                          taskId: task.id,
                          version: task.version,
                          action: "hold",
                          kind: "dispatch",
                          reason: holdReason.trim(),
                        },
                  );
                  setHoldReason("");
                })
              }
            />
            {holdsOf(task).merge && (
              <Button
                small
                c={c}
                disabled={busy}
                text="Release merge hold"
                onPress={() =>
                  void act(() =>
                    setTask({
                      taskId: task.id,
                      version: task.version,
                      action: "release",
                      kind: "merge",
                    }),
                  )
                }
              />
            )}
            <Button
              small
              c={c}
              disabled={busy}
              icon="ArrowUpToLine"
              text="Promote in project"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "promote",
                  }),
                )
              }
            />
            <Button
              small
              c={c}
              disabled={busy}
              text="Cancel task"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "cancel",
                  }),
                )
              }
            />
          </>
        )}
      </View>
    </DetailSection>
    {canChangeRouting && (
      <DetailSection title="Routing" c={c}>
        <Text style={muted(c)}>
          Current: {task.scope} ·{" "}
          {task.complexity
            ? `complexity ${task.complexity} · `
            : "complexity unset · "}
          {task.preferredProfileId || "automatic"}
          {task.requirePreferred ? " required" : ""} · thinking{" "}
          {workerThinking(task) || "default"}
        </Text>
        <Button
          small
          c={c}
          text="Change routing"
          onPress={() => {
            setRoutingScope(task.scope);
            setRoutingComplexity(task.complexity ?? null);
            setRoutingPreferred(task.preferredProfileId);
            setRoutingRequired(task.requirePreferred);
            setRoutingThinking(workerThinking(task));
            setRoutingRequests({
              worker: (({
                thinkingOptionId: _level,
                ...request
              }) => request)(
                task.profileRequests?.worker ?? {
                  profileId: "",
                  reason: "",
                  required: false,
                },
              ),
              reviewer: task.profileRequests?.reviewer ?? {
                profileId: "",
                reason: "",
                required: false,
              },
              coordinator: task.profileRequests
                ?.coordinator ?? {
                profileId: "",
                reason: "",
                required: false,
              },
            });
            setRoutingReason("");
            setRoutingOpen(!routingOpen);
          }}
        />
        {routingOpen && (
          <View style={{ gap: 8 }}>
            <View style={row}>
              <Text style={muted(c)}>Scope</Text>
              {(
                ["general", "mechanical", "complex"] as const
              ).map((scope) => (
                <Button
                  key={scope}
                  small
                  c={c}
                  text={scope}
                  selected={routingScope === scope}
                  onPress={() => setRoutingScope(scope)}
                />
              ))}
            </View>
            <View style={row}>
              <Text style={muted(c)}>Complexity</Text>
              <Button
                key="unset"
                small
                c={c}
                text="unset"
                selected={routingComplexity === null}
                onPress={() => setRoutingComplexity(null)}
              />
              {(
                [
                  "very_low",
                  "low",
                  "medium",
                  "high",
                  "very_high",
                ] as const
              ).map((complexity) => (
                <Button
                  key={complexity}
                  small
                  c={c}
                  text={complexity.replaceAll("_", " ")}
                  selected={routingComplexity === complexity}
                  onPress={() =>
                    setRoutingComplexity(complexity)
                  }
                />
              ))}
            </View>
            <Text style={muted(c)}>
              Complexity only steers future selection: profiles
              whose rated capability sits close to it are
              preferred, never guaranteed, and running or review
              assignments are untouched.
            </Text>
            <Text style={muted(c)}>
              Worker profiles for {routingScope}
              {routingProfiles.length
                ? ""
                : " · none currently eligible"}
            </Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Automatic"
                selected={!routingPreferred}
                onPress={() => setRoutingPreferred("")}
              />
              {routingProfiles.map(({ entry, profile }) => (
                <Button
                  key={entry.profileId}
                  small
                  wrap
                  c={c}
                  text={`${profile!.name}${choiceTag(entry, state?.usage ?? NORMAL_USAGE, state?.availability ?? [])}`}
                  selected={
                    routingPreferred === entry.profileId
                  }
                  onPress={() =>
                    setRoutingPreferred(entry.profileId)
                  }
                />
              ))}
            </View>
            <SelectedProfilePolicy
              entry={
                routingProfiles.find(
                  (item) =>
                    item.entry.profileId === routingPreferred,
                )?.entry
              }
              usage={state?.usage ?? NORMAL_USAGE}
              availability={state?.availability ?? []}
              explicit={(required) =>
                required
                  ? "A preference alone does not select this profile; add a worker request with a reason. "
                  : ""
              }
              c={c}
            />
            <Button
              small
              c={c}
              text={
                routingRequired
                  ? "Preferred required"
                  : "Preferred optional"
              }
              selected={routingRequired}
              onPress={() =>
                setRoutingRequired(!routingRequired)
              }
            />
            <Field
              c={c}
              label="Thinking option ID (blank uses profile default)"
              value={routingThinking}
              onChange={setRoutingThinking}
            />
            {(
              ["worker", "reviewer", "coordinator"] as const
            ).map((role) => (
              <View key={role} style={{ gap: 5 }}>
                <Field
                  c={c}
                  label={`${role} request profile ID (blank clears)`}
                  value={routingRequests[role].profileId}
                  onChange={(profileId) =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        profileId,
                      },
                    })
                  }
                />
                <Field
                  c={c}
                  label={`${role} request reason`}
                  value={routingRequests[role].reason}
                  onChange={(reason) =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        reason,
                      },
                    })
                  }
                />
                <Button
                  small
                  c={c}
                  text={`${role} request ${routingRequests[role].required ? "required" : "optional"}`}
                  selected={routingRequests[role].required}
                  onPress={() =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        required:
                          !routingRequests[role].required,
                      },
                    })
                  }
                />
              </View>
            ))}
            <Field
              c={c}
              label="Reason (required)"
              value={routingReason}
              onChange={setRoutingReason}
            />
            <Button
              small
              c={c}
              text="Save routing"
              disabled={busy || !routingReason.trim()}
              onPress={() =>
                void act(async () => {
                  await setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "set_routing",
                    reason: routingReason.trim(),
                    scope: routingScope,
                    complexity: routingComplexity,
                    preferredProfileId: routingPreferred,
                    requirePreferred: routingRequired,
                    thinkingOptionId: routingThinking,
                    profileRequests: Object.fromEntries(
                      (
                        [
                          "worker",
                          "reviewer",
                          "coordinator",
                        ] as const
                      ).map((role) => [
                        role,
                        routingRequests[role].profileId
                          ? {
                              ...routingRequests[role],
                              reason:
                                routingRequests[
                                  role
                                ].reason.trim(),
                            }
                          : null,
                      ]),
                    ),
                  });
                  setRoutingOpen(false);
                })
              }
            />
          </View>
        )}
      </DetailSection>
    )}
    {detailQuery.data?.telemetry && (
      <CompactTelemetrySummary
        telemetry={detailQuery.data.telemetry}
        c={c}
      />
    )}
    {task.resolution.projectValidation && (
      <ProjectValidationSection task={task} c={c} />
    )}
    {taskQaRun && (
      <DetailSection title="Milestone QA" c={c}>
        <Text style={{ color: c.foreground, fontSize: 12 }}>
          {taskQaRun.state}
          {taskQaRun.exitCode !== null
            ? ` · exit ${taskQaRun.exitCode}`
            : ""}
          {taskQaRun.durationMs
            ? ` · ran ${formatTelemetryDuration(taskQaRun.durationMs)}`
            : ""}
          {taskQaRun.failedStep
            ? ` · ${taskQaRun.failedStep} failed`
            : ""}
          {taskQaRun.capacityUnavailable
            ? " · QA capacity unavailable"
            : taskQaRun.capacityWait
              ? " · waiting for QA capacity"
              : ""}
        </Text>
        <Text style={{ ...muted(c), fontSize: 12 }}>
          Base {taskQaRun.base.slice(0, 12)} ·{" "}
          {taskQaRun.stages && taskQaRun.stages.length > 1
            ? taskQaRun.stages
                .map((stage) => stage.name)
                .join(" → ")
            : taskQaRun.argv.join(" ")}{" "}
          · started {taskQaRun.startedAt.slice(0, 10)}
        </Text>
        <ProjectQaSteps
          run={taskQaRun}
          c={c}
          label={`QA steps for ${task.repoPath}`}
        />
        <ProjectQaLogWriteErrors
          run={taskQaRun}
          c={c}
          label={`QA log-write errors for ${task.repoPath}`}
        />
        <ProjectQaFailures
          run={taskQaRun}
          c={c}
          label={`QA failures for ${task.repoPath}`}
        />
        {Boolean(taskQaRun.outputTail) && (
          <Text
            selectable
            accessibilityLabel="Milestone QA output tail"
            style={{ ...muted(c), fontSize: 11 }}
          >
            {taskQaRun.outputTail}
          </Text>
        )}
      </DetailSection>
    )}
    {task.disposition && (
      <DetailSection
        title={
          task.disposition.status === "complete"
            ? task.disposition.kind === "supersede"
              ? "Superseded"
              : "Cancelled"
            : "Cancelling"
        }
        c={c}
      >
        <Text style={{ color: c.foreground, fontSize: 13 }}>
          {task.disposition.reason}
        </Text>
        <Text style={{ ...muted(c), fontSize: 12 }}>
          Requested by {task.disposition.requestedBy} ·{" "}
          {task.disposition.kind} · {task.disposition.status}
          {task.disposition.completedAt
            ? ` · completed ${task.disposition.completedAt}`
            : ""}
        </Text>
        {task.disposition.replacementTaskId && (
          <Text style={{ ...muted(c), fontSize: 12 }}>
            Replacement: {task.disposition.replacementTaskId}
            {task.disposition.replacementBranch
              ? ` · branch ${task.disposition.replacementBranch}`
              : ""}
          </Text>
        )}
        <Text style={{ ...muted(c), fontSize: 12 }}>
          Work:{" "}
          {task.disposition.workDisposition.replaceAll(
            "_",
            " ",
          )}{" "}
          ·{" "}
          {task.disposition.workspaceArchived
            ? `workspace ${task.disposition.workspaceId} archived`
            : task.disposition.workspaceEvidence ||
              "preservation pending"}
        </Text>
        {task.disposition.attention && (
          <Text
            style={{ color: c.statusWarning, fontSize: 12 }}
          >
            {task.disposition.attention}
          </Text>
        )}
        {task.disposition.status === "draining" && (
          <Text style={{ ...muted(c), fontSize: 12 }}>
            The worker turn was interrupted and is still
            stopping.
          </Text>
        )}
        {task.disposition.postDispositionRefs.length > 0 && (
          <Text
            style={{ color: c.statusWarning, fontSize: 12 }}
          >
            Refs pushed after disposition:{" "}
            {task.disposition.postDispositionRefs
              .map(
                (item) =>
                  `${item.ref} ${item.sha.slice(0, 12)}`,
              )
              .join("; ")}
          </Text>
        )}
        {task.disposition.effects.length > 0 && (
          <Text style={{ ...muted(c), fontSize: 12 }}>
            {
              task.disposition.effects.filter(
                (effect) => effect.result,
              ).length
            }
            /{task.disposition.effects.length} recorded effects
            reconciled
          </Text>
        )}
        {canWithdrawCancellation && (
          <View style={{ gap: 6, marginTop: 4 }}>
            <Text style={{ ...muted(c), fontSize: 12 }}>
              You can withdraw this cancellation while
              thread-stop requests are pending, or while its
              disposition is parked in needs attention.
            </Text>
            <Field
              c={c}
              label="Withdrawal reason (required)"
              value={withdrawReason}
              onChange={setWithdrawReason}
              placeholder="Why this cancellation is withdrawn"
            />
            <Button
              small
              c={c}
              text="Withdraw cancellation"
              disabled={
                busy ||
                pendingOperation ||
                !withdrawReason.trim()
              }
              onPress={() =>
                void act(async () => {
                  await setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "withdraw_cancel",
                    reason: withdrawReason.trim(),
                  });
                  setWithdrawReason("");
                })
              }
            />
          </View>
        )}
      </DetailSection>
    )}
    {!task.removedAt &&
      !task.disposition &&
      !["queued", "cancelled", "done"].includes(task.phase) && (
        <DetailSection title="Cancel or supersede" c={c}>
          <Text style={{ ...muted(c), fontSize: 12 }}>
            One versioned operator action. The fence persists
            before any stop or archive request; ordinary
            recovery and relaunch stop while it is active. Only
            done satisfies dependants.
          </Text>
          <Field
            c={c}
            label="Operator reason (required)"
            value={disposeReason}
            onChange={setDisposeReason}
            placeholder="Why this work ends unfinished"
          />
          <View style={row}>
            {(
              [
                "preserve",
                "archive_if_empty",
                "retained_by_replacement",
              ] as const
            ).map((option) => (
              <Button
                key={option}
                small
                c={c}
                text={option.replaceAll("_", " ")}
                selected={workDisposition === option}
                disabled={busy}
                onPress={() => setWorkDisposition(option)}
              />
            ))}
          </View>
          <Field
            c={c}
            label="Replacement task ID (supersede only)"
            value={replacementId}
            onChange={setReplacementId}
            placeholder="Existing task ID in the same repository"
          />
          <View style={row}>
            <Button
              small
              c={c}
              text="Cancel task"
              disabled={
                busy ||
                pendingOperation ||
                !disposeReason.trim()
              }
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "cancel",
                    reason: disposeReason.trim(),
                    workDisposition,
                  }),
                )
              }
            />
            <Button
              small
              c={c}
              text="Supersede task"
              disabled={
                busy ||
                pendingOperation ||
                !disposeReason.trim() ||
                !replacementId.trim()
              }
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "supersede",
                    reason: disposeReason.trim(),
                    replacementTaskId: replacementId.trim(),
                    workDisposition,
                  }),
                )
              }
            />
          </View>
        </DetailSection>
      )}
    {escalatedEpisode && task && (
      <DetailSection title="Answered escalation" c={c}>
        <Text style={{ ...muted(c), fontSize: 12 }}>
          Any owner verb in Next answers the escalation with its
          reason. When nothing else applies, an owner restart
          with the answer as its reason closes it: the escalated
          recovery and incident resolve, and the escalation
          event stays as evidence. Available once no run is
          unreleased and the escalation is not backed by live
          work.
        </Text>
        <Field
          c={c}
          label="Owner reason (required)"
          value={escalationAnswer}
          onChange={setEscalationAnswer}
          placeholder="Who answered the escalation, and why"
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Answer with restart"
            disabled={
              busy ||
              pendingOperation ||
              !escalationAnswer.trim()
            }
            onPress={() =>
              void act(async () => {
                await setTask({
                  taskId: task.id,
                  version: task.version,
                  action: "restart",
                  reason: escalationAnswer.trim(),
                });
                setEscalationAnswer("");
              })
            }
          />
        </View>
      </DetailSection>
    )}
  </View>;
}
