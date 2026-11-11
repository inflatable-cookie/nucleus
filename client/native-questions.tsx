import { observeAgents } from "./agent-observer";
import { errorText } from "./error-text";
import React, { useState, useSyncExternalStore } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { BoardHost, BoardPillContentProps, BoardPillRegistration } from "./shell";
import { Button, row, type Colors } from "./controls";
import { radius, roles, space, touchTarget, type as typeScale } from "./design";

export type NativeQuestion = { id: string; questions: { header: string; question: string; options: string[] }[] };
/** Only the daemon's current pending permissions are authoritative. */
export function nativeQuestions(pending: unknown): NativeQuestion[] {
  if (!Array.isArray(pending)) return [];
  return pending.flatMap(request => {
    if (!request || request.kind !== "question" || typeof request.id !== "string" || !Array.isArray(request.input?.questions)) return [];
    const questions = request.input.questions.flatMap((q: any) => typeof q?.header === "string" && typeof q?.question === "string" ? [{ header: q.header, question: q.question, options: Array.isArray(q.options) ? q.options.flatMap((o: any) => typeof o?.label === "string" ? [o.label] : []) : [] }] : []);
    return questions.length === request.input.questions.length && questions.length ? [{ id: request.id, questions }] : [];
  });
}

// The pill observer supplies one shared, in-memory view of daemon state. It is
// never persisted and is cleared when the plugin contribution stops.
let questionSnapshot: ReadonlyMap<string, NativeQuestion[]> = new Map();
const questionListeners = new Set<() => void>();
const subscribeQuestions = (listener: () => void) => { questionListeners.add(listener); return () => { questionListeners.delete(listener); }; };
const getQuestions = () => questionSnapshot;
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
 * Task 538: the task detail shows the same pending questions the card and the
 * pill read, keyed by the thread that asked them so an answer names its request.
 */
export function useTaskQuestionRequests(agentIds: string[], agentRefs?: string[]): TaskQuestionRequest[] {
  const snapshot = useSyncExternalStore(subscribeQuestions, getQuestions, getQuestions);
  return (webAnswer ? agentRefs ?? [] : agentIds).flatMap(agentId => (snapshot.get(agentId) ?? []).map(request => ({ agentId, request })));
}
export function useTaskQuestions(agentIds: string[], agentRefs?: string[]) {
  return useTaskQuestionRequests(agentIds, agentRefs).map(entry => entry.request);
}

/**
 * The pill observer owns the one Paseo client this plugin was given. A surface
 * that shows the same native question answers through that client and the same
 * request, so answering here or in the pill resolves it once; nothing here opens
 * a second channel or records a second decision.
 */
let questionClient: BoardHost | null = null;
let webAnswer: ((agentId: string, requestId: string, answers: Record<string, string>) => Promise<void>) | null = null;
/** Web observes task-owned threads without registering composer pills. */
export function bindWebQuestions(answer: typeof webAnswer) {
  const changed = () => { questionSnapshot = new Map(questionSnapshot); for (const listener of questionListeners) listener(); };
  webAnswer = answer; changed();
  return () => { if (webAnswer === answer) { webAnswer = null; changed(); } };
}
export function updateWebQuestions(agentId: string, questions: NativeQuestion[]) { setAgentQuestions(agentId, questions); }
export async function answerNativeQuestion(agentId: string, requestId: string, answers: Record<string, string>): Promise<void> {
  if (webAnswer) return webAnswer(agentId, requestId, answers);
  const client = questionClient;
  if (!client) throw Error("The question is answerable in its pill on the thread; this surface has no live question client.");
  await client.agents.ref(agentId).respondToPermission({ requestId, response: { behavior: "allow", updatedInput: { answers } } });
}
/**
 * One pending request with its answer controls: an option chip per offered
 * choice, a free-text answer, and one submit. Every question must be answered
 * before submit, exactly as the pill requires.
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
  return <View style={{ gap: 8 }}>
    {request.questions.map(question => <View key={question.header} style={{ gap: 6 }}>
      <Text accessibilityLabel={`Question ${question.header}: ${question.question}`} style={{ color: c.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, fontWeight: "600" }}>{question.question}</Text>
      {question.options.length > 0 && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{question.options.map(option =>
        <Button key={option} small wrap c={c} text={option} label={`Answer ${question.header}: ${option}`} selected={answers[key(question.header)] === option} disabled={busy}
          onPress={() => setAnswers(current => ({ ...current, [key(question.header)]: option }))} />)}</View>}
      <TextInput accessibilityLabel={`Answer ${question.header}`} value={answers[key(question.header)] ?? ""} editable={!busy}
        onChangeText={value => setAnswers(current => ({ ...current, [key(question.header)]: value }))}
        placeholder={question.options.length ? "Or type your answer" : "Your answer"} placeholderTextColor={c.foregroundMuted} multiline
        style={{ color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: radius.control, padding: space.xs, minHeight: touchTarget, fontSize: typeScale.body.fontSize }} />
    </View>)}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <Button small c={c} text={busy ? "Sending…" : "Submit answer"} label="Submit answer" disabled={busy || !complete}
        hint={busy ? "An answer is already being sent" : complete ? undefined : "Answer every question first"} onPress={submit} />
      {error !== "" && <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight, flexShrink: 1 }}>Answer not confirmed: {error}. Check the question before answering again.</Text>}
    </View>
  </View>;
}

type AgentEntry = { id: string; workspaceId?: string | null; pendingPermissions?: unknown };

/** The pill is a view of the native request, never a second decision record. */
export function registerNativeQuestionPills(client: BoardHost, refreshMs = 4000) {
  questionClient = client;
  const agents = new Map<string, AgentEntry>();
  const pills = new Map<string, BoardPillRegistration>();
  const remove = (id: string) => { pills.get(id)?.remove(); pills.delete(id); };
  function Popover(props: BoardPillContentProps) {
    if (props.context !== "agent") return null;
    const { agentId, theme } = props;
    const questions = useTaskQuestions([agentId]);
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const c = theme.colors;
    return <View style={{ gap: space.sm, width: "100%" }}>
      <Text style={{ color: c.foreground, fontWeight: "600", fontSize: typeScale.section.fontSize, lineHeight: typeScale.section.lineHeight }}>Questions for you</Text>
      {error !== "" && <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight }}>{error}</Text>}
      {questions.length === 0 && <Text style={{ color: c.foregroundMuted, fontSize: typeScale.body.fontSize }}>No open questions.</Text>}
      {questions.map(request => <View key={request.id} style={{ gap: space.sm }}>
        {request.questions.map(q => <View key={q.header} style={{ gap: space.xs }}>
          <Text accessibilityLabel={`Question ${q.question}`} style={{ color: c.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight }}>{q.question}</Text>
          {q.options.length > 0 && <View style={{ ...row, gap: space.xs }}>{q.options.map(option =>
            <Button key={option} small wrap c={c} text={option} label={`Answer ${q.question}: ${option}`} selected={answers[`${request.id}:${q.header}`] === option} disabled={busy}
              onPress={() => setAnswers(old => ({ ...old, [`${request.id}:${q.header}`]: option }))} />)}</View>}
          <TextInput accessibilityLabel={`Answer ${q.question}`} value={answers[`${request.id}:${q.header}`] ?? ""} editable={!busy}
            onChangeText={value => setAnswers(old => ({ ...old, [`${request.id}:${q.header}`]: value }))}
            placeholder={q.options.length ? "Or type your answer" : "Your answer"} placeholderTextColor={c.foregroundMuted} multiline
            style={{ color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: radius.control, padding: space.xs, minHeight: touchTarget, fontSize: typeScale.body.fontSize }} />
        </View>)}
        {(() => {
          const missing = request.questions.some(q => !answers[`${request.id}:${q.header}`]?.trim());
          return <Button small c={c} text={busy ? "Sending…" : "Submit answers"} label="Submit answers" disabled={busy || missing}
            hint={busy ? "An answer is already being sent" : missing ? "Answer every question first" : undefined} onPress={() => {
              setBusy(true); setError("");
              const values = Object.fromEntries(request.questions.map(q => [q.header, answers[`${request.id}:${q.header}`].trim()]));
              void client.agents.ref(agentId).respondToPermission({ requestId: request.id, response: { behavior: "allow", updatedInput: { answers: values } } }).then(async () => {
                const result = await client.agents.ref(agentId).refresh();
                if (result?.agent) update(result.agent);
              }).catch(err => setError(`Answer not confirmed: ${errorText(err)}. Check the question before answering again.`)).finally(() => setBusy(false));
            }} />;
        })()}
      </View>)}
    </View>;
  }
  function update(agent: AgentEntry) {
    // A ref refresh may omit permissions. Only an explicit inventory value
    // replaces the last authoritative set, including an update during an answer.
    const previous = agents.get(agent.id);
    agent = { ...previous, ...agent, pendingPermissions: agent.pendingPermissions === undefined ? previous?.pendingPermissions : agent.pendingPermissions };
    agents.set(agent.id, agent);
    if (agent.pendingPermissions === undefined) return;
    const questions = nativeQuestions(agent.pendingPermissions);
    setAgentQuestions(agent.id, questions);
    const count = questions.length;
    if (!count || !agent.workspaceId) { remove(agent.id); return; }
    const label = count === 1 ? "1 question" : `${count} questions`;
    const pill = pills.get(agent.id);
    if (pill) { pill.update({ title: label, label }); return; }
    pills.set(agent.id, client.addComposerPill({ id: `native-question-${agent.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, workspaceId: agent.workspaceId, agentId: agent.id, button: { title: label, label, icon: "MessageCircle", behavior: { kind: "popover", Content: Popover } } }));
  }
  const stop = observeAgents(client, event => {
    if (event.kind === "upsert") update(event.agent);
    else { agents.delete(event.agentId); setAgentQuestions(event.agentId, []); remove(event.agentId); }
  }, refreshMs);
  return () => { stop(); if (questionClient === client) questionClient = null; for (const id of agents.keys()) setAgentQuestions(id, []); for (const id of pills.keys()) remove(id); };
}
