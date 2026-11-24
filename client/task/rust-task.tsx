import { useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import {
  Button,
  DetailSection,
  Dialog,
  DropdownSelect,
  Field,
  InlineConfirm,
  LabelHelp,
  SaveStatus,
  TextLink,
  muted,
  row,
  useSectionAutoSave,
  type Colors,
} from "../controls";
import { space } from "../design";
import { errorText } from "../error-text";
import { DetailField, TaskDetailTabs, type TaskDetailTab } from "./parts";
import {
  postRustCommand,
  rustPhaseLabels,
  rustQuestionText,
  rustTaskLabel,
  rustWaitText,
  useRustDetail,
  type RustCommand,
  type RustHistoryPage,
  type RustInvalidation,
  type RustNext,
  type RustQuestion,
  type RustTask,
  type RustTaskDetail,
  type RustVerdict,
} from "../web/rust-board";

type Section = "amend" | "hold" | "cancel" | "complete" | "move_work" | null;
type CommandOutcome = Awaited<ReturnType<typeof postRustCommand>>;

export function RustTaskDialog({
  id,
  summary,
  inline,
  compact,
  c,
  onClose,
  invalidate,
}: {
  id: string;
  summary: RustTask | undefined;
  inline: boolean;
  compact: boolean;
  c: Colors;
  onClose: () => void;
  invalidate: RustInvalidation;
}) {
  const [tab, setTab] = useState<TaskDetailTab>("overview");
  const [section, setSection] = useState<Section>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState("");
  const { task, next, history } = useRustDetail(id, tab === "activity");
  const detail = task.data;
  const card = detail ?? summary;
  const delivery = detail?.report?.delivery;
  const commands =
    next.data &&
    detail?.version === next.data.version &&
    !next.error &&
    !task.error
      ? next.data
      : undefined;
  const visibleQuestion = commands ? commands.question : detail?.question;
  const submit = async (command: RustCommand) => {
    if (saving.current)
      throw new Error("A task change is already in progress.");
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
          setNotice(
            "The engine is checking the task. Try again when the command is ready.",
          );
        } else {
          setSection(null);
          setReason("");
        }
      },
      (error: unknown) => setNotice(errorText(error)),
    );
  };
  const availability = (name: RustNext["commands"][number]["name"]) =>
    commands?.commands.find((command) => command.name === name)?.preflight;
  const offered = (name: RustNext["commands"][number]["name"]) => {
    const status = availability(name);
    return status === "ready" || status === "pending";
  };
  const moves =
    commands?.commands.flatMap((command) =>
      command.name === "move" && command.preflight !== "unavailable"
        ? [
            {
              value: command.phase,
              label: rustPhaseLabels[command.phase],
              detail:
                command.preflight === "pending" ? "Check required" : undefined,
            },
          ]
        : [],
    ) ?? [];
  const toggle = (value: Section) =>
    setSection((current) => (current === value ? null : value));
  const phaseView = commands ?? card;
  const wait = phaseView ? rustWaitText(phaseView) : null;

  return (
    <Dialog
      c={c}
      wide
      inline={inline}
      title={card ? rustTaskLabel(card) : id}
      label="Task detail"
      bodyLabel="Task"
      closeLabel="Close task"
      onClose={onClose}
      backdropLabel="Close task"
      eyebrow={card && <Text style={muted(c)}>{card.identity.repository}</Text>}
    >
      {task.error && (
        <ReadError error={task.error} retry={() => void task.refetch()} c={c} />
      )}
      {!detail && !task.error && <Text style={muted(c)}>Loading task…</Text>}
      {detail && (
        <>
          <TaskDetailTabs tab={tab} onSelect={setTab} compact={compact} c={c} />
          {notice && (
            <Text accessibilityRole="alert" style={{ color: c.statusWarning }}>
              {notice}
            </Text>
          )}
          {tab === "overview" && (
            <>
              <DetailSection
                c={c}
                title={rustPhaseLabels[(phaseView ?? detail).phase]}
              >
                {wait && <Text style={muted(c)}>{wait}</Text>}
                {detail.hold?.reason && (
                  <Text selectable style={{ color: c.foreground }}>
                    {detail.hold.reason}
                  </Text>
                )}
                {delivery && (
                  <Text selectable style={{ color: c.foreground }}>
                    {delivery.summary} · {delivery.artifact.key} v{delivery.artifact.version}
                  </Text>
                )}
                {detail.report?.failure && (
                  <Text selectable style={{ color: c.foreground }}>
                    {detail.report.failure}
                  </Text>
                )}
                {detail.run && <RunActivity run={detail.run} c={c} />}
              </DetailSection>
              {visibleQuestion && (
                <QuestionSection
                  key={JSON.stringify(visibleQuestion)}
                  question={visibleQuestion}
                  c={c}
                  enabled={offered("answer") && section !== "amend"}
                  busy={busy}
                  onAnswer={run}
                />
              )}
              {next.error && (
                <ReadError
                  error={next.error}
                  retry={() => void next.refetch()}
                  c={c}
                />
              )}
              {(commands || section === "amend") && (
                <DetailSection c={c} title="Actions">
                  <View style={{ ...row, gap: space.xs }}>
                    {moves.length > 0 && (
                      <DropdownSelect
                        c={c}
                        compact
                        hideLabel
                        label="Move"
                        placeholder="Move"
                        value=""
                        options={moves}
                        disabled={busy || section === "amend"}
                        onChange={(value) => {
                          const move = moves.find(
                            (option) => option.value === value,
                          );
                          if (move) run({ move: move.value });
                        }}
                      />
                    )}
                    {offered("complete") && delivery && (
                      <Button
                        c={c}
                        small
                        text="Complete"
                        selected={section === "complete"}
                        disabled={busy}
                        onPress={() => toggle("complete")}
                      />
                    )}
                    {offered("move_work") && (
                      <Button
                        c={c}
                        small
                        text="Return to work"
                        selected={section === "move_work"}
                        disabled={busy}
                        onPress={() => toggle("move_work")}
                      />
                    )}
                    {(offered("amend") || section === "amend") && (
                      <Button
                        c={c}
                        small
                        text="Amend"
                        selected={section === "amend"}
                        disabled={busy}
                        onPress={() => toggle("amend")}
                      />
                    )}
                    {offered("hold") && (
                      <Button
                        c={c}
                        small
                        text="Hold"
                        selected={section === "hold"}
                        disabled={busy || section === "amend"}
                        onPress={() => toggle("hold")}
                      />
                    )}
                    {offered("release") && (
                      <Button
                        c={c}
                        small
                        text="Release"
                        disabled={busy || section === "amend"}
                        onPress={() => run("release")}
                      />
                    )}
                    {offered("cancel") && (
                      <Button
                        c={c}
                        small
                        text="Cancel"
                        selected={section === "cancel"}
                        disabled={busy || section === "amend"}
                        onPress={() => toggle("cancel")}
                      />
                    )}
                  </View>
                  {((section === "complete" && delivery && offered("complete")) ||
                    (section === "move_work" && offered("move_work"))) && (
                    <>
                      <Field
                        c={c}
                        label={section === "complete" ? "Acceptance reason" : "Revision instruction"}
                        value={reason}
                        onChange={setReason}
                        disabled={busy}
                      />
                      <Button
                        c={c}
                        small
                        text={section === "complete" ? "Accept report" : "Send instruction"}
                        disabled={busy || !reason.trim()}
                        onPress={() => {
                          if (section === "complete" && delivery) {
                            run({ complete: { version: detail.version, artifact: delivery.artifact, reason: reason.trim() } });
                          } else {
                            run({ move_work: { instruction: reason.trim() } });
                          }
                        }}
                      />
                    </>
                  )}
                  {section === "amend" && (
                    <BriefEditor detail={detail} c={c} submit={submit} />
                  )}
                  {section === "hold" && offered("hold") && (
                    <>
                      <Field
                        c={c}
                        label="Reason"
                        value={reason}
                        onChange={setReason}
                        disabled={busy}
                      />
                      <Button
                        c={c}
                        small
                        text="Hold"
                        disabled={busy}
                        onPress={() => run({ hold: reason.trim() })}
                      />
                    </>
                  )}
                  {section === "cancel" && offered("cancel") && (
                    <InlineConfirm
                      c={c}
                      question="Cancel this task?"
                      confirmLabel="Cancel"
                      label="task"
                      busy={busy}
                      onConfirm={() => run("cancel")}
                      onCancel={() => setSection(null)}
                    />
                  )}
                </DetailSection>
              )}
            </>
          )}
          {tab === "activity" && (
            <>
              {history.error && (
                <ReadError
                  error={history.error}
                  retry={() => void history.refetch()}
                  c={c}
                />
              )}
              {history.isPending && !history.error && (
                <Text style={muted(c)}>Loading activity…</Text>
              )}
              <ActivityHistory pages={history.data?.pages ?? []} c={c} />
              {history.hasNextPage && (
                <Button
                  c={c}
                  small
                  text="More"
                  label="More activity"
                  disabled={history.isFetching}
                  onPress={() => void history.fetchNextPage()}
                />
              )}
              {history.data &&
                !history.hasNextPage &&
                !history.data.pages.some((page) =>
                  page.some((event) => event.presentation.length),
                ) && <Text style={muted(c)}>No activity yet.</Text>}
            </>
          )}
          {tab === "details" && (
            <>
              <DetailSection c={c} title="Brief">
                <Text selectable style={{ color: c.foreground }}>
                  {detail.brief.text}
                </Text>
              </DetailSection>
              <DetailSection c={c} title="Repository">
                <DetailField
                  c={c}
                  compact={compact}
                  label="Base"
                  value={detail.identity.base}
                />
                {detail.pullRequest && (
                  <>
                    <PullRequestLink url={detail.pullRequest.url} c={c} />
                    <DetailField
                      c={c}
                      compact={compact}
                      label="Head"
                      value={detail.pullRequest.head}
                    />
                  </>
                )}
                {detail.verdict && (
                  <VerdictText verdict={detail.verdict} c={c} />
                )}
              </DetailSection>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

function BriefEditor({
  detail,
  c,
  submit,
}: {
  detail: RustTaskDetail;
  c: Colors;
  submit: (command: RustCommand) => Promise<CommandOutcome>;
}) {
  const [draft, setDraft] = useState(detail.brief.text);
  const baseline = useRef(detail.brief.version);
  const { invalid, enqueue, status, failed } = useSectionAutoSave(
    async (text: string) => {
      if (baseline.current < detail.brief.version) {
        throw new Error(
          "The brief changed. Reopen Amend to edit the latest version.",
        );
      }
      const outcome = await submit({ amend: text });
      if ("status" in outcome)
        throw new Error(
          "The engine is checking the task. Try again when ready.",
        );
      baseline.current++;
    },
  );
  const change = (text: string, delay: number) => {
    setDraft(text);
    if (text.trim()) enqueue(text, delay);
    else invalid("A brief is required.");
  };
  return (
    <View style={{ gap: space.xs }}>
      <LabelHelp c={c} label="Brief" text="Edits save automatically." />
      <Field
        c={c}
        label="Brief"
        hideLabel
        value={draft}
        multiline
        onChange={(text) => change(text, 650)}
      />
      <SaveStatus c={c} label="Brief" status={status} />
      {failed && draft.trim() && (
        <Button c={c} small text="Retry" onPress={() => change(draft, 0)} />
      )}
    </View>
  );
}

function QuestionSection({
  question,
  c,
  enabled,
  busy,
  onAnswer,
}: {
  question: RustQuestion;
  c: Colors;
  enabled: boolean;
  busy: boolean;
  onAnswer: (command: RustCommand) => void;
}) {
  const [answer, setAnswer] = useState("");
  const choices = "work" in question ? question.work.options : [];
  let command: RustCommand;
  if ("retry" in question) command = { answer: "retry" };
  else if ("accept" in question)
    command = {
      answer: { accept: { head: question.accept.head, reason: answer.trim() } },
    };
  else command = { answer: { work: choices.length ? answer : answer.trim() } };
  return (
    <DetailSection c={c} title="Question">
      <Text selectable style={{ color: c.foreground }}>
        {rustQuestionText(question)}
      </Text>
      {"accept" in question && (
        <DetailField c={c} compact label="Head" value={question.accept.head} />
      )}
      {enabled && (
        <>
          {choices.length > 0 ? (
            <DropdownSelect
              c={c}
              label="Option"
              placeholder="Select"
              value={answer}
              options={choices.map((label) => ({ value: label, label }))}
              disabled={busy}
              onChange={setAnswer}
            />
          ) : (
            !("retry" in question) && (
              <Field
                c={c}
                label={"accept" in question ? "Reason" : "Guidance"}
                multiline
                value={answer}
                onChange={setAnswer}
                disabled={busy}
              />
            )
          )}
          <Button
            c={c}
            small
            text="Answer"
            disabled={busy || (!("retry" in question) && !answer.trim())}
            onPress={() => onAnswer(command)}
          />
        </>
      )}
    </DetailSection>
  );
}

const roleLabel = { worker: "Worker", reviewer: "Reviewer" };

function RunActivity({
  run,
  c,
}: {
  run: NonNullable<RustTaskDetail["run"]>;
  c: Colors;
}) {
  const began = run.activity?.startedAt ?? run.lastSendAt ?? run.reservedAt;
  return (
    <View style={{ gap: space.xxs }}>
      <Text style={{ color: c.foreground }}>
        {[roleLabel[run.role], run.purpose].join(" · ")}
      </Text>
      {run.activity && <Text style={muted(c)}>{run.activity.label}</Text>}
      <DetailField c={c} compact label="Thread" value={run.thread} />
      <Text
        style={muted(c)}
      >{`Started ${new Date(began).toLocaleString()}`}</Text>
    </View>
  );
}

function PullRequestLink({ c, url }: { c: Colors; url: string }) {
  return (
    <TextLink
      c={c}
      text={url}
      label="Open pull request"
      onPress={() => void Linking.openURL(url)}
    />
  );
}

function VerdictText({ c, verdict }: { c: Colors; verdict: RustVerdict }) {
  const state =
    "accepted" in verdict
      ? "Accepted"
      : verdict.reviewed.decision === "approve"
        ? "Approved"
        : "Changes requested";
  const notes =
    "accepted" in verdict
      ? verdict.accepted.acceptance.reason
      : verdict.reviewed.summary;
  const head =
    "accepted" in verdict ? verdict.accepted.head : verdict.reviewed.head;
  return (
    <View style={{ gap: space.xxs }}>
      <Text selectable style={{ color: c.foreground }}>
        {state}
      </Text>
      {notes && (
        <Text selectable style={muted(c)}>
          {notes}
        </Text>
      )}
      <DetailField c={c} compact label="Reviewed head" value={head} />
    </View>
  );
}

function ActivityHistory({
  pages,
  c,
}: {
  pages: readonly RustHistoryPage[];
  c: Colors;
}) {
  const entries = pages.flat();
  const ended = new Set(
    entries.flatMap(({ presentation }) =>
      presentation.flatMap((record) =>
        record.kind === "run_ended" ? [record.instance] : [],
      ),
    ),
  );
  return entries.flatMap(({ content, sequence, presentation }) =>
    presentation
      .map((record, position) => {
        let body;
        switch (record.kind) {
          case "run_ended":
            return null;
          case "run_started":
            body = (
              <>
                <Text style={{ color: c.foreground }}>
                  {[roleLabel[record.role], record.purpose].join(" · ")}
                </Text>
                <Text style={muted(c)}>
                  {ended.has(record.instance) ? "Finished" : "Started"}
                </Text>
              </>
            );
            break;
          case "pull_request":
            body = <PullRequestLink c={c} url={record.url} />;
            break;
          case "verdict":
            body = <VerdictText c={c} verdict={record.verdict} />;
            break;
          case "question":
            body = (
              <Text selectable style={{ color: c.foreground }}>
                {rustQuestionText(record.question)}
              </Text>
            );
            break;
          case "merged":
            body = (
              <DetailField c={c} compact label="Merged" value={record.commit} />
            );
            break;
          case "finished":
            body = (
              <Text style={{ color: c.foreground }}>
                {rustPhaseLabels[record.phase]}
              </Text>
            );
            break;
        }
        return (
          <DetailSection c={c} key={`${sequence}:${position}`}>
            {body}
            <Text style={muted(c)}>
              {new Date(content.at).toLocaleString()}
            </Text>
          </DetailSection>
        );
      })
      .reverse(),
  );
}

function ReadError({
  c,
  error,
  retry,
}: {
  c: Colors;
  error: unknown;
  retry: () => void;
}) {
  return (
    <View style={{ ...row, gap: space.xs }}>
      <Text
        accessibilityRole="alert"
        style={{ color: c.statusWarning, flexShrink: 1 }}
      >
        {errorText(error)}
      </Text>
      <Button c={c} small text="Retry" onPress={retry} />
    </View>
  );
}
