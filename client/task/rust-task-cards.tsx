/** The cards of the Rust task view (Spec 071): progress, pull request, activity and brief. */
import { useRef, useState, type ReactNode } from "react";
import { Linking, Text, View } from "react-native";
import {
  Button,
  Disclosure,
  Field,
  LabelHelp,
  SaveStatus,
  row,
  useCardFill,
  useSectionAutoSave,
  type Colors,
} from "../controls";
import { radius, roles, space, type as typeScale } from "../design";
import { formatSpan } from "../../shared/task-detail-summary";
import { relativeAge } from "../../shared/pipeline-board";
import {
  rustPhaseLabels,
  type RustCommand,
  type RustDependency,
  type RustHistoryPage,
  type RustTaskDetail,
  type RustTranscriptCard,
} from "../web/rust-board";
import { RustTimeline } from "./rust-progress";
import { Dot, Hint, LabelRow, Meter, Pill, QuietButton, metaText } from "./rust-detail-parts";
import { clockTime, roundsFor, type TimelineTone } from "./rust-timeline";

type CommandOutcome = { status: "pending"; version: number } | object;

export function Card({ c, children, label }: { c: Colors; children: ReactNode; label?: string }) {
  const fill = useCardFill(c);
  return (
    <View
      accessibilityLabel={label}
      style={{ gap: space.sm, padding: space.sm, borderRadius: radius.panel, backgroundColor: fill }}
    >
      {children}
    </View>
  );
}

export function Divider({ c }: { c: Colors }) {
  return <View style={{ height: 1, marginHorizontal: -space.sm, backgroundColor: roles(c).hairline }} />;
}

/** A card whose body opens on demand; `action` sits at the right of its header. */
export function Collapsible({
  c,
  title,
  open,
  onToggle,
  action,
  children,
}: {
  c: Colors;
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const fill = useCardFill(c);
  return (
    <View style={{ paddingHorizontal: space.sm, borderRadius: radius.panel, backgroundColor: fill }}>
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Disclosure
            c={c}
            label={title}
            accessibilityLabel={`${title}, ${open ? "expanded" : "collapsed"}`}
            expanded={open}
            onToggle={onToggle}
          />
        </View>
        {action}
      </View>
      {open && <View style={{ gap: space.sm, paddingBottom: space.sm }}>{children}</View>}
    </View>
  );
}

const roleNames = { worker: "Worker", reviewer: "Reviewer" } as const;

function latestCard(detail: RustTaskDetail, role: "worker" | "reviewer"): RustTranscriptCard | undefined {
  return detail.lifecycle.transcript?.cards.filter((card) => card.role === role).at(-1);
}

/** Timeline, wait line, role rows, allowance and, while queued, prerequisites. */
export function ProgressCard({
  c,
  detail,
  allowance,
  waitLine,
  recheck,
  dependencies,
}: {
  c: Colors;
  detail: RustTaskDetail;
  allowance: RustTaskDetail["allowance"];
  waitLine: { text: string; nextCheckAt: number | null } | null;
  recheck?: ReactNode;
  dependencies?: ReactNode;
}) {
  const r = roles(c);
  const finished = detail.phase === "done" || detail.phase === "cancelled";
  const roles_ = (["worker", "reviewer"] as const).filter(
    (role) => detail.lifecycle[role] || latestCard(detail, role),
  );
  return (
    <Card c={c} label="Progress">
      <RustTimeline
        c={c}
        lifecycle={detail.lifecycle}
        context={{ attention: detail.attention, stateSinceMs: detail.stateSinceMs }}
      />
      {waitLine && (
        <View style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
          <Text style={{ ...metaText(c), flex: 1, minWidth: 0 }}>{waitLine.text}</Text>
          {waitLine.nextCheckAt !== null && (
            <Hint c={c} text={new Date(waitLine.nextCheckAt).toLocaleString()}>
              <Text style={metaText(c)}>{`Next check ${clockTime(waitLine.nextCheckAt)}`}</Text>
            </Hint>
          )}
          {recheck}
        </View>
      )}
      {dependencies}
      {(roles_.length > 0 || allowance) && <Divider c={c} />}
      {roles_.map((role) => {
        const card = latestCard(detail, role);
        const participant = detail.lifecycle[role];
        const model = card?.model ?? participant?.model ?? null;
        const provider = card?.provider ?? participant?.provider ?? null;
        const activity = detail.run?.role === role && !finished ? detail.run.activity?.label : null;
        const thread = [...(detail.lifecycle.transcript?.cards ?? [])]
          .reverse()
          .find((candidate) => candidate.role === role && candidate.threadUrl)?.threadUrl;
        return (
          <LabelRow key={role} c={c} label={roleNames[role]}>
            <Hint c={c} text={provider ?? ""} style={{ flexShrink: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ ...typeScale.body, color: r.foreground }}>
                {model ?? "Model not recorded"}
              </Text>
            </Hint>
            <View style={{ ...row, flexWrap: "nowrap", flex: 1, minWidth: 0, gap: space.xs }}>
              {activity && (
                <>
                  <Dot c={c} tone="accent" />
                  <Text numberOfLines={1} style={{ ...typeScale.body, color: metaText(c).color, flexShrink: 1 }}>
                    {activity}
                  </Text>
                </>
              )}
            </View>
            {thread && (
              <Button
                c={c}
                small
                iconOnly
                icon="ExternalLink"
                text={`Open ${role} thread`}
                label={`Open ${role} thread`}
                onPress={() => void Linking.openURL(thread)}
              />
            )}
          </LabelRow>
        );
      })}
      {allowance && allowance.limitMs > 0 && (
        <LabelRow c={c} label="Allowance">
          <Hint
            c={c}
            text={`${formatSpan(allowance.usedMs)} of ${formatSpan(allowance.limitMs)} used`}
            style={{ flex: 1, minWidth: 0 }}
          >
            <Meter c={c} ratio={allowance.usedMs / allowance.limitMs} finished={finished} />
          </Hint>
          <Text style={metaText(c)}>{`${formatSpan(allowance.usedMs)} / ${formatSpan(allowance.limitMs)}`}</Text>
        </LabelRow>
      )}
    </Card>
  );
}

const dependencyTone = (dependency: RustDependency): TimelineTone =>
  dependency.status === "satisfied"
    ? "success"
    : dependency.status === "pending"
      ? "accent"
      : "danger";

export function Prerequisites({
  c,
  dependencies,
  canEdit,
  busy,
  onSave,
}: {
  c: Colors;
  dependencies: readonly RustDependency[];
  canEdit: boolean;
  busy: boolean;
  onSave: (references: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const r = roles(c);
  return (
    <View style={{ gap: space.xxs }}>
      <Divider c={c} />
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <Text style={{ ...metaText(c), flex: 1 }}>Prerequisites</Text>
        {canEdit && (
          <QuietButton
            c={c}
            text={editing ? "Done" : "Edit"}
            label={editing ? "Close prerequisites" : "Edit prerequisites"}
            onPress={() => {
              setDraft(dependencies.map((dependency) => dependency.reference).join("\n"));
              setEditing(!editing);
            }}
          />
        )}
      </View>
      {editing ? (
        <View style={{ gap: space.xs }}>
          <Field c={c} label="Prerequisites" hideLabel multiline value={draft} onChange={setDraft} disabled={busy} />
          <Button
            c={c}
            small
            text="Save"
            label="Save prerequisites"
            disabled={busy}
            onPress={() => {
              onSave(draft.split(/[\s,]+/).filter(Boolean));
              setEditing(false);
            }}
          />
        </View>
      ) : (
        dependencies.map((dependency) => (
          <View key={dependency.taskId} style={{ ...row, flexWrap: "nowrap", gap: space.sm, minHeight: 28 }}>
            <Text style={{ ...typeScale.body, color: r.foreground }}>{dependency.reference}</Text>
            <Text numberOfLines={1} style={{ ...typeScale.body, color: metaText(c).color, flex: 1, minWidth: 0 }}>
              {dependency.title ?? ""}
            </Text>
            <View style={{ ...row, gap: space.xxs + 2 }}>
              <Dot c={c} tone={dependencyTone(dependency)} />
              <Text style={metaText(c)}>
                {dependency.phase
                  ? rustPhaseLabels[dependency.phase]
                  : dependency.status === "missing"
                    ? "Missing"
                    : "Unknown"}
              </Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

type ReviewRound = { round: number; decision: "approve" | "changes"; summary: string; findings: string[] };

function reviewRounds(detail: RustTaskDetail): ReviewRound[] {
  const rounds: ReviewRound[] = [];
  for (const round of roundsFor(detail.lifecycle.transcript?.cards ?? [], "reviewer")) {
    if (round.outcome?.kind !== "review") continue;
    rounds.push({
      round: round.round,
      decision: round.outcome.decision,
      summary: round.outcome.summary,
      findings: round.outcome.finding_titles,
    });
  }
  const verdict = detail.verdict;
  if (rounds.length === 0 && verdict && "reviewed" in verdict) {
    rounds.push({
      round: detail.lifecycle.reviewRound ?? 1,
      decision: verdict.reviewed.decision,
      summary: verdict.reviewed.summary,
      findings: [],
    });
  }
  return rounds;
}

const decisionWords = { approve: "approved", changes: "changes requested" } as const;

function ReviewBody({ c, review }: { c: Colors; review: ReviewRound }) {
  const r = roles(c);
  return (
    <>
      {Boolean(review.summary) && (
        <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
          {review.summary}
        </Text>
      )}
      {review.findings.map((finding, index) => (
        <View key={index} style={{ flexDirection: "row", gap: space.xs }}>
          <View style={{ marginTop: space.xs - 1 }}>
            <Dot c={c} tone="warning" />
          </View>
          <Text selectable style={{ ...typeScale.body, color: r.foreground, flex: 1 }}>
            {finding}
          </Text>
        </View>
      ))}
    </>
  );
}

function SubCard({ c, children }: { c: Colors; children: ReactNode }) {
  return (
    <View style={{ gap: space.xs, padding: space.sm, borderRadius: radius.card, backgroundColor: roles(c).raised }}>
      {children}
    </View>
  );
}

/** The pull request, its state, the latest verdict and earlier rounds collapsed. */
export function PullRequestCard({
  c,
  detail,
  mergedCommit,
}: {
  c: Colors;
  detail: RustTaskDetail;
  mergedCommit: string | null;
}) {
  const r = roles(c);
  const [openRound, setOpenRound] = useState<number | null>(null);
  const pr = detail.pullRequest;
  if (!pr) return null;
  const number = pr.url.match(/\/pull\/(\d+)/)?.[1];
  const verdict = detail.verdict;
  const reviews = reviewRounds(detail);
  const latest = reviews.at(-1);
  const merged = detail.phase === "done" && (Boolean(mergedCommit) || detail.lifecycle.transcript?.merged !== false);
  const pill: { tone: TimelineTone; text: string } | null = merged
    ? { tone: "success", text: "Merged" }
    : verdict && "accepted" in verdict
      ? { tone: "success", text: "Accepted" }
      : latest?.decision === "approve"
        ? { tone: "success", text: "Approved" }
        : latest?.decision === "changes"
          ? { tone: "warning", text: "Changes requested" }
          : null;
  const shown = merged && mergedCommit ? mergedCommit : pr.head;
  const reviewedHead =
    verdict && "reviewed" in verdict ? verdict.reviewed.head : verdict && "accepted" in verdict ? verdict.accepted.head : null;
  const latestLabel = latest
    ? merged
      ? [latest.decision === "approve" ? "Approved" : "Changes requested", latest.round >= 2 ? `round ${latest.round}` : null]
          .filter(Boolean)
          .join(" · ")
      : latest.round >= 2
        ? `Round ${latest.round}`
        : null
    : null;
  return (
    <Card c={c} label="Pull request">
      <View style={{ ...row, gap: space.sm }}>
        <Button
          c={c}
          small
          icon="GitPullRequest"
          text={number ? `PR #${number}` : "Pull request"}
          label="Open pull request"
          onPress={() => void Linking.openURL(pr.url)}
        />
        <Hint c={c} text={merged && mergedCommit ? `Merge commit ${mergedCommit}` : pr.head} focusable>
          <Text style={{ ...metaText(c), fontFamily: "monospace" }}>{shown.slice(0, 7)}</Text>
        </Hint>
        {reviewedHead && reviewedHead !== pr.head && !merged && (
          <Text style={metaText(c)}>{`reviewed ${reviewedHead.slice(0, 7)}`}</Text>
        )}
        <View style={{ flex: 1 }} />
        {pill && <Pill c={c} tone={pill.tone} text={pill.text} />}
      </View>
      {verdict && "accepted" in verdict ? (
        <SubCard c={c}>
          <Text style={metaText(c)}>Accepted</Text>
          <Text selectable style={{ ...typeScale.body, color: r.foreground }}>
            {verdict.accepted.acceptance.reason}
          </Text>
        </SubCard>
      ) : (
        latest && (
          <SubCard c={c}>
            {latestLabel && <Text style={metaText(c)}>{latestLabel}</Text>}
            <ReviewBody c={c} review={latest} />
          </SubCard>
        )
      )}
      {reviews
        .slice(0, -1)
        .reverse()
        .map((review) => (
          <View key={review.round}>
            <Disclosure
              c={c}
              label={`Round ${review.round} · ${decisionWords[review.decision]}`}
              expanded={openRound === review.round}
              onToggle={() => setOpenRound(openRound === review.round ? null : review.round)}
            />
            {openRound === review.round && (
              <SubCard c={c}>
                <ReviewBody c={c} review={review} />
              </SubCard>
            )}
          </View>
        ))}
    </Card>
  );
}

type ActivityEntry = { key: string; at: number; text: string; detail: string | null; tone: TimelineTone };

/** History as milestones, newest first. Records the board cannot present are skipped. */
export function activityEntries(pages: readonly RustHistoryPage[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const { sequence, content, presentation } of pages.flat()) {
    const reviewed = presentation.some(
      (record) => record.kind === "run_reported" && record.outcome?.kind === "review",
    );
    presentation.forEach((record, position) => {
      const add = (text: string, tone: TimelineTone, detail: string | null = null) =>
        entries.push({ key: `${sequence}:${position}`, at: content.at, text, detail, tone });
      switch (record.kind) {
        case "run_started":
          add(
            `${roleNames[record.role]} started${record.round && record.round >= 2 ? ` round ${record.round}` : ""}`,
            "accent",
            record.model ?? null,
          );
          break;
        case "run_reported":
          switch (record.outcome?.kind) {
            case "work":
              add(record.outcome.revision ? "Worker pushed a revision" : "Worker submitted work", "success");
              break;
            case "review":
              add(
                record.outcome.decision === "approve" ? "Approved" : "Changes requested",
                record.outcome.decision === "approve" ? "success" : "warning",
              );
              break;
            case "report":
              add("Report delivered", "success");
              break;
            case "blocked":
              add("Run could not finish", "danger", record.outcome.reason);
              break;
          }
          break;
        case "pull_request": {
          const number = record.url.match(/\/pull\/(\d+)/)?.[1];
          add("Pull request opened", "success", number ? `#${number}` : null);
          break;
        }
        case "verdict":
          if ("accepted" in record.verdict) add("External merge accepted", "success");
          else if (!reviewed)
            add(
              record.verdict.reviewed.decision === "approve" ? "Approved" : "Changes requested",
              record.verdict.reviewed.decision === "approve" ? "success" : "warning",
            );
          break;
        case "question":
          add("Question asked", "warning");
          break;
        case "merged":
          add("Merged", "success", record.commit.slice(0, 7));
          break;
        case "finished":
          add(rustPhaseLabels[record.phase], record.phase === "done" ? "success" : "muted");
          break;
        case "run_routing":
        case "run_ended":
          break;
      }
    });
  }
  return entries.sort((a, b) => b.at - a.at);
}

export function ActivityList({
  c,
  entries,
  limit,
}: {
  c: Colors;
  entries: readonly ActivityEntry[];
  limit: number | null;
}) {
  const r = roles(c);
  return (
    <View>
      {entries.slice(0, limit ?? undefined).map((entry) => (
        <View key={entry.key} style={{ flexDirection: "row", gap: space.xs + 2, paddingVertical: space.xxs }}>
          <Hint c={c} text={new Date(entry.at).toLocaleString()} style={{ width: 64 }}>
            <Text style={{ ...metaText(c), lineHeight: typeScale.body.lineHeight }}>{relativeAge(entry.at)}</Text>
          </Hint>
          <View style={{ marginTop: space.xs - 1 }}>
            <Dot c={c} tone={entry.tone} />
          </View>
          <Text style={{ ...typeScale.body, color: r.foreground, flex: 1, minWidth: 0 }}>
            {entry.text}
            {entry.detail ? <Text style={{ color: metaText(c).color }}>{`  ${entry.detail}`}</Text> : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function BriefEditor({
  detail,
  c,
  submit,
  readBrief,
}: {
  detail: RustTaskDetail;
  c: Colors;
  readBrief: () => Promise<RustTaskDetail["brief"] | undefined>;
  submit: (command: RustCommand) => Promise<CommandOutcome>;
}) {
  const [draft, setDraft] = useState(detail.brief.text);
  const baseline = useRef(detail.brief.version);
  const { invalid, enqueue, status, failed } = useSectionAutoSave(async (text: string) => {
    let outcome: CommandOutcome;
    try {
      outcome = await submit({ amend: text, briefVersion: baseline.current });
    } catch (error) {
      if (typeof error !== "object" || !error || !("status" in error) || error.status !== 409) throw error;
      const saved = await readBrief();
      if (!saved || saved.text !== text) throw error;
      baseline.current = saved.version;
      return;
    }
    if ("status" in outcome) throw new Error("The engine is checking the task. Try again when ready.");
    baseline.current++;
  });
  const change = (text: string, delay: number) => {
    setDraft(text);
    if (text.trim()) enqueue(text, delay);
    else invalid("A brief is required.");
  };
  return (
    <View style={{ gap: space.xs }}>
      <LabelHelp c={c} label="Brief" text="Edits save automatically." />
      <Field c={c} label="Brief" hideLabel value={draft} multiline onChange={(text) => change(text, 650)} />
      <SaveStatus c={c} label="Brief" status={status} />
      {failed && draft.trim() && <Button c={c} small text="Retry" onPress={() => change(draft, 0)} />}
    </View>
  );
}
