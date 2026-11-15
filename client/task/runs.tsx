import { Text, View } from "react-native";
import { type UseQueryResult } from "@tanstack/react-query";
import { DetailSection, muted, TextLink, type Colors } from "../controls";
import { checkpointStateLabel } from "../../shared/task-state";
import { buildOutputDisclosure } from "../../shared/build-output-disclosure";
import { phaseLabel } from "../board/text";
import { RawRecords, RunRow, type BoardAct } from "./parts";
import { RunsCoordination } from "./runs-coordination";
import { RunsCloseout } from "./runs-closeout";
import { buildOutputCleanupSubject, taskRunPartition } from "./runs-view";
import type { TaskDrafts } from "./drafts";
import type { TaskDetailRead } from "./task-dialog";
import type { BoardNavigation } from "../shell/types";
import { space, type as typeScale } from "../design";

/**
 * The Runs tab: prerequisites, the runs and their delivery, the worker
 * exclusions and the closeout facts, one component per section so each reads
 * as the one owner of what it shows.
 */
export function RunsTab({ task, drafts, detailQuery, pendingOperation, busy, act, navigation, onSelectTask, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; pendingOperation: boolean; busy: boolean; act: BoardAct; drafts: TaskDrafts; navigation?: BoardNavigation; onSelectTask: (id: string) => void; c: Colors }) {
  return <View style={{ gap: space.sm }}>
    <RunsPrerequisites task={task} detailQuery={detailQuery} onSelectTask={onSelectTask} c={c} />
    <RunsCoordination task={task} drafts={drafts} detailQuery={detailQuery} pendingOperation={pendingOperation} busy={busy} act={act} navigation={navigation} c={c} />
    <RunsAndDelivery task={task} detailQuery={detailQuery} navigation={navigation} c={c} />
    <RunsCloseout task={task} detailQuery={detailQuery} c={c} />
  </View>;
}

/** What this task waits on, then the run-bound build output record that sits beside it (Queue #395). */
function RunsPrerequisites({ task, detailQuery, onSelectTask, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; onSelectTask: (id: string) => void; c: Colors }) {
  // Queue #395: the task detail quotes the recorded run-bound build output
  // cleanup before anyone reuses artifacts. Terminal tasks settle their
  // workspace cleanup, so they read the records without a missing-run line.
  const runBoundCleanup = buildOutputDisclosure(task.resolution.buildOutputCleanups, buildOutputCleanupSubject(task));
  return <>
    {Boolean(detailQuery.data?.dependencies.length) && (
      <DetailSection title="Prerequisites" c={c}>
        {detailQuery.data?.dependencies.map((dependency) => (
          <TextLink
            key={dependency.id}
            c={c}
            text={`${dependency.title} · ${dependency.phase === "done" ? "complete" : dependency.removedAt ? "removed before completion" : phaseLabel(dependency)}${dependency.purgedAt ? " · history purged" : ""}`}
            onPress={() => {
              if (!dependency.purgedAt)
                onSelectTask(dependency.id);
            }}
          />
        ))}
      </DetailSection>
    )}
    {runBoundCleanup && (
      <DetailSection title="Run-bound build output" c={c}>
        <Text
          selectable
          accessibilityLabel="Run-bound build output cleanup"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          {runBoundCleanup.text}
        </Text>
      </DetailSection>
    )}
  </>;
}

/** The runs and what each delivered, with the released history behind one disclosure. */
function RunsAndDelivery({ task, detailQuery, navigation, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; navigation?: BoardNavigation; c: Colors }) {
  const runs = detailQuery.data?.runs ?? [];
  const { live, earlier } = taskRunPartition(runs);
  return <DetailSection title="Runs and delivery" c={c}>
      {Boolean(
        task.checkpoints.records.length ||
          task.checkpoints.intent,
      ) && (
        <Text
          selectable
          accessibilityLabel={checkpointStateLabel(
            task.checkpoints,
          )}
          style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
        >
          {checkpointStateLabel(task.checkpoints)}
        </Text>
      )}
      {detailQuery.data?.missingResult && (
        <Text
          selectable
          accessibilityLabel={`Missing result for ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}`}
          style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}
        >{`Missing result · ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}${detailQuery.data.missingResult.prUrl ? ` · ${detailQuery.data.missingResult.prUrl}` : ""}`}</Text>
      )}
      {detailQuery.data?.runs.length ? (
        <>
          {live.map((r) => (
            <RunRow key={r.id} run={r} c={c} openThread={r.agentId && navigation?.openAgent ? () => navigation?.openAgent?.({ agentId: r.agentId! }) : undefined} />
          ))}
          {!live.length && <Text style={muted(c)}>No run is live. Earlier runs are below.</Text>}
          {Boolean(earlier.length) && (
            <RawRecords label={`Earlier runs (${earlier.length}${runs.length >= 200 ? ", of the latest 200 runs" : ""})`} c={c}>
              {earlier.map((r) => (
                <RunRow key={r.id} run={r} c={c} openThread={r.agentId && navigation?.openAgent ? () => navigation?.openAgent?.({ agentId: r.agentId! }) : undefined} />
              ))}
            </RawRecords>
          )}
        </>
      ) : (
        <Text style={muted(c)}>No runs yet</Text>
      )}
    </DetailSection>;
}
