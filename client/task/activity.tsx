import { useState } from "react";
import { Text, View } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { Button, Field, muted, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import {
  buildActivityTimeline,
  formatActivityTime,
} from "../../shared/task-detail-view";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import { CollapsibleSection, EventRow, type BoardAct } from "./parts";
import { detailToneColor } from "./task-header";
import type { TaskDetailRead } from "./task-dialog";
import { radius, roles, space, taskDetail, type as typeScale } from "../design";

/**
 * The redesigned Activity tab (nucleus#1537):
 * - Readable vertical timeline built from task events with messages & escalations folded in
 * - Consecutive repeated events grouped with a repeat count
 * - Bookkeeping events hidden behind "Show raw events (N)", which lists every event as today
 * - Coordination note input preserved at the bottom.
 */
export function ActivityTab({
  task,
  drafts,
  detailQuery,
  busy,
  act,
  c,
}: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  busy: boolean;
  act: BoardAct;
  drafts: TaskDrafts;
  c: Colors;
}) {
  const r = roles(c);
  const setTask = useRpc(api.taskControl);
  const [coordinationNote, setCoordinationNote] = useTaskDraft(
    drafts,
    "coordinationNote",
    "",
  );
  const [rawOpen, setRawOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const events = detailQuery.data?.events ?? [];
  const messages = detailQuery.data?.messages ?? [];
  const { items, rawCount } = buildActivityTimeline({
    events,
    messages,
    taskId: task.id,
  });

  return (
    <View style={{ gap: space.md }}>
      {items.length === 0 ? (
        <Text style={muted(c)}>
          {rawCount > 0
            ? "No human-readable activity in this window. Raw events are available below."
            : "No activity recorded for this task yet. Messages between tasks appear here; they carry information only and never change a task."}
        </Text>
      ) : (
        <View
          accessibilityLabel="Activity timeline"
          style={{
            position: "relative",
            paddingLeft: space.md,
          }}
        >
          {/* Vertical timeline rail */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: space.xxs,
              top: space.xs,
              bottom: space.xs,
              width: taskDetail.timelineLine,
              backgroundColor: r.border,
            }}
          />
          {items.map((item) => {
            const dotColor = detailToneColor(item.tone, c);
            return (
              <View
                key={item.id}
                accessibilityLabel={`${item.title}${item.count > 1 ? ` (${item.count} times)` : ""}${item.detail ? `: ${item.detail}` : ""}`}
                style={{
                  position: "relative",
                  paddingVertical: space.xs,
                  gap: space.xxs / 2,
                }}
              >
                <View
                  style={{
                    position: "absolute",
                    left: -(space.md - space.xxs / 2),
                    top: space.sm,
                    width: taskDetail.timelineDot,
                    height: taskDetail.timelineDot,
                    borderRadius: radius.full,
                    backgroundColor: dotColor,
                    borderWidth: 2,
                    borderColor: r.canvas,
                  }}
                />
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: space.sm,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.xs,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <Text
                      style={{
                        color: r.foreground,
                        fontSize: typeScale.body.fontSize,
                        lineHeight: typeScale.body.lineHeight,
                        fontWeight: "600",
                        flexShrink: 1,
                      }}
                    >
                      {item.title}
                    </Text>
                    {item.count > 1 && (
                      <View
                        style={{
                          paddingHorizontal: space.xs,
                          borderRadius: radius.control,
                          backgroundColor: r.raised,
                        }}
                      >
                        <Text
                          style={{
                            color: r.muted,
                            fontSize: typeScale.metadata.fontSize,
                          }}
                        >
                          ×{item.count}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text
                    style={{
                      color: r.muted,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                      flexShrink: 0,
                    }}
                  >
                    {formatActivityTime(item.at)}
                  </Text>
                </View>
                {Boolean(item.detail) && (
                  <Text
                    selectable
                    style={{
                      color: r.muted,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                    }}
                  >
                    {item.detail}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      {rawCount > 0 && (
        <CollapsibleSection
          title={`Show raw events (${rawCount})`}
          hint="Every recorded event"
          open={rawOpen}
          onToggle={() => setRawOpen((v) => !v)}
          c={c}
        >
          {rawCount >= 100 && (
            <Text
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Showing the newest 100 events, newest first.
            </Text>
          )}
          {events.map((ev) => (
            <EventRow key={ev.id} event={ev} c={c} />
          ))}
        </CollapsibleSection>
      )}

      <CollapsibleSection
        title="Add a coordination note"
        open={noteOpen}
        onToggle={() => setNoteOpen((v) => !v)}
        c={c}
      >
        <Field
          c={c}
          label="Coordination note"
          value={coordinationNote}
          onChange={setCoordinationNote}
          multiline
        />
        <Button
          small
          c={c}
          text="Add note"
          disabled={busy || !coordinationNote.trim()}
          onPress={() =>
            void act(async () => {
              await setTask({
                taskId: task.id,
                version: task.version,
                action: "note",
                message: coordinationNote.trim(),
              });
              setCoordinationNote("");
            })
          }
        />
      </CollapsibleSection>
    </View>
  );
}
