import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { BoardSurfaceProps } from "../shell/types";
import { useBoardState } from "../board-state";
import { useBoardAct, useTaskDetail } from "../board/use-board-data";
import { useTaskDraftStore } from "./drafts";
import { TaskDialog } from "./task-dialog";
import { PopoverHost } from "../popover";
import { Button, muted } from "../controls";
import { readErrorText } from "../error-text";
import { projectHasRepository } from "../../shared/project-scope";
import { roles, space } from "../design";
import type { RecordNoticeValue } from "./parts";

/**
 * One task's detail, filling a host panel tab (Spec 062, decision 5d: the `Task`
 * tab on a task's role threads). It is the board's own task detail — the same
 * reads, the same controls and the same `TaskDialog` body, rendered in place
 * instead of over the board — so a role thread shows exactly what the board shows.
 * A prerequisite link opens that task here, as it does on the board, and Back
 * returns to the thread's own task.
 */
export function TaskDetailPanel({ theme, layout, navigation, taskId }: BoardSurfaceProps & { taskId: string }) {
  const c = theme.colors;
  const [shownId, setShownId] = useState(taskId);
  useEffect(() => { setShownId(taskId); }, [taskId]);
  const { state } = useBoardState();
  const { detailQuery, nextQuery } = useTaskDetail(shownId);
  const [, setRecordNotice] = useState<RecordNoticeValue | null>(null);
  const { act, busy, error, setError } = useBoardAct({ selected: shownId, selectedLeadId: null, openPapercutId: null, openDecisionId: null, setRecordNotice });
  const drafts = useTaskDraftStore(`${shownId}|panel`);
  const task = detailQuery.data?.task;
  const project = task ? state?.projects.find(candidate => projectHasRepository(candidate, task.repoPath, task.repository)) : undefined;
  if (!task) return <View accessibilityLabel="Task detail" style={{ flex: 1, padding: space.md, backgroundColor: roles(c).canvas }}>
    <Text style={muted(c)}>{detailQuery.error ? readErrorText("Task detail", detailQuery.error) : "Loading task…"}</Text>
  </View>;
  return <PopoverHost>
    <View style={{ flex: 1, minHeight: 0, backgroundColor: roles(c).canvas }}>
      {shownId !== taskId && <View style={{ padding: space.xs }}>
        <Button small c={c} text="Back" label="Back to this thread's task" onPress={() => setShownId(taskId)} />
      </View>}
      {error !== "" && <Text accessibilityRole="alert" onPress={() => setError("")} style={{ color: roles(c).danger, padding: space.sm }}>{error}</Text>}
      <TaskDialog inline task={task} detailQuery={detailQuery} nextQuery={nextQuery} state={state} decisions={undefined}
        spansRepositories={(project?.repositories.length ?? 1) > 1} compact={layout.compact} busy={busy} act={act} drafts={drafts}
        navigation={navigation} onClose={() => {}} onSelectTask={setShownId} c={c} />
    </View>
  </PopoverHost>;
}
