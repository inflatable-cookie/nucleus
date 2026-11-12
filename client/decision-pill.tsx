import { observeAgents } from "./agent-observer";
import { readDecisions, clearDecisionRead } from "./decision-read";
import { domainRevision } from "./board-state";
import { errorText } from "./error-text";
import React, { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { BoardHost, BoardPillContentProps, BoardPillRegistration } from "./shell";
import { Icon } from "./shell";
import * as api from "../shared/contracts";
import type { DecisionView } from "../shared/contracts";
import { decisionProjectLabel } from "../shared/decision-project";
import { Button, ConfirmReplaceAnswer, muted, row } from "./controls";
import { radius, roles, touchSlop, touchTarget, type as typeScale, space } from "./design";

/**
 * Spec 032: while any decision is open, every thread's composer shows a pill
 * with the open count for that thread's project and for all projects ("1 here ·
 * 3 all"; "3 decisions" for a thread outside any project). Its popover switches
 * between this project and all. One shared read of Queue's open decisions per
 * board refresh drives registration, the live label and removal, so a pill
 * appears and clears within one board refresh and never bursts (Tom, 2026-10-21:
 * the asker-only pill was rarely where the operator was looking).
 */

/** The board refresh cadence (client/board-state.ts); the pill follows the same beat. */
export const DECISION_PILL_REFRESH_MS = 4000;

export const DECISION_PILL_ID = "operator-decisions";
/**
 * The pill id for one thread. Paseo 0.12 accepts only `/^[a-z][a-z0-9-]*$/`;
 * the earlier `operator-decisions:<agent>` failed that check on the first
 * thread, so no pill ever registered (Tom, 2026-10-21).
 */
export const decisionPillId = (agentId: string) => `${DECISION_PILL_ID}-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
const PILL_ICON = "Gavel";

/** "1 here · 3 all" for a thread in a project; "1 decision" or "N decisions" for one outside any. */
export const decisionPillLabel = (here: number | null, all: number): string =>
  here === null ? (all === 1 ? "1 decision" : `${all} decisions`) : `${here} here · ${all} all`;

export type ThreadProject = { key: string; name: string } | null;

type PopoverDeps = {
  client: BoardHost; boardPanelId: string;
  /** The open decisions from the pills' last read, if any. */
  known?: () => DecisionView[] | undefined;
  /** The thread's project, once resolved. */
  projectOf?: (agentId: string) => ThreadProject | undefined;
};

/** The decisions a scope shows: the thread's project, or every open one. */
export const decisionsInScope = (open: readonly DecisionView[], scope: "project" | "all", project: ThreadProject | undefined) =>
  scope === "all" || !project ? [...open] : open.filter(decision => decision.projectKey === project.key);

/**
 * The pill's popover: each open decision with its question, options and
 * recommendation, an answer box that calls decision.answer with operator
 * authority, and a link to the board view. It reads Queue directly through the
 * plugin client, so it needs no query provider of its own.
 */
export function decisionPillPopover({ client, boardPanelId, known, projectOf }: PopoverDeps) {
  return function DecisionPillPopover(props: BoardPillContentProps) {
    const { theme, close } = props;
    // Pills register per agent, so the popover always has the agent context.
    if (props.context !== "agent") return null;
    const { workspaceId, agentId } = props;
    const c = theme.colors;
    // Paseo sizes the popover as it opens. Starting from "Loading…" left it about
    // 80 px tall once the decisions arrived (Tom, 2026-09-30), so the first
    // frame shows the pills' last read and the fresh read replaces it.
    const project = projectOf?.(agentId);
    const [open, setOpen] = useState<DecisionView[] | null>(() => known?.() ?? null);
    // This project first when it has any; otherwise all.
    const [scope, setScope] = useState<"project" | "all">(() =>
      project && (known?.() ?? []).some(decision => decision.projectKey === project.key) ? "project" : "all");
    const decisions = open === null ? null : decisionsInScope(open, scope, project);
    const [loadError, setLoadError] = useState("");
    const [answerError, setAnswerError] = useState("");
    const [withdrawError, setWithdrawError] = useState("");
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [pendingOption, setPendingOption] = useState<{ id: string; option: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [withdrawing, setWithdrawing] = useState<string | null>(null);
    const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});
    const [readToken, setReadToken] = useState(0);
    useEffect(() => {
      let alive = true;
      // The board revision only keys the shared cache; a failed snapshot reads
      // the decisions directly rather than failing the decision list.
      client.rpc(api.uiSnapshot, {}).catch(() => undefined).then(board => readDecisions(domainRevision(board, "decisions"), () => client.rpc(api.decisionList, { status: "open" })))
        .then(fresh => { if (alive) { setOpen(fresh); setLoadError(""); } })
        .catch(err => { if (alive) setLoadError(errorText(err)); });
      return () => { alive = false; };
    }, [client, agentId, readToken]);
    const answer = (decision: DecisionView) => {
      const text = (drafts[decision.id] ?? "").trim();
      if (!text || busy) return;
      setBusy(true);
      void client.rpc(api.decisionAnswer, { id: decision.id, version: decision.version, answer: text,
        answeredBy: "operator (board)", relayed: false, note: "" })
        .then(() => {
          setAnswerError("");
          setDrafts(current => { const next = { ...current }; delete next[decision.id]; return next; });
          clearDecisionRead(); setReadToken(token => token + 1);
        })
        // A refused answer (a stale version, say) keeps the draft and reloads the decision.
        .catch(err => { setAnswerError(errorText(err)); clearDecisionRead(); setReadToken(token => token + 1); })
        .finally(() => setBusy(false));
    };
    const withdraw = (decision: DecisionView, reference: NonNullable<DecisionView["overtakenBy"]>[number]) => {
      if (withdrawing) return;
      setWithdrawing(decision.id);
      void client.rpc(api.decisionWithdraw, { id: decision.id, version: decision.version,
        reason: `Withdrawn after ${reference.label}`, withdrawnBy: "operator (board)" })
        .then(() => { setWithdrawError(""); clearDecisionRead(); setReadToken(token => token + 1); })
        .catch(err => { setWithdrawError(errorText(err)); clearDecisionRead(); setReadToken(token => token + 1); })
        .finally(() => setWithdrawing(null));
    };
    // Tom, 2026-10-01: a block of recommendation text separated the options from
    // the answer box, so the order is question, recommendation, context, options,
    // answer. Paseo 0.12 sizes plugin popovers itself (280–420 pt wide, 440 pt
    // tall, scrolling its content), so the popover fills that box rather than a
    // width of its own, which the host clipped (Tom, 2026-10-21).
    return <View style={{ width: "100%" }}>
      <View style={{ ...row, paddingBottom: space.xs }}>
        <Icon name={PILL_ICON} size={14} color={c.foregroundMuted} />
        <Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize, fontWeight: "600" }}>Operator decisions</Text>
      </View>
      {project && <View accessibilityRole="tablist" style={{ ...row, gap: space.xs, paddingBottom: space.xs }}>
        {([["project", `${project.name} (${(open ?? []).filter(decision => decision.projectKey === project.key).length})`], ["all", `All (${(open ?? []).length})`]] as const).map(([value, text]) =>
          <Pressable key={value} accessibilityRole="tab" accessibilityLabel={`Show ${value === "all" ? "all decisions" : `${project.name} decisions`}`} accessibilityState={{ selected: scope === value }}
            onPress={() => setScope(value)}
            hitSlop={touchSlop(26)} style={{ borderWidth: 1, borderColor: scope === value ? c.accent : c.border, borderRadius: radius.control, paddingHorizontal: space.sm, paddingVertical: space.xxs, backgroundColor: scope === value ? c.surface2 : c.surface1 }}>
            <Text style={{ color: scope === value ? c.foreground : c.foregroundMuted, fontSize: typeScale.metadata.fontSize }}>{text}</Text>
          </Pressable>)}
      </View>}
      {loadError !== "" && <View style={{ ...row, paddingBottom: space.xs }}>
        <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, flexShrink: 1 }}>Could not load decisions: {loadError}. The list may be out of date.</Text>
        <Button small c={c} text="Retry" label="Retry loading open decisions" disabled={busy || withdrawing !== null} onPress={() => setReadToken(token => token + 1)} />
      </View>}
      {answerError !== "" && <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, paddingBottom: space.xs }}>Answer not confirmed: {answerError}. Check the decision before answering again; your draft is kept.</Text>}
      {withdrawError !== "" && <Text accessibilityRole="alert" style={{ color: roles(c).danger, fontSize: typeScale.metadata.fontSize, paddingBottom: space.xs }}>Withdraw not confirmed: {withdrawError}. Check the decision before trying again.</Text>}
      {decisions === null && loadError === "" && <Text style={muted(c)}>Loading decisions…</Text>}
      {decisions?.length === 0 && <Text style={muted(c)}>{scope === "project" && project ? `No open decisions for ${project.name}.` : "No open decisions."}</Text>}
      <ConfirmReplaceAnswer c={c} option={pendingOption?.option ?? null} onCancel={() => setPendingOption(null)}
        onConfirm={() => { if (pendingOption) setDrafts(current => ({ ...current, [pendingOption.id]: pendingOption.option })); setPendingOption(null); }} />
      <View>
        {decisions?.map(decision => {
          const headline = decision.headline ?? decision.question;
          const rawChoices = decision.choices ?? decision.options.slice(0, 3).map(label => ({ label, consequence: "" }));
          const recommended = decision.recommended ?? decision.options[0] ?? rawChoices[0]?.label;
          const picked = rawChoices.find(choice => choice.label === recommended);
          const choices = picked ? [picked, ...rawChoices.filter(choice => choice !== picked)] : rawChoices;
          const details = [...new Set([decision.question.length > 140 && decision.question !== headline ? `Full question: ${decision.question}` : null,
            decision.details, decision.context, decision.recommendation].filter((value): value is string => Boolean(value)))].join("\n\n");
          const references = decision.overtakenBy ?? [];
          return <View key={decision.id} style={{ gap: space.xs, paddingBottom: space.sm, marginBottom: space.sm, borderBottomWidth: 1, borderBottomColor: c.border }}>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>{decisionProjectLabel(decision)}</Text>
          {decision.links.tasks.length > 0 && <Text numberOfLines={1} style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>Task · {decision.links.tasks.join(", ")}</Text>}
          <Text selectable style={{ color: c.foreground, fontSize: typeScale.section.fontSize, fontWeight: "600", lineHeight: typeScale.section.lineHeight }}>{headline}</Text>
          {decision.stale && <Text style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>Stale: every linked task, lead and papercut has finished.</Text>}
          {references.length > 0 && <View style={{ gap: space.xxs, padding: space.xs, borderWidth: 1, borderColor: c.statusWarning, borderRadius: radius.control }}>
            <Text style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize, fontWeight: "600" }}>Probably overtaken</Text>
            <Pressable accessibilityRole="link" accessibilityLabel={`Open citing ruling: ${references.at(-1)!.label}`}
              onPress={() => { client.openPanel(boardPanelId, { workspaceId }); close(); }}>
              <Text numberOfLines={2} style={{ color: c.accent, fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight }}>{references.at(-1)!.label}</Text>
            </Pressable>
            <Button small c={c} text="Withdraw" disabled={withdrawing !== null} onPress={() => withdraw(decision, references.at(-1)!)} />
          </View>}
          {choices.length > 0 && <View style={{ gap: space.xs, paddingTop: space.xxs / 2 }}>{choices.map(choice => {
            const chosen = (drafts[decision.id] ?? "") === choice.label;
            const isRecommendedChoice = choice.label === recommended;
            return <Pressable key={choice.label} accessibilityRole="button" accessibilityLabel={`Use option: ${choice.label}${isRecommendedChoice ? ", recommended" : ""}`} accessibilityState={{ selected: chosen }}
              onPress={() => { const draft = drafts[decision.id] ?? ""; if (draft.trim() && draft !== choice.label) setPendingOption({ id: decision.id, option: choice.label }); else setDrafts(current => ({ ...current, [decision.id]: choice.label })); }}
              style={{ ...row, flexWrap: "nowrap", gap: space.xs, minHeight: touchTarget, borderWidth: 1, borderColor: chosen ? c.accent : c.border, borderRadius: radius.control, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: c.surface1 }}>
              <Icon name={chosen ? "CircleCheck" : "Circle"} size={14} color={chosen ? c.accent : c.foregroundMuted} />
              <Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, flex: 1 }}>{isRecommendedChoice ? "★ Recommended · " : ""}{choice.label}{choice.consequence ? ` — ${choice.consequence}` : ""}</Text>
            </Pressable>;
          })}</View>}
          {details && <View style={{ gap: space.xxs }}>
            <Pressable accessibilityRole="button" hitSlop={touchSlop(22)} accessibilityLabel={`${detailsOpen[decision.id] ? "Hide" : "Show"} details for ${headline}`}
              accessibilityState={{ expanded: Boolean(detailsOpen[decision.id]) }} onPress={() => setDetailsOpen(current => ({ ...current, [decision.id]: !current[decision.id] }))}>
              <Text style={{ color: c.accent, fontSize: typeScale.metadata.fontSize, fontWeight: "600" }}>{detailsOpen[decision.id] ? "Hide details" : "Details"}</Text>
            </Pressable>
            {detailsOpen[decision.id] && <Text selectable style={{ ...muted(c), fontSize: typeScale.metadata.fontSize, lineHeight: typeScale.metadata.lineHeight }}>{details}</Text>}
          </View>}
          <View style={{ ...row, flexWrap: "nowrap", alignItems: "flex-end", gap: space.xs }}>
            <TextInput accessibilityLabel={`Answer box: ${headline}`} value={drafts[decision.id] ?? ""}
              onChangeText={value => setDrafts(current => ({ ...current, [decision.id]: value }))}
              placeholder={choices.length ? "Pick an option above or write your answer" : "The operator's answer"} placeholderTextColor={c.foregroundMuted} multiline
              style={{ flex: 1, color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: radius.control, padding: space.xs, fontSize: typeScale.body.fontSize, minHeight: touchTarget }} />
            <Button small c={c} text="Answer" label={`Answer decision: ${headline}`}
              disabled={busy || (drafts[decision.id] ?? "").trim() === ""} hint={busy ? "An answer is already being sent" : (drafts[decision.id] ?? "").trim() === "" ? "Write an answer or pick an option first" : undefined}
              onPress={() => answer(decision)} />
          </View>
        </View>;
        })}
      </View>
      <Pressable accessibilityRole="link" accessibilityLabel="Open the decisions board" onPress={() => { client.openPanel(boardPanelId, { workspaceId }); close(); }}
        style={{ ...row, paddingTop: space.xs, gap: space.xs, minHeight: touchTarget }}>
        <Icon name="LayoutDashboard" size={14} color={c.accent} />
        <Text style={{ color: c.accent, fontSize: typeScale.body.fontSize }}>Open the board view</Text>
      </Pressable>
    </View>;
  };
}

/**
 * The pill reports its own state to the app console, once per change, so a pill
 * that does not appear can be diagnosed from there (Tom, 2026-10-21: no pill and
 * nothing in the console). Filter the console by "[nucleus]".
 */
export function pillLogger(log: (message: string, detail?: unknown) => void = (message, detail) =>
  detail === undefined ? console.info(`[nucleus] decision pills: ${message}`) : console.warn(`[nucleus] decision pills: ${message}`, detail)) {
  // One remembered line per source (the agent listing, the refresh), so two
  // steady outcomes never alternate into a line every tick.
  const last = new Map<string, string>();
  return (source: "listing" | "refresh" | "register", message: string, detail?: unknown) => {
    if (last.get(source) === message) return;
    last.set(source, message);
    log(message, detail);
  };
}

/** Thread projects are re-resolved this often, so a project registered later is picked up. */
export const DECISION_PILL_PROJECT_REFRESH_MS = 5 * 60_000;

/** Adds, relabels and removes one pill per known thread so it matches Queue's open decisions. */
export function decisionPills(client: BoardHost, boardPanelId: string, nowMs: () => number = Date.now, report = pillLogger()) {
  const threads = new Map<string, { workspaceId: string; cwd: string }>();
  const projects = new Map<string, ThreadProject>();
  const pills = new Map<string, BoardPillRegistration>();
  let open: DecisionView[] = [];
  let resolvedAt = nowMs();
  const Popover = decisionPillPopover({ client, boardPanelId, known: () => open, projectOf: agentId => projects.get(agentId) });
  let reading = false;
  let revision: number | undefined;
  // The decisions read key: kept across bounded acknowledgements, moved only by a decision write.
  let decisionsRevision: number | undefined;

  const know = (agentId: string, workspaceId: string | null | undefined, cwd = "") => {
    if (workspaceId) threads.set(agentId, { workspaceId, cwd });
  };

  const forget = (agentId: string) => {
    threads.delete(agentId);
    projects.delete(agentId);
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  /** Resolves the threads whose project is not known yet, in bounded batches. */
  const resolve = async () => {
    if (nowMs() - resolvedAt >= DECISION_PILL_PROJECT_REFRESH_MS) { projects.clear(); resolvedAt = nowMs(); }
    const unknown = [...threads].filter(([agentId]) => !projects.has(agentId));
    for (let i = 0; i < unknown.length; i += 500) {
      const batch = unknown.slice(i, i + 500).map(([agentId, thread]) => ({ agentId, cwd: thread.cwd }));
      for (const entry of await client.rpc(api.decisionAgentProjects, { agents: batch })) projects.set(entry.agentId, entry.project);
    }
  };

  const reconcile = (fresh: readonly DecisionView[]) => {
    open = [...fresh];
    if (!open.length) { stop(); return; }
    for (const [agentId, thread] of threads) {
      const project = projects.get(agentId);
      // A thread waits for its project before it shows a pill, so the label never flips.
      if (project === undefined) continue;
      const label = decisionPillLabel(project ? open.filter(decision => decision.projectKey === project.key).length : null, open.length);
      const existing = pills.get(agentId);
      if (existing) { existing.update({ title: label, label }); continue; }
      // One pill's refusal never stops the others from registering.
      try {
        pills.set(agentId, client.addComposerPill({
          // One id per thread: Paseo 0.10.2 opened every pill sharing an id,
          // so an unanchored copy rendered at the viewport's top-left (Tom, 2026-10-01).
          id: decisionPillId(agentId), workspaceId: thread.workspaceId, agentId,
          button: { title: label, label, icon: PILL_ICON, behavior: { kind: "popover", Content: Popover } },
        }));
      } catch (error) {
        report("register", `pill for ${agentId} refused: ${errorText(error)}`, error);
      }
    }
  };

  /** One read in flight at a time; a slow read never stacks into a burst. */
  const poll = async () => {
    if (reading) return;
    reading = true;
    try {
      const snapshot = await client.rpc(api.uiSnapshot, revision === undefined ? {} : { revision });
      revision = snapshot?.revision;
      decisionsRevision = domainRevision(snapshot, "decisions") ?? (snapshot ? decisionsRevision : undefined);
      const fresh = await readDecisions(decisionsRevision, () => client.rpc(api.decisionList, { status: "open" }));
      if (fresh.length) await resolve();
      reconcile(fresh);
      const resolved = [...threads.keys()].filter(agentId => projects.has(agentId)).length;
      report("refresh", `${fresh.length} open decision(s), ${threads.size} thread(s) known, ${resolved} resolved, ${pills.size} pill(s) registered`);
    } catch (error) {
      // Queue is unreachable: keep the pills exactly as they are and retry on the next refresh.
      report("refresh", `refresh failed: ${errorText(error)}`, error);
    } finally {
      reading = false;
    }
  };

  const stop = () => {
    for (const [, pill] of [...pills]) pill.remove();
    pills.clear();
  };

  /** Makes the known threads exactly this set, forgetting the rest. */
  const replace = (entries: ReadonlyArray<{ id: string; workspaceId?: string | null; cwd?: string }>) => {
    const keep = new Set(entries.map(entry => entry.id));
    for (const agentId of [...threads.keys()]) if (!keep.has(agentId)) forget(agentId);
    for (const entry of entries) know(entry.id, entry.workspaceId, entry.cwd ?? "");
  };

  return { know, forget, replace, reconcile, poll, stop, pills, Popover, report };
}

/** Registers the decision pills for every agent of the selected host. */
export function registerDecisionPills(client: BoardHost, boardPanelId: string, refreshMs = DECISION_PILL_REFRESH_MS): () => void {
  const controller = decisionPills(client, boardPanelId);
  const stopAgents = observeAgents(client, update => {
    if (update.kind === "upsert") controller.know(update.agent.id, update.agent.workspaceId, update.agent.cwd);
    else controller.forget(update.agentId);
    void controller.poll();
  }, refreshMs);
  void controller.poll();
  const timer = setInterval(() => void controller.poll(), refreshMs);
  return () => { clearInterval(timer); stopAgents(); controller.stop(); clearDecisionRead(); };
}
