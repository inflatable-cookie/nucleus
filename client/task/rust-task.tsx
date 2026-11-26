/**
 * The Rust task view (Spec 071, "Task view"): one scrolling view that answers, in
 * order, what state the task is in, whether anyone must act, and the evidence.
 * An attention panel appears only when a person has to act; routine actions sit
 * in the footer, and Cancel stands apart and asks first.
 */
import { useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import {
  Button,
  Dialog,
  DropdownSelect,
  Field,
  HelpTip,
  row,
  type Colors,
} from "../controls";
import { radius, roles, space, taskDetail, toneSurface, wash, type as typeScale } from "../design";
import { errorText } from "../error-text";
import { relativeAge } from "../../shared/pipeline-board";
import { formatSpan } from "../../shared/task-detail-summary";
import { normalizeRepositoryOrigin } from "../../shared/lanes";
import { generatedProjectBadge, type ProjectBadge } from "../../shared/t3/project-badge";
import { ProjectBadgeMark } from "../board/cards";
import {
  postRustCommand,
  rustPhaseLabels,
  rustQuestionText,
  rustTaskLabel,
  useRustDetail,
  type RustCommand,
  type RustInvalidation,
  type RustNext,
  type RustQuestion,
  type RustTask,
  type RustTaskDetail,
} from "../web/rust-board";
import { Dot, Hint, QuietButton, metaText, toneColor } from "./rust-detail-parts";
import {
  ActivityList,
  BriefEditor,
  Card,
  Collapsible,
  Prerequisites,
  ProgressCard,
  PullRequestCard,
  activityEntries,
  type PrerequisiteDraft,
} from "./rust-task-cards";
import { clockTime, type TimelineTone } from "./rust-timeline";

type CommandName = RustNext["commands"][number]["name"];
type Footer = "hold" | "cancel" | null;
type Panel = "answer" | "complete" | "move_work" | null;

export type RustTaskProject = { name: string; key?: string; badge: ProjectBadge | null };

const ACTIVITY_PREVIEW = 5;

/** Who must act, and how, read from the engine's state; null when nobody must. */
type Attention = {
  eyebrow: string;
  tone: TimelineTone;
  text: string;
  detail: string | null;
  help?: string;
  /** Whether the answer form starts open: the operator's own decisions do. */
  answerOpen: boolean;
};

function attentionFor(
  detail: RustTaskDetail,
  question: RustQuestion | null,
): Attention | null {
  // Finished tasks need no one; their evidence stays in the cards.
  if (detail.phase === "done" || detail.phase === "cancelled") return null;
  // The engine's label names who answers ("· Tom", "· planner", "· declined").
  const toTom = /·\s*Tom\b/.test(detail.stateLabel);
  const declined = detail.wait === "operator_declined" || /·\s*declined\b/.test(detail.stateLabel);
  if (declined) {
    return {
      eyebrow: "Declined",
      tone: "warning",
      text: "Tom declined this decision. Move or cancel the task.",
      detail: question ? rustQuestionText(question) : null,
      answerOpen: false,
    };
  }
  if (question) {
    if ("repair" in question || "retry" in question) {
      return { eyebrow: "Needs attention", tone: "danger", text: rustQuestionText(question), detail: detail.waitDetail ?? null, answerOpen: false };
    }
    return toTom
      ? { eyebrow: "Your decision", tone: "warning", text: rustQuestionText(question), detail: null, answerOpen: true }
      : {
          eyebrow: "Planner question",
          tone: "warning",
          text: rustQuestionText(question),
          detail: null,
          help: "The task's planner answers this. You can answer instead.",
          answerOpen: false,
        };
  }
  if (detail.hold) {
    return {
      eyebrow: "Held",
      tone: "warning",
      text: detail.hold.reason || "Held without a reason.",
      detail: null,
      answerOpen: false,
    };
  }
  if (detail.phase === "report_ready" && detail.report?.delivery) {
    return { eyebrow: "Report ready", tone: "warning", text: detail.report.delivery.summary, detail: null, answerOpen: false };
  }
  if (detail.attention === "attention" || detail.phase === "blocked" || detail.phase === "error") {
    return {
      eyebrow: "Needs attention",
      tone: "danger",
      text: detail.waitDetail ?? waitWords(detail.wait) ?? detail.report?.failure ?? detail.stateLabel,
      detail: null,
      answerOpen: false,
    };
  }
  return null;
}

/** Plain words for each engine wait, used when the engine sends no sentence of its own. */
const WAIT_WORDS: Record<string, string> = {
  checks_pending: "Waiting for required checks",
  checks_unreported: "Waiting for checks to report",
  forge_unknown: "Checking GitHub",
  external_merge_blocked: "Waiting for the external merge",
  review_publication_blocked: "Waiting to publish the review",
  workspace_unknown: "Checking the workspace",
  workspace_blocked: "The workspace needs attention",
  host_unknown: "Confirming delivery to T3",
  host_observation_blocked: "Open the task thread to check",
  starting: "Starting the run",
  idle_without_terminal_run: "Waiting for the run to finish its turn",
  retained_thread_busy: "Waiting for the thread to be free",
  permission: "Waiting for a permission answer",
  usage_permission: "Waiting for a usage decision",
  input: "Waiting for input",
  stopping: "Stopping the run",
  capacity: "Waiting for a free slot",
  prerequisite: "Waiting for prerequisites",
  assignment_too_large: "The assignment exceeds the T3 message limit",
};

function waitWords(wait: string | null): string | null {
  return wait ? (WAIT_WORDS[wait] ?? null) : null;
}

/** Waits the attention panel already explains. */
const PANEL_WAITS = new Set(["hold", "question", "operator_declined"]);

export function RustTaskDialog({
  id,
  summary,
  project,
  inline,
  c,
  onClose,
  invalidate,
  onOpenTask,
}: {
  id: string;
  summary: RustTask | undefined;
  project?: (task: RustTask) => RustTaskProject;
  /** Opens another task in this view: a prerequisite's reference. */
  onOpenTask?: (id: string) => void;
  inline: boolean;
  compact?: boolean;
  c: Colors;
  onClose: () => void;
  invalidate: RustInvalidation;
}) {
  const [footer, setFooter] = useState<Footer>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [amending, setAmending] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState<boolean | null>(null);
  const [activityAll, setActivityAll] = useState(false);
  const [reason, setReason] = useState("");
  const [prerequisiteDraft, setPrerequisiteDraft] = useState<PrerequisiteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState("");
  const { task, next, history } = useRustDetail(id, true);
  const detail = task.data;
  const card = detail ?? summary;
  const fresh =
    next.data && detail?.version === next.data.version && !next.error && !task.error ? next.data : undefined;
  // While a refetch brings the two reads back to one version, keep the last commands in
  // view (locked) so the footer and Amend do not flicker out from under a click.
  const lastCommands = useRef<RustNext | undefined>(undefined);
  if (fresh) lastCommands.current = fresh;
  const commands = fresh ?? lastCommands.current;
  const stale = !fresh;
  const question = (fresh ? fresh.question : detail?.question) ?? null;
  const questionKey = question ? JSON.stringify(question) : "";
  const shownQuestion = useRef(questionKey);
  useEffect(() => {
    // A new question starts with its form closed and empty (the form is keyed by it too).
    if (shownQuestion.current === questionKey) return;
    shownQuestion.current = questionKey;
    setPanel((current) => (current === "answer" ? null : current));
  }, [questionKey]);
  const allowance = commands?.allowance ?? detail?.allowance;

  const submit = async (command: RustCommand) => {
    if (saving.current) throw new Error("A task change is already in progress.");
    saving.current = true;
    setBusy(true);
    setNotice("");
    try {
      return await postRustCommand(id, command);
    } finally {
      saving.current = false;
      setBusy(false);
      invalidate(id);
    }
  };
  const run = (command: RustCommand) => {
    void submit(command).then(
      (outcome) => {
        if ("status" in outcome) {
          setNotice("The engine is checking the task. Try again when the command is ready.");
        } else {
          setFooter(null);
          setPanel(null);
          setReason("");
        }
      },
      (error: unknown) => setNotice(errorText(error)),
    );
  };
  const offered = (name: CommandName) => {
    const status = commands?.commands.find((command) => command.name === name)?.preflight;
    return status === "ready" || status === "pending";
  };
  const moves =
    commands?.commands.flatMap((command) =>
      command.name === "move" && command.preflight !== "unavailable"
        ? [
            {
              value: command.phase,
              label: rustPhaseLabels[command.phase],
              detail: command.preflight === "pending" ? "Check required" : undefined,
            },
          ]
        : [],
    ) ?? [];

  const r = roles(c);
  const label = card ? rustTaskLabel(card) : id;
  const title = (detail?.title || card?.title) ?? "";
  const heading = card && (
    <TaskHeading c={c} task={card} label={label} title={title} project={project?.(card)} />
  );
  const age = detail && <TaskAge c={c} detail={detail} />;

  if (!detail) {
    return (
      <Dialog
        c={c}
        wide
        inline={inline}
        title={[label, title].filter(Boolean).join(" · ")}
        heading={heading}
        label="Task detail"
        bodyLabel="Task"
        closeLabel="Close task"
        onClose={onClose}
        backdropLabel="Close task"
      >
        {task.error ? (
          <ReadError error={task.error} retry={() => void task.refetch()} c={c} />
        ) : (
          <Text style={metaText(c)}>Loading task…</Text>
        )}
      </Dialog>
    );
  }

  const finished = detail.phase === "done" || detail.phase === "cancelled";
  const locked = busy || stale;
  const attention = attentionFor(detail, question);
  const recheck =
    commands && offered("recheck") && !finished ? (
      <Button c={c} small text="Recheck" hint="Look once more at the current state" disabled={locked}
        onPress={() => run({ recheck: commands.version })} />
    ) : null;
  const pages = history.data?.pages ?? [];
  const finishedRecord = pages
    .flat()
    .flatMap((entry) => entry.presentation.map((record) => ({ record, at: entry.content.at })))
    .find(({ record }) => record.kind === "finished");
  // The wait line names the engine's actual wait; the panel already explains a person's wait.
  const waitText =
    detail.phase === "cancelled"
      ? [
          "Cancelled",
          finishedRecord?.record.kind === "finished" && finishedRecord.record.previousPhase
            ? `from ${rustPhaseLabels[finishedRecord.record.previousPhase]}`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : finished || (detail.wait !== null && PANEL_WAITS.has(detail.wait))
        ? null
        : (detail.waitDetail ?? waitWords(detail.wait));
  const waitLine =
    waitText || (!finished && detail.nextCheckAt !== null) || (recheck && !attention)
      ? { text: waitText ?? "", nextCheckAt: finished ? null : detail.nextCheckAt }
      : null;
  const dependencies = detail.dependencyStatus?.dependencies ?? [];
  const entries = activityEntries(pages);
  const mergedCommit =
    pages.flat().flatMap((entry) => entry.presentation).find((record) => record.kind === "merged")?.commit ?? null;
  const promoted = detail.queuePriority === "promoted";
  const canPromote = offered("promote") || offered("demote");
  const activityExpanded = activityOpen ?? !attention;

  const progress = (
    <ProgressCard
      c={c}
      detail={detail}
      allowance={allowance}
      waitLine={waitLine}
      recheck={!attention ? recheck : null}
      dependencies={
        (detail.phase === "queued" && dependencies.length > 0) || prerequisiteDraft !== null ? (
          <Prerequisites
            c={c}
            dependencies={dependencies}
            draft={prerequisiteDraft}
            onDraft={setPrerequisiteDraft}
            // An open draft can always be closed, even once Edit is no longer offered.
            canEdit={offered("set_dependencies") || prerequisiteDraft !== null}
            busy={locked}
            onOpenTask={onOpenTask}
            version={detail.version}
            onSave={(references, version) =>
              submit({ set_dependencies: { version, depends_on: references } }).then(
                (outcome) => {
                  if (!("status" in outcome)) return true;
                  setNotice("The engine is checking the task. Try again when the command is ready.");
                  return false;
                },
                (error: unknown) => {
                  setNotice(errorText(error));
                  return false;
                },
              )
            }
          />
        ) : null
      }
    />
  );
  const pullRequest = <PullRequestCard c={c} detail={detail} mergedCommit={mergedCommit} />;

  const footerBar =
    !finished && commands && (offered("hold") || moves.length > 0 || canPromote || offered("cancel")) ? (
      <View
        style={{
          ...row,
          gap: space.xs,
          paddingTop: space.sm,
          borderTopWidth: 1,
          borderTopColor: r.hairline,
        }}
      >
        {footer === "hold" ? (
          <>
            <View style={{ flex: 1, minWidth: 180 }}>
              <Field c={c} label="Reason" hideLabel value={reason} onChange={setReason} disabled={locked} />
            </View>
            <Button c={c} small text="Hold" label="Hold task" disabled={locked}
              onPress={() => run({ hold: reason.trim() })} />
            <Button c={c} small text="Keep" label="Keep running" onPress={() => setFooter(null)} />
          </>
        ) : (
          <>
            {canPromote && (
              <Button
                c={c}
                small
                text="Promoted"
                checked={promoted}
                hint="Take the next free slot first"
                disabled={locked}
                onPress={() => run(promoted ? { demote: commands.version } : { promote: commands.version })}
              />
            )}
            {offered("hold") && (
              <Button c={c} small text="Hold" disabled={locked} onPress={() => setFooter("hold")} />
            )}
            {moves.length > 0 && (
              <DropdownSelect
                c={c}
                compact
                hideLabel
                minWidth={110}
                label="Move"
                placeholder="Move"
                value=""
                options={moves}
                disabled={locked}
                onChange={(value) => {
                  const move = moves.find((option) => option.value === value);
                  if (move) run({ move: move.value });
                }}
              />
            )}
            <View style={{ flex: 1 }} />
            {offered("cancel") &&
              (footer === "cancel" ? (
                <View accessibilityRole="alert" style={{ ...row, gap: space.xs }}>
                  <Text style={{ ...typeScale.body, color: r.foreground }}>Cancel this task?</Text>
                  <Button c={c} small danger text="Cancel task" disabled={locked} onPress={() => run("cancel")} />
                  <Button c={c} small text="Keep" label="Keep task" onPress={() => setFooter(null)} />
                </View>
              ) : (
                <QuietButton c={c} danger text="Cancel" disabled={locked} onPress={() => setFooter("cancel")} />
              ))}
          </>
        )}
      </View>
    ) : null;

  return (
    <Dialog
      c={c}
      wide
      inline={inline}
      title={[label, title].filter(Boolean).join(" · ")}
      heading={heading}
      headerActions={age}
      label="Task detail"
      bodyLabel="Task"
      closeLabel="Close task"
      onClose={onClose}
      backdropLabel="Close task"
      footer={footerBar}
    >
      {notice && (
        <Text accessibilityRole="alert" style={{ color: r.warning }}>
          {notice}
        </Text>
      )}
      {next.error && <ReadError error={next.error} retry={() => void next.refetch()} c={c} />}
      {attention && (
        <AttentionPanel
          c={c}
          attention={attention}
          sinceMs={detail.stateSinceMs}
          question={question}
          canAnswer={offered("answer")}
          busy={locked}
          panel={panel}
          setPanel={setPanel}
          onAnswer={run}
        >
          {recheck}
          {attention.tone === "danger" && detail.pullRequest && (
            <Button c={c} small icon="ExternalLink" text="Open PR" label="Open pull request"
              onPress={() => void Linking.openURL(detail.pullRequest!.url)} />
          )}
          {detail.hold && offered("release") && (
            <Button c={c} small selected text="Release" disabled={locked} onPress={() => run("release")} />
          )}
          {attention.eyebrow === "Report ready" && (
            <ReportActions
              c={c}
              detail={detail}
              panel={panel}
              setPanel={setPanel}
              canComplete={offered("complete")}
              canReturn={offered("move_work")}
              busy={locked}
              reason={reason}
              setReason={setReason}
              run={run}
            />
          )}
        </AttentionPanel>
      )}
      {detail.phase === "done" ? (
        <>
          {pullRequest}
          {progress}
        </>
      ) : (
        <>
          {progress}
          {pullRequest}
        </>
      )}
      {detail.report && (detail.report.delivery || detail.report.failure) && (
        <Collapsible c={c} title="Report" open={reportOpen} onToggle={() => setReportOpen(!reportOpen)}>
          {detail.report.delivery && (
            <>
              <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
                {detail.report.delivery.summary}
              </Text>
              <Text style={metaText(c)}>
                {`${detail.report.delivery.artifact.key} · version ${detail.report.delivery.artifact.version}`}
              </Text>
            </>
          )}
          {detail.report.failure && (
            <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
              {detail.report.failure}
            </Text>
          )}
        </Collapsible>
      )}
      {(entries.length > 0 || history.error || history.hasNextPage) && (
        attention ? (
          <Collapsible c={c} title="Activity" open={activityExpanded} onToggle={() => setActivityOpen(!activityExpanded)}>
            {activityBody()}
          </Collapsible>
        ) : (
          <Card c={c} label="Activity">
            <Text accessibilityRole="header" style={{ ...typeScale.body, fontWeight: "600", color: r.foreground }}>
              Activity
            </Text>
            {activityBody()}
          </Card>
        )
      )}
      <Collapsible
        c={c}
        title="Brief"
        open={briefOpen || amending}
        onToggle={() => {
          setBriefOpen(!(briefOpen || amending));
          setAmending(false);
        }}
        action={
          (offered("amend") || amending) && !finished ? (
            // Never disabled: the brief save is version-checked, and a control that re-enables
            // after a command can drop the first click before its responder updates.
            <QuietButton c={c} text={amending ? "Done" : "Amend"} label="Amend"
              onPress={() => setAmending(!amending)} />
          ) : undefined
        }
      >
        {amending ? (
          <BriefEditor
            detail={detail}
            c={c}
            submit={submit}
            readBrief={async () => (await task.refetch({ throwOnError: true })).data?.brief}
          />
        ) : (
          <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
            {detail.brief.text}
          </Text>
        )}
      </Collapsible>
    </Dialog>
  );

  function activityBody() {
    return (
      <>
        {history.error && <ReadError error={history.error} retry={() => void history.refetch()} c={c} />}
        <ActivityList c={c} entries={entries} limit={activityAll ? null : ACTIVITY_PREVIEW} />
        {entries.length === 0 && !history.error && <Text style={metaText(c)}>No milestones on this page.</Text>}
        {/* The server pages raw records, so a page can hold no milestones and still have a next. */}
        {(entries.length > ACTIVITY_PREVIEW && !activityAll) || history.hasNextPage ? (
          <View style={{ alignSelf: "flex-start" }}>
            <QuietButton
              c={c}
              text="More"
              label="More activity"
              disabled={history.isFetching}
              onPress={() => {
                const hidden = !activityAll && entries.length > ACTIVITY_PREVIEW;
                setActivityAll(true);
                if (!hidden && history.hasNextPage) void history.fetchNextPage();
              }}
            />
          </View>
        ) : null}
      </>
    );
  }
}

function TaskHeading({
  c,
  task,
  label,
  title,
  project,
}: {
  c: Colors;
  task: RustTask;
  label: string;
  title: string;
  project: RustTaskProject | undefined;
}) {
  const r = roles(c);
  const repository = normalizeRepositoryOrigin(task.identity.repository) ?? task.identity.repository;
  const badge = project?.badge ?? (project ? generatedProjectBadge(project.name.trim() || (project.key ?? "")) : null);
  const step = task.lifecycle.steps.find((candidate) => candidate.state === "current");
  const tone: TimelineTone =
    task.phase === "done" ? "success" : task.phase === "cancelled" ? "muted" : (step?.tone ?? "muted");
  return (
    <View style={{ gap: space.xxs }}>
      <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        {badge && <ProjectBadgeMark badge={badge} c={c} />}
        <Hint c={c} text={`${repository} · base ${task.identity.base}`} focusable>
          <Text style={metaText(c)}>{label}</Text>
        </Hint>
      </View>
      <Text accessibilityRole="header" style={{ ...typeScale.section, fontWeight: "600", color: r.foreground }}>
        {title || label}
      </Text>
      <View accessibilityLabel={`State: ${task.stateLabel}`} style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        <Dot c={c} tone={tone} />
        <Text style={{ ...typeScale.body, color: metaText(c).color }}>{task.stateLabel}</Text>
      </View>
    </View>
  );
}

function TaskAge({ c, detail }: { c: Colors; detail: RustTaskDetail }) {
  const finished = detail.phase === "done" || detail.phase === "cancelled";
  const admitted = detail.createdAtMs ?? detail.lifecycle.admittedAtMs;
  const ended = finished ? (detail.lifecycle.finishedAtMs ?? detail.stateSinceMs) : null;
  const at = finished ? ended : admitted;
  if (at === null) return null;
  const tip = [
    finished && ended !== null ? `Finished ${clockTime(ended)}` : admitted !== null ? `Admitted ${clockTime(admitted)}` : null,
    finished && ended !== null && admitted !== null ? `Took ${formatSpan(ended - admitted)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Hint c={c} text={tip} focusable style={{ marginRight: space.xs, alignSelf: "center" }}>
      <Text style={metaText(c)}>{relativeAge(at)}</Text>
    </Hint>
  );
}

function AttentionPanel({
  c,
  attention,
  sinceMs,
  question,
  canAnswer,
  busy,
  panel,
  setPanel,
  onAnswer,
  children,
}: {
  c: Colors;
  attention: Attention;
  sinceMs: number | null;
  question: RustQuestion | null;
  canAnswer: boolean;
  busy: boolean;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  onAnswer: (command: RustCommand) => void;
  children: React.ReactNode;
}) {
  const r = roles(c);
  const [help, setHelp] = useState(false);
  const color = toneColor(attention.tone, c);
  const direct = question && ("retry" in question || "allowance" in question);
  const formOpen = attention.answerOpen || panel === "answer";
  return (
    <View
      accessibilityLabel={attention.eyebrow}
      style={{
        gap: space.xs,
        padding: space.sm,
        borderRadius: radius.panel,
        backgroundColor: toneSurface(color, r.section, wash.tone),
      }}
    >
      <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        <Text
          style={{
            ...typeScale.metadata,
            fontWeight: "600",
            letterSpacing: taskDetail.eyebrowTracking,
            textTransform: "uppercase",
            color,
          }}
        >
          {attention.eyebrow}
        </Text>
        {attention.help && (
          <HelpTip c={c} label={attention.eyebrow} text={attention.help} open={help} onOpenChange={setHelp} />
        )}
        <View style={{ flex: 1 }} />
        {sinceMs !== null && (
          <Hint c={c} text={`Since ${clockTime(sinceMs)}`} focusable>
            <Text style={metaText(c)}>{formatSpan(Date.now() - sinceMs)}</Text>
          </Hint>
        )}
      </View>
      <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
        {attention.text}
      </Text>
      {attention.detail && <Text selectable style={metaText(c)}>{attention.detail}</Text>}
      {question && "accept" in question && (
        <Text selectable style={metaText(c)}>{`Head ${question.accept.head}`}</Text>
      )}
      <View style={{ ...row, gap: space.xs }}>
        {children}
        {question && canAnswer && direct && (
          <Button
            c={c}
            small
            selected
            text={"retry" in question ? "Try again" : "Extend allowance"}
            disabled={busy}
            onPress={() => onAnswer({ answer: "retry" in question ? "retry" : "extend" })}
          />
        )}
        {question && canAnswer && !direct && !formOpen && (
          <>
            <View style={{ flex: 1 }} />
            <QuietButton c={c} text="Answer" label="Open answer" onPress={() => setPanel("answer")} />
          </>
        )}
      </View>
      {question && canAnswer && !direct && formOpen && (
        <AnswerForm key={JSON.stringify(question)} c={c} question={question} busy={busy} onAnswer={onAnswer} />
      )}
    </View>
  );
}

function AnswerForm({
  c,
  question,
  busy,
  onAnswer,
}: {
  c: Colors;
  question: RustQuestion;
  busy: boolean;
  onAnswer: (command: RustCommand) => void;
}) {
  const [answer, setAnswer] = useState("");
  const choices = "work" in question ? question.work.options : [];
  const command: RustCommand =
    "accept" in question
      ? { answer: { accept: { head: question.accept.head, reason: answer.trim() } } }
      : { answer: { work: choices.length ? answer : answer.trim() } };
  return (
    <View style={{ ...row, gap: space.xs, alignItems: "flex-end" }}>
      {choices.length > 0 ? (
        <DropdownSelect
          c={c}
          hideLabel
          minWidth={220}
          label="Option"
          placeholder="Option"
          value={answer}
          options={choices.map((label) => ({ value: label, label }))}
          disabled={busy}
          onChange={setAnswer}
        />
      ) : (
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field
            c={c}
            hideLabel
            label={"accept" in question ? "Reason" : "Guidance"}
            multiline
            value={answer}
            onChange={setAnswer}
            disabled={busy}
          />
        </View>
      )}
      <Button c={c} small selected text="Answer" disabled={busy || !answer.trim()} onPress={() => onAnswer(command)} />
    </View>
  );
}

function ReportActions({
  c,
  detail,
  panel,
  setPanel,
  canComplete,
  canReturn,
  busy,
  reason,
  setReason,
  run,
}: {
  c: Colors;
  detail: RustTaskDetail;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  canComplete: boolean;
  canReturn: boolean;
  busy: boolean;
  reason: string;
  setReason: (value: string) => void;
  run: (command: RustCommand) => void;
}) {
  const delivery = detail.report?.delivery;
  if (!delivery) return null;
  const open = panel === "complete" || panel === "move_work";
  return (
    <>
      {canComplete && (
        <Button c={c} small text="Complete" selected={panel === "complete"} disabled={busy}
          onPress={() => setPanel(panel === "complete" ? null : "complete")} />
      )}
      {canReturn && (
        <Button c={c} small text="Return to work" selected={panel === "move_work"} disabled={busy}
          onPress={() => setPanel(panel === "move_work" ? null : "move_work")} />
      )}
      {open && (
        <View style={{ ...row, gap: space.xs, width: "100%" }}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Field
              c={c}
              label={panel === "complete" ? "Acceptance reason" : "Revision instruction"}
              value={reason}
              onChange={setReason}
              disabled={busy}
            />
          </View>
          <Button
            c={c}
            small
            text={panel === "complete" ? "Accept report" : "Send instruction"}
            disabled={busy || !reason.trim()}
            onPress={() =>
              run(
                panel === "complete"
                  ? { complete: { version: detail.version, artifact: delivery.artifact, reason: reason.trim() } }
                  : { move_work: { instruction: reason.trim() } },
              )
            }
          />
        </View>
      )}
    </>
  );
}

function ReadError({ c, error, retry }: { c: Colors; error: unknown; retry: () => void }) {
  return (
    <View style={{ ...row, gap: space.xs }}>
      <Text accessibilityRole="alert" style={{ color: roles(c).warning, flexShrink: 1 }}>
        {errorText(error)}
      </Text>
      <Button c={c} small text="Retry" onPress={retry} />
    </View>
  );
}
