import { useTaskDraft, type TaskDrafts } from "./drafts";
import { Text, View } from "react-native";
import { type UseQueryResult } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { Button, DetailSection, Field, muted, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { lowValueActivityKinds, EventRow, TechnicalActivityEvents, MessageRow, type BoardAct } from "./parts";
import type { TaskDetailRead } from "./task-dialog";

/** The Messages tab: messages between this task and related workers or reviewers. */
export function MessagesTab({ task, detailQuery, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; c: Colors }) {
  return <View style={{ gap: 12 }}>
    <DetailSection c={c}>
      {(detailQuery.data?.messages.length ?? 0) >= 50 && <Text style={muted(c)}>Showing the newest 50 messages, newest first.</Text>}
      {(detailQuery.data?.messages ?? []).length === 0 && (
        <Text style={{...muted(c), fontSize: 12}}>No messages yet. Messages between this task and related workers or reviewers appear here. They carry information only and never change a task.</Text>
      )}
      {detailQuery.data?.messages.map((message) => (
        <MessageRow key={message.id} message={message} taskId={task.id} c={c} />
      ))}
    </DetailSection>
  </View>;
}

/** The Activity tab: recorded events and the coordination note, whose draft it owns. */
export function ActivityTab({ task, drafts, detailQuery, busy, act, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; busy: boolean; act: BoardAct; drafts: TaskDrafts; c: Colors }) {
  const setTask = useRpc(api.taskControl);
  const [coordinationNote, setCoordinationNote] = useTaskDraft(drafts, "coordinationNote", "");
  return <View style={{ gap: 12 }}>
    <DetailSection title="Recorded events" c={c}>
      {detailQuery.data?.events.length === 0 && <Text style={muted(c)}>No events recorded for this task yet.</Text>}
      {Boolean(detailQuery.data?.events.length) && (detailQuery.data?.events ?? []).every(event => lowValueActivityKinds.has(event.kind) || event.kind.endsWith("_duration")) && <Text style={muted(c)}>No human events in this window. Technical records are available below.</Text>}
      {(detailQuery.data?.events.length ?? 0) >= 100 && <Text style={muted(c)}>Showing the newest 100 events, newest first.</Text>}
      {(detailQuery.data?.events ?? []).filter(event => !lowValueActivityKinds.has(event.kind) && !event.kind.endsWith("_duration")).map((e) => (
        <EventRow key={e.id} event={e} c={c} />
      ))}
      <TechnicalActivityEvents events={(detailQuery.data?.events ?? []).filter(event => lowValueActivityKinds.has(event.kind) || event.kind.endsWith("_duration"))} c={c} />
    </DetailSection>
    <DetailSection title="Add a coordination note" c={c}>
      <Field c={c} label="Coordination note" value={coordinationNote} onChange={setCoordinationNote} multiline />
      <Button small c={c} text="Add note" disabled={busy || !coordinationNote.trim()} onPress={() => void act(async () => {
        await setTask({ taskId: task.id, version: task.version, action: "note", message: coordinationNote.trim() });
        setCoordinationNote("");
      })} />
    </DetailSection>
  </View>;
}
