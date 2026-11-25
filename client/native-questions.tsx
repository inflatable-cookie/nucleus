import { errorText } from "./error-text";
import React, { useState, useSyncExternalStore } from "react";
import { Text, TextInput, View } from "react-native";
import { Button, type Colors } from "./controls";
import { radius, roles, space, touchTarget, type as typeScale } from "./design";

export type NativeQuestion = { id: string; questions: { header: string; question: string; options: string[] }[] };
// The board's pending question snapshot is kept in memory.
let questionSnapshot: ReadonlyMap<string, NativeQuestion[]> = new Map();
const questionListeners = new Set<() => void>();
const subscribeQuestions = (listener: () => void) => { questionListeners.add(listener); return () => { questionListeners.delete(listener); }; };
const getQuestions = () => questionSnapshot;
export const webQuestionsForAgent = (agentId: string): NativeQuestion[] => questionSnapshot.get(agentId) ?? [];
function setAgentQuestions(id: string, questions: NativeQuestion[]) {
  if (JSON.stringify(questionSnapshot.get(id) ?? []) === JSON.stringify(questions)) return;
  const next = new Map(questionSnapshot);
  if (questions.length) next.set(id, questions); else next.delete(id);
  questionSnapshot = next;
  for (const listener of questionListeners) listener();
}
/** One pending question and the agent thread that asked it. */
export type TaskQuestionRequest = { agentId: string; request: NativeQuestion };
/**
 * The card and task detail share pending questions keyed by their asking thread.
 */
export function useTaskQuestionRequests(agentIds: string[], agentRefs?: string[]): TaskQuestionRequest[] {
  const snapshot = useSyncExternalStore(subscribeQuestions, getQuestions, getQuestions);
  return (webAnswer ? agentRefs ?? [] : agentIds).flatMap(agentId => (snapshot.get(agentId) ?? []).map(request => ({ agentId, request })));
}
export function useTaskQuestions(agentIds: string[], agentRefs?: string[]) {
  return useTaskQuestionRequests(agentIds, agentRefs).map(entry => entry.request);
}

let webAnswer: ((agentId: string, requestId: string, answers: Record<string, string>) => Promise<void>) | null = null;
/** Bind the board's answer transport. */
export function bindWebQuestions(answer: typeof webAnswer) {
  const changed = () => { questionSnapshot = new Map(questionSnapshot); for (const listener of questionListeners) listener(); };
  webAnswer = answer; changed();
  return () => { if (webAnswer === answer) { webAnswer = null; changed(); } };
}
export function updateWebQuestions(agentId: string, questions: NativeQuestion[]) { setAgentQuestions(agentId, questions); }
/** A failed refresh keeps the last known requests; only a successful empty read clears them. */
export async function refreshWebQuestions(agentId: string, read: () => Promise<NativeQuestion[]>, current: () => boolean = () => true): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const questions = await read();
    if (current()) updateWebQuestions(agentId, questions);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
export async function answerNativeQuestion(agentId: string, requestId: string, answers: Record<string, string>): Promise<void> {
  if (!webAnswer) throw Error("This board has no live question connection.");
  await webAnswer(agentId, requestId, answers);
}
/**
 * One pending request with its answer controls: an option chip per offered
 * choice, a free-text answer, and one submit. Every question needs an answer.
 */
export function NativeQuestionAnswer({ agentId, request, onAnswered, c }: { agentId: string; request: NativeQuestion; onAnswered: () => void; c: Colors }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = (header: string) => `${request.id}:${header}`;
  const complete = request.questions.every(question => answers[key(question.header)]?.trim());
  const submit = () => {
    if (!complete) return;
    setBusy(true); setError("");
    const values = Object.fromEntries(request.questions.map(question => [question.header, answers[key(question.header)].trim()]));
    answerNativeQuestion(agentId, request.id, values)
      .then(() => onAnswered())
      .catch(failure => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };
  return <View style={{ gap: space.xs }}>
    {request.questions.map(question => <View key={question.header} style={{ gap: space.xs }}>
      <Text accessibilityLabel={`Question ${question.header}: ${question.question}`} style={{ color: c.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, fontWeight: "600" }}>{question.question}</Text>
      {question.options.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{question.options.map(option =>
        <Button key={option} small wrap c={c} text={option} label={`Answer ${question.header}: ${option}`} selected={answers[key(question.header)] === option} disabled={busy}
          onPress={() => setAnswers(current => ({ ...current, [key(question.header)]: option }))} />)}</View>}
      <TextInput accessibilityLabel={`Answer ${question.header}`} value={answers[key(question.header)] ?? ""} editable={!busy}
        onChangeText={value => setAnswers(current => ({ ...current, [key(question.header)]: value }))}
        placeholder={question.options.length ? "Or type your answer" : "Your answer"} placeholderTextColor={c.foregroundMuted} multiline
        style={{ color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: radius.control, padding: space.xs, minHeight: touchTarget, fontSize: typeScale.body.fontSize }} />
    </View>)}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
      <Button small c={c} text={busy ? "Sending…" : "Submit answer"} label="Submit answer" disabled={busy || !complete}
        hint={busy ? "An answer is already being sent" : complete ? undefined : "Answer every question first"} onPress={submit} />
      {error !== "" && <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight, flexShrink: 1 }}>Answer not confirmed: {error}. Check the question before answering again.</Text>}
    </View>
  </View>;
}
