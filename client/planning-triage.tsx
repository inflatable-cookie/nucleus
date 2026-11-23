import React, { useState } from "react";
import { Text, View } from "react-native";
import type { PlanningTriage } from "../shared/contracts";
import { Disclosure, TextLink, muted, type Colors } from "./controls";
import { roles, space, type } from "./design";

type Batch = NonNullable<PlanningTriage["current"]>;
type Outcome = NonNullable<Batch["items"][number]["outcome"]>;

const statuses = { applied: "Applied", proposed: "Proposed", refused: "Refused", superseded: "Superseded" } satisfies Record<Outcome["status"], string>;
const dispositions = { promote: "Promote", close: "Close", defer: "Defer", operator: "Operator decision" } satisfies Record<NonNullable<Outcome["disposition"]>, string>;
const closures = { duplicate: "Duplicate", fixed: "Fixed", out_of_scope: "Out of scope" } satisfies Record<NonNullable<Outcome["closure"]>, string>;

function batchDigest(batch: Batch): string {
  const counts = { pending: 0, proposed: 0, applied: 0, refused: 0, superseded: 0 };
  let questions = 0;
  for (const { outcome } of batch.items) {
    counts[outcome?.status ?? "pending"]++;
    if (outcome?.status === "applied" && outcome.disposition === "operator") questions++;
  }
  const total = batch.items.length;
  return [`${total} ${total === 1 ? "record" : "records"}`,
    ...Object.entries(counts).flatMap(([status, count]) => count ? [`${count} ${status}`] : []),
    ...(questions ? [`${questions} for operator`] : []),
  ].join(" · ");
}

function BatchRecords({ batch, onOpenTask, c }: { batch: Batch; onOpenTask?: (id: string) => void; c: Colors }) {
  const r = roles(c);
  const meta = { ...muted(c), ...type.metadata };
  const taskLink = (reference: string, id: string | null) => id && onOpenTask
    ? <TextLink c={c} text={reference} label={`Open task ${reference}`} onPress={() => onOpenTask(id)} />
    : <Text selectable style={meta}>{reference}</Text>;
  return <View style={{ gap: space.xs }}>
    {batch.items.map(({ recordId, title, kind, outcome, taskId, canonicalTaskId }) => <View key={recordId} style={{ paddingTop: space.xs, gap: space.xxs }}>
      <Text style={{ color: r.foreground, fontWeight: "600", ...type.body }}>{title}</Text>
      <Text style={meta}>{[
        kind === "lead" ? "Lead" : kind === "papercut" ? "Papercut" : null,
        outcome ? statuses[outcome.status] : "Pending",
        outcome?.disposition && dispositions[outcome.disposition],
        outcome?.closure && closures[outcome.closure],
      ].filter(Boolean).join(" · ")}</Text>
      {outcome?.reason && <Text style={{ color: r.foreground, ...type.body }}>{outcome.reason}</Text>}
      {outcome?.diagnostic && outcome.diagnostic !== outcome.reason && <Text style={meta}>{outcome.diagnostic}</Text>}
      {outcome?.canonical && <View style={{ gap: space.xxs }}><Text style={meta}>Canonical target</Text>{taskLink(outcome.canonical, canonicalTaskId)}</View>}
      {outcome?.revisitAt && <Text style={meta}>Revisit {new Date(outcome.revisitAt).toLocaleString()}</Text>}
      {outcome?.status === "applied" && outcome.disposition === "operator" && outcome.question &&
        <Text style={{ color: r.warning, ...type.body }}>Operator input needed · {outcome.question}</Text>}
      {outcome?.task && taskLink(outcome.task, taskId)}
    </View>)}
  </View>;
}

export function ProjectTriage({ project, triage, onOpenTask, c }: { project: string; triage: PlanningTriage; onOpenTask?: (id: string) => void; c: Colors }) {
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const r = roles(c);
  const { current, latest } = triage;
  const batch = (label: string, data: Batch) => {
    const expanded = expandedBatch === data.id;
    return <View key={data.id} style={{ gap: space.xxs }}>
      <Disclosure c={c} label={`${label} · ${batchDigest(data)}`} expanded={expanded}
        onToggle={() => setExpandedBatch(expanded ? null : data.id)} />
      {expanded && <BatchRecords batch={data} onOpenTask={onOpenTask} c={c} />}
    </View>;
  };
  return <View accessibilityLabel={`Triage for ${project}`} style={{ gap: space.xxs, paddingTop: space.sm }}>
    <Text accessibilityRole="header" style={{ color: r.foreground, fontWeight: "600", ...type.body }}>Triage</Text>
    {!triage.enabled && <Text style={muted(c)}>Automatic triage is off.</Text>}
    {triage.awaitingPlanner && <Text style={muted(c)}>Waiting for a project planner.</Text>}
    {triage.enabled && triage.waiting && <Text style={muted(c)}>Waiting for dispatch room.</Text>}
    {triage.enabled && !current && !latest && !triage.waiting && <Text style={muted(c)}>No triage batch yet.</Text>}
    {current && batch("Current batch", current)}
    {latest && batch("Last completed batch", latest)}
  </View>;
}
