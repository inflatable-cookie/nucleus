import { Text, View } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import { DetailSection, muted, row, type Colors } from "../controls";
import type { TaskNext, UiQueueState } from "../../shared/contracts";
import { taskIdentityFields, RawRecords, DetailField } from "./parts";
import { VerbReference, RoutingPolicyLines } from "./next-section";
import type { TaskDetailRead } from "./task-dialog";

export function TechnicalIdentity({ task, detailQuery, nextQuery, state, compact, c }: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  nextQuery: UseQueryResult<TaskNext>;
  state: UiQueueState | undefined;
  compact: boolean;
  c: Colors;
}) {
  const taskSummaryStop = state?.tasks.find(item => item.id === task.id)?.stopRecord;
  return <>
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
  </>;
}
