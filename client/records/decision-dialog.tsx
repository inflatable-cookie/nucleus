import { Markdown } from "../markdown";
import { useContext, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Icon, useRpc } from "../shell";
import { BoardLiveContext } from "../board-live";
import {
  Button,
  ConfirmReplaceAnswer,
  DetailSection,
  HelpTip,
  HelpPopover,
  SurfacePress,
  row,
  muted,
  type Colors,
} from "../controls";
import * as api from "../../shared/contracts";
import { decisionAge } from "../../shared/pipeline-board";
import {
  UNKNOWN_ASKER_LABEL,
  decisionProjectLabel,
} from "../../shared/decision-project";
import { decisionChoicePresentation } from "../board/cards";
import {
  CollapsibleSection,
  RecordNotice,
  type BoardAct,
  type RecordNoticeValue,
} from "../task/parts";
import { RecordModal } from "./record-modal";
import { type as typeScale, space, radius, roles, toneWash } from "../design";

/**
 * The decision dialog (Spec 032). It owns its answer, withdraw reason, pending option and
 * details toggle; the board remounts it per decision, so they clear when it moves to another.
 */
export function DecisionDialog({
  id: openDecisionId,
  project,
  compact,
  busy,
  act,
  recordNotice,
  setRecordNotice,
  onOpenDecision,
  onOpenTask,
  taskLinkLabel = () => null,
  onClose,
  c,
  inline = false,
}: {
  inline?: boolean;
  id: string;
  project?: string;
  /** A linked task's reference, title and project, resolved from the board (nucleus#1515). */ taskLinkLabel?: (
    id: string,
  ) => string | null;
  compact: boolean;
  busy: boolean;
  act: BoardAct;
  recordNotice: RecordNoticeValue | null;
  setRecordNotice: (notice: RecordNoticeValue | null) => void;
  onOpenDecision: (id: string) => void;
  onOpenTask: (id: string) => void;
  onClose: () => void;
  c: Colors;
}) {
  const live = useContext(BoardLiveContext);
  const scope = project ? { project } : {};
  const fetchDecision = useRpc(api.decisionGet),
    answerDecision = useRpc(api.decisionAnswer);
  const [decisionDetailsOpen, setDecisionDetailsOpen] = useState(false);
  const [decisionAnswerText, setDecisionAnswerText] = useState("");
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [pendingDecisionOption, setPendingDecisionOption] = useState<
    string | null
  >(null);
  const [answerHelpOpen, setAnswerHelpOpen] = useState(false);
  const answerAnchor = useRef<View | null>(null);
  const decisionDetailQuery = useQuery({
    queryKey: ["nucleus", "decision", openDecisionId, project],
    queryFn: () => fetchDecision({ ...scope, id: openDecisionId! }),
    enabled: Boolean(openDecisionId),
    refetchInterval: live ? false : 4000,
  });
  const decisionDetail = decisionDetailQuery.data;
  const decisionDetailPresentation = decisionDetail
    ? decisionChoicePresentation(decisionDetail)
    : null;
  const choices = decisionDetailPresentation?.choices ?? [];
  const recommended = decisionDetailPresentation?.recommended;
  const gate = decisionDetail?.gate ?? false;
  const choiceText = (choice: (typeof choices)[number]) =>
    choice.label.replace(/\s*\(recommended\)\s*$/i, "");
  const choiceKey = (choice: (typeof choices)[number]) =>
    choice.optionId ?? choice.label;
  const selected = choices.find(
    (choice) => choiceKey(choice) === selectedChoice,
  );
  const pendingChoice = choices.find(
    (choice) => choiceKey(choice) === pendingDecisionOption,
  );
  const edited = Boolean(
    selected && decisionAnswerText !== choiceText(selected),
  );
  const typedAnswer = decisionAnswerText.trim();
  const answer = !typedAnswer
    ? null
    : selected?.optionId && !edited
      ? { optionId: selected.optionId }
      : {
          answer: typedAnswer,
          ...(selected?.optionId ? { basedOnOptionId: selected.optionId } : {}),
        };
  const recordedAnswer = decisionDetail?.answer;
  const recordedOption =
    recordedAnswer && "optionId" in recordedAnswer
      ? choices.find((choice) => choice.optionId === recordedAnswer.optionId)
      : choices.find(
          (choice) =>
            !choice.optionId && choiceText(choice) === recordedAnswer?.text,
        );
  const selectChoice = (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    if (
      decisionAnswerText.trim() &&
      decisionAnswerText !== choiceText(choice) &&
      (!selected || edited)
    ) {
      setPendingDecisionOption(choiceKey(choice));
      return;
    }
    setSelectedChoice(choiceKey(choice));
    setDecisionAnswerText(choiceText(choice));
  };
  const submitAnswer = () => {
    if (!answer || busy || !decisionDetail || (gate && !("optionId" in answer)))
      return;
    void act(async () => {
      await answerDecision({
        ...scope,
        id: decisionDetail.id,
        version: decisionDetail.version,
        ...answer,
        answeredBy: "operator (board)",
        relayed: false,
        note: "",
      });
      setRecordNotice({ kind: "ok", text: "Answered" });
      setDecisionAnswerText("");
      setSelectedChoice(null);
    }, "record");
  };
  const decisionDetailsContent = decisionDetail
    ? [
        ...new Set(
          [
            decisionDetail.question.length > 140 &&
            decisionDetail.question !==
              (decisionDetail.headline ?? decisionDetail.question)
              ? `Full question: ${decisionDetail.question}`
              : null,
            decisionDetail.details,
            decisionDetail.context,
            decisionDetail.recommendation,
            // A fallback asker names no thread: keep the full identity selectable here for forensics.
            decisionDetail.askerLabel === UNKNOWN_ASKER_LABEL
              ? `Asking thread: ${decisionDetail.askedBy.agentId}`
              : null,
          ].filter((part): part is string => Boolean(part)),
        ),
      ].join("\n\n")
    : "";
  return (
    <RecordModal
      label="Decision detail"
      inline={inline}
      title="Decision"
      compact={compact}
      c={c}
      onClose={onClose}
      eyebrow={
        decisionDetail ? (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {decisionDetail.status}
            {decisionDetail.stale ? " · stale" : ""} ·{" "}
            {decisionDetail.projectName ?? decisionProjectLabel(decisionDetail)}{" "}
            · {decisionDetail.askerLabel ?? UNKNOWN_ASKER_LABEL} ·{" "}
            {decisionAge(decisionDetail.createdAt)}
          </Text>
        ) : undefined
      }
    >
      {decisionDetailQuery.isLoading && !decisionDetail && (
        <Text style={muted(c)}>Loading decision…</Text>
      )}
      {decisionDetailQuery.error && (
        <Text
          accessibilityRole="alert"
          style={{
            color: c.statusDanger,
            fontSize: typeScale.metadata.fontSize,
          }}
        >
          {String(decisionDetailQuery.error)}
        </Text>
      )}
      {decisionDetail && (
        <>
          <RecordNotice notice={recordNotice} c={c} />
          {decisionDetail.stale && decisionDetail.status === "open" && (
            <Text
              accessibilityRole="alert"
              style={{
                color: c.statusWarning,
                fontSize: typeScale.metadata.fontSize,
              }}
            >
              Stale: every linked task, lead and papercut has finished.
            </Text>
          )}
          <DetailSection title="Question" c={c}>
            <Markdown
              text={decisionDetail.headline ?? decisionDetail.question}
              c={c}
            />
          </DetailSection>
          {decisionDetailsContent && (
            <CollapsibleSection
              title="Details"
              open={decisionDetailsOpen}
              onToggle={() => setDecisionDetailsOpen((value) => !value)}
              c={c}
            >
              <Markdown text={decisionDetailsContent} c={c} />
            </CollapsibleSection>
          )}
          {choices.length > 0 && (
            <DetailSection title="Choices" c={c}>
              <View accessibilityRole="radiogroup" style={{ gap: space.xs }}>
                {choices.map((choice, index) => {
                  const chosen =
                    decisionDetail.status === "answered" &&
                    recordedOption === choice;
                  const active =
                    decisionDetail.status === "open" &&
                    selectedChoice === choiceKey(choice);
                  const dimmed =
                    decisionDetail.status === "answered" &&
                    Boolean(recordedOption) &&
                    !chosen;
                  return (
                    <SurfacePress
                      key={choice.optionId ?? choice.label}
                      c={c}
                      role="radio"
                      selectionWash={false}
                      label={`Use option: ${choice.displayLabel}${choice.label === recommended ? ", recommended" : ""}${active && edited ? ", edited" : ""}`}
                      selected={active || chosen}
                      disabled={decisionDetail.status !== "open"}
                      onPress={() => selectChoice(index)}
                      onKeyDown={(event) => {
                        if (
                          [
                            "ArrowDown",
                            "ArrowRight",
                            "ArrowUp",
                            "ArrowLeft",
                          ].includes(event.key)
                        ) {
                          event.preventDefault();
                          const radios =
                            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                              '[role="radio"]',
                            );
                          const direction =
                            event.key === "ArrowDown" ||
                            event.key === "ArrowRight"
                              ? 1
                              : -1;
                          radios?.[
                            (index + direction + choices.length) %
                              choices.length
                          ]?.focus();
                        } else if (
                          event.key === " " ||
                          event.key === "Spacebar"
                        ) {
                          event.preventDefault();
                          selectChoice(index);
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          submitAnswer();
                        }
                      }}
                      style={{
                        ...row,
                        alignItems: "flex-start",
                        flexWrap: "nowrap",
                        gap: space.xs,
                        padding: space.sm,
                        borderWidth: 1,
                        borderColor: active || chosen ? c.accent : c.border,
                        backgroundColor:
                          active || chosen
                            ? toneWash(c.accent, roles(c).raised)
                            : roles(c).raised,
                        opacity: dimmed ? 0.55 : 1,
                      }}
                    >
                      <View>
                        <Icon
                          name={
                            chosen
                              ? "CircleCheck"
                              : active
                                ? edited
                                  ? "CircleDashed"
                                  : "CircleDot"
                                : "Circle"
                          }
                          size={16}
                          color={
                            active || chosen ? c.accent : c.foregroundMuted
                          }
                        />
                      </View>
                      <View style={{ flex: 1, gap: space.xxs }}>
                        <View
                          style={{ ...row, flexWrap: "wrap", gap: space.xs }}
                        >
                          <Text
                            style={{
                              color: c.foreground,
                              fontSize: typeScale.body.fontSize,
                              lineHeight: typeScale.body.lineHeight,
                              flexShrink: 1,
                            }}
                          >
                            {choice.displayLabel}
                          </Text>
                          {choice.label === recommended && (
                            <Text
                              style={{
                                color: c.accent,
                                fontSize: typeScale.metadata.fontSize,
                                fontWeight: "600",
                              }}
                            >
                              Recommended
                            </Text>
                          )}
                          {(chosen || (active && edited)) && (
                            <Text
                              style={{
                                color: c.accent,
                                fontSize: typeScale.metadata.fontSize,
                                fontWeight: "600",
                              }}
                            >
                              {chosen ? "Chosen" : "Edited"}
                            </Text>
                          )}
                        </View>
                        {choice.consequence ? (
                          <Text
                            style={{
                              ...muted(c),
                              fontSize: typeScale.metadata.fontSize,
                            }}
                          >
                            {choice.consequence}
                          </Text>
                        ) : null}
                      </View>
                    </SurfacePress>
                  );
                })}
              </View>
              <ConfirmReplaceAnswer
                c={c}
                option={pendingChoice ? choiceText(pendingChoice) : null}
                onCancel={() => setPendingDecisionOption(null)}
                onConfirm={() => {
                  if (pendingChoice) {
                    setSelectedChoice(choiceKey(pendingChoice));
                    setDecisionAnswerText(choiceText(pendingChoice));
                  }
                  setPendingDecisionOption(null);
                }}
              />
              {decisionDetail.status === "answered" && recordedAnswer && (
                <Text
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  {!recordedOption ? `${recordedAnswer.text} · ` : ""}
                  {recordedAnswer.answeredBy} ·{" "}
                  {recordedAnswer.answeredBy.toLowerCase().includes("inbox")
                    ? "Inbox"
                    : "Board"}{" "}
                  · {new Date(recordedAnswer.answeredAt).toLocaleString()}
                  {recordedAnswer.note ? ` · ${recordedAnswer.note}` : ""}
                </Text>
              )}
            </DetailSection>
          )}
          {choices.length === 0 &&
            decisionDetail.status === "answered" &&
            recordedAnswer && (
              <Text
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                {recordedAnswer.text} · {recordedAnswer.answeredBy} ·{" "}
                {recordedAnswer.answeredBy.toLowerCase().includes("inbox")
                  ? "Inbox"
                  : "Board"}{" "}
                · {new Date(recordedAnswer.answeredAt).toLocaleString()}
                {recordedAnswer.note ? ` · ${recordedAnswer.note}` : ""}
              </Text>
            )}
          {(decisionDetail.overtakenBy?.length ?? 0) > 0 && (
            <View
              style={{
                gap: space.xs,
                padding: space.sm,
                borderRadius: radius.card,
                backgroundColor: toneWash(c.statusWarning, roles(c).section),
              }}
            >
              <Text
                style={{
                  color: c.statusWarning,
                  fontWeight: "600",
                  fontSize: typeScale.body.fontSize,
                }}
              >
                Probably overtaken
              </Text>
              {decisionDetail.overtakenBy!.map((ref) => (
                <Pressable
                  key={`${ref.kind}:${ref.id}:${ref.sourceId ?? ""}`}
                  accessibilityRole="link"
                  accessibilityLabel={`View citing ${ref.kind === "brief_amendment" ? "brief amendment" : ref.kind === "planner_answer" ? "planner answer" : "answer"}: ${ref.label}`}
                  onPress={() => {
                    if (ref.kind === "decision_answer") onOpenDecision(ref.id);
                    else onOpenTask(ref.id);
                  }}
                >
                  <Text
                    style={{
                      color: c.accent,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                    }}
                  >
                    {ref.label}
                    {ref.sourceId ? ` · ${ref.sourceId}` : ` · ${ref.id}`}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {decisionDetail.links.tasks.length +
            decisionDetail.links.leads.length +
            decisionDetail.links.papercuts.length >
            0 && (
            <DetailSection title="Links" c={c}>
              {decisionDetail.links.tasks.map((id) => {
                const label = taskLinkLabel(id);
                return label ? (
                  <Pressable
                    key={`task-${id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open linked task ${label}`}
                    onPress={() => onOpenTask(id)}
                  >
                    <Text
                      style={{
                        color: c.accent,
                        fontSize: typeScale.metadata.fontSize,
                        lineHeight: typeScale.metadata.lineHeight,
                      }}
                    >
                      Task · {label}
                    </Text>
                  </Pressable>
                ) : (
                  <Text
                    key={`task-${id}`}
                    selectable
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Task · {id}
                  </Text>
                );
              })}
              {decisionDetail.links.leads.map((id) => (
                <Text
                  key={`lead-${id}`}
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Lead · {id}
                </Text>
              ))}
              {decisionDetail.links.papercuts.map((id) => (
                <Text
                  key={`cut-${id}`}
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Papercut · {id}
                </Text>
              ))}
            </DetailSection>
          )}
          {decisionDetail.status !== "open" &&
            decisionDetail.status !== "answered" && (
              <DetailSection
                title={
                  decisionDetail.status === "withdrawn"
                    ? "Withdrawn"
                    : "Superseded"
                }
                c={c}
              >
                {decisionDetail.withdrawal && (
                  <>
                    <Text
                      selectable
                      style={{
                        color: c.foreground,
                        fontSize: typeScale.body.fontSize,
                        lineHeight: typeScale.body.lineHeight,
                      }}
                    >
                      {decisionDetail.withdrawal.reason}
                    </Text>
                    <Text
                      style={{
                        ...muted(c),
                        fontSize: typeScale.metadata.fontSize,
                      }}
                    >
                      {decisionDetail.withdrawal.withdrawnBy} ·{" "}
                      {new Date(
                        decisionDetail.withdrawal.withdrawnAt,
                      ).toLocaleString()}
                    </Text>
                  </>
                )}
                {decisionDetail.supersededBy && (
                  <Text
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Replaced by {decisionDetail.supersededBy}
                  </Text>
                )}
              </DetailSection>
            )}
          {decisionDetail.status === "open" && (
            <DetailSection title="Answer" c={c}>
              <TextInput
                accessibilityLabel="Operator answer"
                multiline
                value={decisionAnswerText}
                editable={!gate}
                onChangeText={setDecisionAnswerText}
                placeholder="Pick an option or write your answer"
                placeholderTextColor={c.foregroundMuted}
                style={{
                  minHeight: 72,
                  textAlignVertical: "top",
                  color: c.foreground,
                  backgroundColor: c.surface0,
                  borderColor: c.border,
                  borderWidth: 1,
                  borderRadius: radius.control,
                  padding: space.xs,
                }}
              />
              <View ref={answerAnchor} style={{ ...row, gap: space.xs }}>
                <Button
                  c={c}
                  text="Answer"
                  selected
                  disabled={
                    busy || !answer || (gate && !("optionId" in answer))
                  }
                  onPress={submitAnswer}
                />
                <HelpTip
                  c={c}
                  label="Answer"
                  text={
                    gate
                      ? "This answer applies a gate, so it uses the option as written."
                      : "Answering carries operator authority and notifies the asking agent's thread once per answer."
                  }
                  open={answerHelpOpen}
                  onOpenChange={setAnswerHelpOpen}
                />
                {answerHelpOpen && (
                  <HelpPopover
                    c={c}
                    anchor={answerAnchor}
                    label="Answer"
                    text={
                      gate
                        ? "This answer applies a gate, so it uses the option as written."
                        : "Answering carries operator authority and notifies the asking agent's thread once per answer."
                    }
                  />
                )}
              </View>
            </DetailSection>
          )}
        </>
      )}
    </RecordModal>
  );
}
