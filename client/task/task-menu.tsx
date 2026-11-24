import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "../shell";
import {
  Button,
  DetailSection,
  Field,
  muted,
  popover as popoverChrome,
  row,
  type Colors,
} from "../controls";
import { Popover } from "../popover";
import * as api from "../../shared/contracts";
import {
  holdsOf,
  OPERATOR_BOARD_CALLER,
  type TaskNext,
  type TaskNextVerb,
  type UiQueueState,
} from "../../shared/contracts";
import { isTerminalPhase } from "../../shared/task-state";
import { TechnicalRouting } from "./technical-routing";
import { TechnicalDisposition } from "./technical-disposition";
import { DependencyListEditor } from "./dependencies";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import { verbKey, verbText } from "./next-section";
import { RecordNotice } from "./parts";
import { VerbForm, type VerbNotice } from "./verb-form";
import type { BoardAct } from "./parts";
import type { TaskDetailRead } from "./task-dialog";
import type { BoardNavigation } from "../shell/types";
import {
  hoverSurface,
  radius,
  roles,
  space,
  touchTarget,
  type as typeScale,
} from "../design";

/**
 * Every editing action lives in the header's ⋯ menu (Tom: "Live in the menu"):
 * amend brief, holds and releases, promote, routing and profile changes,
 * worker exclusion, set dependencies, budget extension, cancel/supersede,
 * open workspace and remove from queue.
 */
export type TaskMenuAction =
  | "amend_brief"
  | "hold"
  | "routing"
  | "exclude_worker"
  | "set_dependencies"
  | "extend_budget"
  | "cancel"
  | `verb:${string}`;

/**
 * The owner verbs that edit a task rather than move it: they appear in the ⋯ menu
 * with `next`'s eligibility and never in the Overview card's actions.
 */
const EDITING_VERBS: ReadonlySet<string> = new Set([
  "route",
  "release",
  "keep_hold",
  "set_dependencies",
  "extend_budget",
  "withdraw_cancel",
]);
export const isEditingVerb = (verb: string) => EDITING_VERBS.has(verb);

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type MenuEntry = {
  id: string;
  label: string;
  danger?: boolean;
  onPress: () => void;
};

function MenuRow({ entry, c }: { entry: MenuEntry; c: Colors }) {
  const r = roles(c);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={entry.label}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPress={entry.onPress}
      style={{
        minHeight: touchTarget,
        justifyContent: "center",
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderRadius: radius.control,
        backgroundColor: hovered ? hoverSurface(c) : "transparent",
      }}
    >
      <Text
        style={{
          color: entry.danger ? r.danger : r.foreground,
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
        }}
      >
        {entry.label}
      </Text>
    </Pressable>
  );
}

/** The ⋯ popover menu listing every editing action that applies to this task. */
export function TaskActionsPopover({
  open,
  anchor,
  onClose,
  onOpenPanel,
  task,
  busy,
  pendingOperation,
  act,
  navigation,
  onCloseDialog,
  next,
  c,
}: {
  open: boolean;
  anchor: React.RefObject<View | null>;
  onClose: () => void;
  onOpenPanel: (panel: TaskMenuAction) => void;
  task: TaskDetailRead["task"];
  busy: boolean;
  pendingOperation: boolean;
  act: BoardAct;
  navigation?: BoardNavigation;
  onCloseDialog: () => void;
  /** `next`'s verbs decide which verb-backed entries (budget extension) apply. */
  next: TaskNext | null;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl);
  const removeTask = useRpc(api.removeTask);

  if (!open) return null;

  const fences = holdsOf(task);
  const terminal = isTerminalPhase(task.phase);
  const canChangeRouting = Boolean(
    !task.removedAt &&
      ["queued", "needs_attention"].includes(task.phase) &&
      !task.agentIntent &&
      !task.agentId,
  );
  const canExcludeWorker = Boolean(
    task.agentId &&
      task.profile &&
      !task.removedAt &&
      !terminal &&
      !task.resolution.mergeIntent &&
      !task.resolution.mergedCommit,
  );
  const canReleaseMergeHold = Boolean(
    fences.merge &&
      !task.resolution.mergeIntent &&
      [
        "queued",
        "working",
        "awaiting_review",
        "reviewing",
        "changes_requested",
        "verifying",
        "merging",
      ].includes(task.phase),
  );
  const canRemove = Boolean(
    !task.removedAt &&
      [
        "queued",
        "blocked",
        "error",
        "needs_attention",
        "cancelled",
        "done",
      ].includes(task.phase),
  );

  const choose = (panel: TaskMenuAction) => {
    onClose();
    onOpenPanel(panel);
  };

  const entries: MenuEntry[] = [];

  if (!task.removedAt && !terminal) {
    entries.push({
      id: "amend_brief",
      label: "Amend brief",
      onPress: () => choose("amend_brief"),
    });
  }

  if (task.phase === "queued" && !fences.dispatch) {
    entries.push({
      id: "hold_dispatch",
      label: "Hold task",
      onPress: () => choose("hold"),
    });
  }
  if (task.phase === "queued" && fences.dispatch) {
    entries.push({
      id: "release_dispatch",
      label: "Release dispatch hold",
      onPress: () => {
        onClose();
        void act(() =>
          setTask({
            taskId: task.id,
            version: task.version,
            action: "release",
            kind: "dispatch",
          }),
        );
      },
    });
  }
  if (canReleaseMergeHold) {
    entries.push({
      id: "release_merge",
      label: "Release merge hold",
      onPress: () => {
        onClose();
        void act(() =>
          setTask({
            taskId: task.id,
            version: task.version,
            action: "release",
            kind: "merge",
          }),
        );
      },
    });
  }
  if (task.phase === "queued" && !task.removedAt) {
    entries.push({
      id: "promote",
      label: "Promote in project",
      onPress: () => {
        onClose();
        void act(() =>
          setTask({
            taskId: task.id,
            version: task.version,
            action: "promote",
          }),
        );
      },
    });
  }

  if (canChangeRouting) {
    entries.push({
      id: "routing",
      label: "Change routing & profiles",
      onPress: () => choose("routing"),
    });
  }
  if (canExcludeWorker) {
    entries.push({
      id: "exclude_worker",
      label: "Exclude worker",
      onPress: () => choose("exclude_worker"),
    });
  }
  // The prefilled dependency editor takes its availability from `next` when it has
  // been read (hidden when `next` refuses, e.g. once dispatch has begun).
  const dependencyVerb = next?.verbs.find(
    (verb) => verb.verb === "set_dependencies",
  );
  const canSetDependencies = next
    ? Boolean(dependencyVerb?.available)
    : !task.removedAt && task.phase === "queued";
  if (canSetDependencies) {
    entries.push({
      id: "set_dependencies",
      label: "Set dependencies",
      onPress: () => choose("set_dependencies"),
    });
  }
  if (budgetExtensionVerb(next)) {
    entries.push({
      id: "extend_budget",
      label: "Extend budget",
      onPress: () => choose("extend_budget"),
    });
  }
  if (task.workspaceId && navigation?.openWorkspace) {
    entries.push({
      id: "open_workspace",
      label: "Open workspace",
      onPress: () => {
        onClose();
        navigation.openWorkspace({ workspaceId: task.workspaceId! });
      },
    });
  }

  if (task.phase === "queued" && !task.removedAt) {
    entries.push({
      id: "cancel_queued",
      label: "Cancel task",
      danger: true,
      onPress: () => {
        onClose();
        void act(() =>
          setTask({
            taskId: task.id,
            version: task.version,
            action: "cancel",
          }),
        );
      },
    });
  } else if (!task.removedAt && !terminal) {
    entries.push({
      id: "cancel_or_supersede",
      label: task.disposition
        ? "Cancellation & withdrawal"
        : "Cancel or supersede",
      danger: !task.disposition,
      onPress: () => choose("cancel"),
    });
  }

  // Every other editing verb `next` offers now, with its own fields and confirmation.
  const covered = new Set(entries.map((entry) => entry.id));
  for (const verb of next?.verbs ?? []) {
    if (!verb.available || !isEditingVerb(verb.verb)) continue;
    const kind = typeof verb.args?.kind === "string" ? verb.args.kind : "";
    const duplicate =
      verb.verb === "extend_budget" ||
      (verb.verb === "withdraw_cancel" && covered.has("cancel_or_supersede")) ||
      verb.verb === "set_dependencies" ||
      (verb.verb === "release" && covered.has(`release_${kind}`));
    if (duplicate) continue;
    const key = verbKey(verb);
    entries.push({
      id: `verb:${key}`,
      label: sentence(verbText(verb)),
      onPress: () => choose(`verb:${key}`),
    });
  }

  if (canRemove && !busy && !pendingOperation) {
    entries.push({
      id: "remove_from_queue",
      label: "Remove from queue",
      danger: true,
      onPress: () => {
        onClose();
        void act(async () => {
          const result = await removeTask({
            taskId: task.id,
            version: task.version,
          });
          if ("accepted" in result) return;
          if ("backpressured" in result) {
            throw new Error(
              `Removal backpressured, nothing was removed: ${result.reason} Retry in about ${Math.max(1, Math.round(result.retryAfterMs / 1000))}s.`,
            );
          }
          if (result.removedAt) onCloseDialog();
        });
      },
    });
  }

  return (
    <Popover
      anchor={anchor}
      align="end"
      minWidth={220}
      inlineStyle={{ top: touchTarget, right: 0 }}
    >
      <View
        accessibilityRole="menu"
        accessibilityLabel="Task actions"
        style={{
          ...popoverChrome(c),
          borderRadius: radius.panel,
          padding: space.xs,
          gap: space.xxs / 2,
        }}
      >
        {entries.length === 0 ? (
          <Text
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              padding: space.xs,
            }}
          >
            No editing actions apply now.
          </Text>
        ) : (
          entries.map((entry) => <MenuRow key={entry.id} entry={entry} c={c} />)
        )}
      </View>
    </Popover>
  );
}

/**
 * Focused inline panel opened when the operator picks a form-bearing action
 * from the ⋯ menu. Preserves every existing confirmation and field validation.
 */
export function TaskMenuActionPanel({
  panel,
  onClose,
  task,
  state,
  drafts,
  busy,
  pendingOperation,
  act,
  next,
  c,
}: {
  panel: TaskMenuAction | null;
  onClose: () => void;
  task: TaskDetailRead["task"];
  state: UiQueueState | undefined;
  drafts: TaskDrafts;
  busy: boolean;
  pendingOperation: boolean;
  act: BoardAct;
  next: TaskNext | null;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl);
  const [holdReason, setHoldReason] = useTaskDraft(drafts, "holdReason", "");
  const [amendBrief, setAmendBrief] = useTaskDraft(drafts, "amendBrief", "");
  const [amendReason, setAmendReason] = useTaskDraft(drafts, "amendReason", "");
  const [budgetReason, setBudgetReason] = useTaskDraft(
    drafts,
    "budgetReason",
    "",
  );
  const [workerExclusionReason, setWorkerExclusionReason] = useTaskDraft(
    drafts,
    "workerExclusionReason",
    "",
  );
  const [notice, setNotice] = useState<VerbNotice | null>(null);

  if (!panel) return notice ? <RecordNotice notice={notice} c={c} /> : null;

  if (panel.startsWith("verb:")) {
    const verb = next?.verbs.find(
      (item) => item.available && `verb:${verbKey(item)}` === panel,
    );
    return (
      <DetailSection title={verb ? sentence(verbText(verb)) : "Action"} c={c}>
        {verb && next ? (
          <VerbForm
            key={panel}
            taskId={task.id}
            verb={verb}
            next={next}
            state={state}
            busy={busy || pendingOperation}
            onDone={(done) => {
              setNotice(done);
              onClose();
            }}
            onCancel={onClose}
            c={c}
          />
        ) : (
          <>
            <Text
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              This action no longer applies.
            </Text>
            <Button small c={c} text="Close" onPress={onClose} />
          </>
        )}
      </DetailSection>
    );
  }

  const headerClose = (
    <View style={{ ...row, justifyContent: "flex-end" }}>
      <Button
        small
        c={c}
        text="Done"
        label="Close action panel"
        onPress={onClose}
      />
    </View>
  );

  if (panel === "amend_brief") {
    return (
      <DetailSection title="Amend brief" c={c}>
        <Field
          c={c}
          label="Updated brief (required)"
          value={amendBrief}
          onChange={setAmendBrief}
          multiline
          placeholder="Full updated brief text"
        />
        <Field
          c={c}
          label="Reason (required)"
          value={amendReason}
          onChange={setAmendReason}
          placeholder="Why the brief is being amended"
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Save amendment"
            label="Save brief amendment"
            disabled={
              busy ||
              pendingOperation ||
              !amendBrief.trim() ||
              !amendReason.trim()
            }
            onPress={() =>
              void act(async () => {
                await setTask({
                  taskId: task.id,
                  version: task.version,
                  action: "amend_brief",
                  brief: amendBrief.trim(),
                  reason: amendReason.trim(),
                });
                setAmendBrief("");
                setAmendReason("");
                onClose();
              })
            }
          />
          <Button small c={c} text="Close" onPress={onClose} />
        </View>
      </DetailSection>
    );
  }

  if (panel === "hold") {
    return (
      <DetailSection title="Hold task" c={c}>
        <Field
          c={c}
          label="Hold reason (required)"
          value={holdReason}
          onChange={setHoldReason}
          placeholder="Why dispatch is held"
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Hold task"
            label="Confirm hold task"
            disabled={busy || !holdReason.trim()}
            onPress={() =>
              void act(async () => {
                await setTask({
                  taskId: task.id,
                  version: task.version,
                  action: "hold",
                  kind: "dispatch",
                  reason: holdReason.trim(),
                });
                setHoldReason("");
                onClose();
              })
            }
          />
          <Button small c={c} text="Close" onPress={onClose} />
        </View>
      </DetailSection>
    );
  }

  if (panel === "routing") {
    return (
      <View style={{ gap: space.xs }}>
        <TechnicalRouting
          task={task}
          state={state}
          drafts={drafts}
          busy={busy}
          act={act}
          c={c}
        />
        {headerClose}
      </View>
    );
  }

  if (panel === "exclude_worker") {
    const excludeWorker = (
      workerExclusion: { agentId: string } | { profileId: string },
    ) =>
      void act(async () => {
        await setTask({
          taskId: task.id,
          version: task.version,
          action: "exclude_worker",
          workerExclusion,
          reason: workerExclusionReason.trim(),
        });
        setWorkerExclusionReason("");
        onClose();
      });
    return (
      <DetailSection title="Exclude worker" c={c}>
        <Field
          c={c}
          label="Worker exclusion reason"
          value={workerExclusionReason}
          onChange={setWorkerExclusionReason}
          placeholder="Why this worker should get no further turns"
        />
        <View style={row}>
          {task.agentId &&
            !task.workerExclusions.some((e) => e.agentId === task.agentId) && (
              <Button
                small
                c={c}
                text="Exclude current agent"
                disabled={
                  busy || pendingOperation || !workerExclusionReason.trim()
                }
                onPress={() => excludeWorker({ agentId: task.agentId! })}
              />
            )}
          {task.profile &&
            !task.workerExclusions.some(
              (e) => e.profileId === task.profile!.id,
            ) && (
              <Button
                small
                c={c}
                text="Exclude current profile"
                disabled={
                  busy || pendingOperation || !workerExclusionReason.trim()
                }
                onPress={() => excludeWorker({ profileId: task.profile!.id })}
              />
            )}
          <Button small c={c} text="Close" onPress={onClose} />
        </View>
      </DetailSection>
    );
  }

  if (panel === "set_dependencies") {
    // Keyed by task: switching tasks remounts the editor with that task's own list.
    return (
      <DependenciesPanel
        key={task.id}
        task={task}
        busy={busy || pendingOperation}
        act={act}
        onClose={onClose}
        c={c}
      />
    );
  }

  if (panel === "extend_budget") {
    const verb = budgetExtensionVerb(next);
    if (!verb) {
      return (
        <DetailSection title="Extend budget" c={c}>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {next?.verbs.find((item) => item.verb === "extend_budget")
              ?.refusal ?? "The task budget is not exhausted."}
          </Text>
          <Button small c={c} text="Close" onPress={onClose} />
        </DetailSection>
      );
    }
    return (
      <DetailSection title="Extend budget" c={c}>
        <Field
          c={c}
          label="Reason (required)"
          value={budgetReason}
          onChange={setBudgetReason}
          placeholder="Why this task needs more budget"
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Extend budget"
            label="Confirm extend budget"
            disabled={busy || pendingOperation || !budgetReason.trim()}
            onPress={() =>
              void act(async () => {
                // The verb `next` offers, submitted as the operator at the board (Spec 058 authority).
                await setTask({
                  ...verb.args,
                  taskId: task.id,
                  version: task.version,
                  action: "extend_budget",
                  reason: budgetReason.trim(),
                  caller: OPERATOR_BOARD_CALLER,
                } as api.TaskControlInput);
                setBudgetReason("");
                onClose();
              })
            }
          />
          <Button small c={c} text="Close" onPress={onClose} />
        </View>
      </DetailSection>
    );
  }

  if (panel === "cancel") {
    return (
      <View style={{ gap: space.xs }}>
        <TechnicalDisposition
          task={task}
          drafts={drafts}
          busy={busy}
          pendingOperation={pendingOperation}
          act={act}
          c={c}
        />
        {headerClose}
      </View>
    );
  }

  return null;
}

/** The budget extension `next` offers as available, or null when the budget is not exhausted. */
function budgetExtensionVerb(next: TaskNext | null): TaskNextVerb | null {
  return (
    next?.verbs.find(
      (verb) => verb.verb === "extend_budget" && verb.available,
    ) ?? null
  );
}

/**
 * The shared dependency editor over this task's stored `dependsOn`, saved as the
 * board's `set_dependencies` control.
 */
function DependenciesPanel({
  task,
  busy,
  act,
  onClose,
  c,
}: {
  task: TaskDetailRead["task"];
  busy: boolean;
  act: BoardAct;
  onClose: () => void;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl);
  return (
    <DependencyListEditor
      stored={task.dependsOn ?? []}
      busy={busy}
      onClose={onClose}
      c={c}
      onSave={(dependsOn, reason) =>
        void act(async () => {
          await setTask({
            taskId: task.id,
            version: task.version,
            action: "set_dependencies",
            dependsOn,
            ...(reason ? { reason } : {}),
          });
          onClose();
        })
      }
    />
  );
}
