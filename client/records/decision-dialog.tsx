import { Markdown } from "../markdown";
import { useContext, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { BoardLiveContext } from "../board-live";
import {
  Button,
  ConfirmReplaceAnswer,
  DetailSection,
  SurfacePress,
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
import {
  type as typeScale,
  space,
  radius,
  roles,
  toneWash,
} from "../design";

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
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [pendingDecisionOption, setPendingDecisionOption] = useState<
    string | null
  >(null);
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
  const identified = decisionDetailPresentation?.identified ?? false;
  const typedAnswer = decisionAnswerText.trim();
  const optionId = choices.find((choice) => choice.optionId === selectedOptionId)?.optionId;
  const answer = identified
    ? optionId ? { optionId } : null
    : typedAnswer ? { answer: typedAnswer } : null;
  const recordedAnswer = decisionDetail?.answer;
  const recordedOption = recordedAnswer && "optionId" in recordedAnswer
    ? choices.find((choice) => choice.optionId === recordedAnswer.optionId)
    : undefined;
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
            {decisionProjectLabel(decisionDetail)} ·{" "}
            {decisionDetail.askerLabel ?? UNKNOWN_ASKER_LABEL} ·{" "}
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
            <Markdown text={decisionDetail.headline ?? decisionDetail.question} c={c} />
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
              <View style={{ gap: space.xs }}>
                {choices.map((choice) => (
                  <SurfacePress
                    key={choice.optionId ?? choice.label}
                    c={c}
                    label={`Use option: ${choice.displayLabel}${choice.label === recommended ? ", recommended" : ""}`}
                    selected={choice.optionId ? selectedOptionId === choice.optionId : decisionAnswerText === choice.label}
                    onPress={() => {
                      if (choice.optionId) {
                        setSelectedOptionId(choice.optionId);
                        return;
                      }
                      if (
                        decisionAnswerText.trim() &&
                        decisionAnswerText !== choice.label
                      )
                        setPendingDecisionOption(choice.label);
                      else setDecisionAnswerText(choice.label);
                    }}
                    style={{
                      paddingHorizontal: space.xs,
                      paddingVertical: space.xs,
                      backgroundColor: roles(c).raised,
                    }}
                  >
                    <Text
                      style={{
                        color: c.foreground,
                        fontSize: typeScale.metadata.fontSize,
                        lineHeight: typeScale.metadata.lineHeight,
                      }}
                    >
                      {choice.label === recommended
                        ? "★ Recommended · "
                        : ""}
                      {choice.displayLabel}
                      {choice.consequence ? ` — ${choice.consequence}` : ""}
                    </Text>
                  </SurfacePress>
                ))}
              </View>
              <ConfirmReplaceAnswer
                c={c}
                option={pendingDecisionOption}
                onCancel={() => setPendingDecisionOption(null)}
                onConfirm={() => {
                  setDecisionAnswerText(pendingDecisionOption ?? "");
                  setPendingDecisionOption(null);
                }}
              />
            </DetailSection>
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
          <DetailSection title="Links" c={c}>
            {!decisionDetail.links.tasks.length &&
              !decisionDetail.links.leads.length &&
              !decisionDetail.links.papercuts.length && (
                <Text style={muted(c)}>None</Text>
              )}
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
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
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
          {decisionDetail.status !== "open" && (
            <DetailSection
              title={
                decisionDetail.status === "answered"
                  ? "Answer"
                  : decisionDetail.status === "withdrawn"
                    ? "Withdrawn"
                    : "Superseded"
              }
              c={c}
            >
              {decisionDetail.answer && (
                <>
                  <Text
                    selectable
                    style={{
                      color: c.foreground,
                      fontSize: typeScale.body.fontSize,
                      lineHeight: typeScale.body.lineHeight,
                    }}
                  >
                    {recordedOption?.displayLabel ?? decisionDetail.answer.text}
                  </Text>
                  <Text
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    {decisionDetail.answer.answeredBy} ·{" "}
                    {new Date(
                      decisionDetail.answer.answeredAt,
                    ).toLocaleString()}
                    {decisionDetail.answer.relayed
                      ? " · relayed"
                      : " · operator authority"}
                  </Text>
                </>
              )}
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
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Replaced by {decisionDetail.supersededBy}
                </Text>
              )}
            </DetailSection>
          )}
          {decisionDetail.status === "open" && (
            <DetailSection title="Answer" c={c}>
              {!identified && <TextInput
                accessibilityLabel="Operator answer"
                multiline
                value={decisionAnswerText}
                onChangeText={setDecisionAnswerText}
                placeholder="The operator's ruling, delivered to the asking agent"
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
              />}
              <Button
                small
                c={c}
                text="Answer"
                disabled={busy || !answer}
                onPress={() => {
                  if (!answer) return;
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
                    setSelectedOptionId(null);
                  }, "record");
                }}
              />
              <Text
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                Answering carries operator authority and notifies the asking
                agent's thread once per answer.
              </Text>
            </DetailSection>
          )}
        </>
      )}
    </RecordModal>
  );
}
