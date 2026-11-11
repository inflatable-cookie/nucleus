import { errorText } from "../error-text";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import type { PoolEntry, Profile, Task, TaskNext, TaskNextVerb, RoutingPolicy, UsageView } from "../../shared/contracts";
import { activeGroupLimit, automaticSelection, automaticSelectionTag, describeAutomaticSelection, describeRoutePolicy } from "../../shared/pool";
import { formatLocalDateTime } from "../../shared/date-time";
import { suggestedVerbRefusals, taskActionPlan } from "../../shared/task-detail-summary";
import { RecordNotice } from "./parts";

/**
 * Every owner verb with its refusal, for the technical section. The summary shows
 * only the verbs that apply; a refused verb is readable here rather than as a
 * greyed button beside the actions.
 */
export function VerbReference({ verbs, c }: { verbs: readonly TaskNextVerb[]; c: Colors }) {
  if (!verbs.length) return null;
  return <View style={{ gap: 3 }}>
    <Text style={{ ...muted(c), fontSize: 11, fontWeight: "600" }}>Owner verbs</Text>
    {verbs.map((verb, index) => <Text key={`${verb.verb}:${index}`} selectable
      accessibilityLabel={`${verbText(verb)}: ${verb.available ? "available" : `unavailable, ${verb.refusal ?? "no reason recorded"}`}`}
      style={{ ...muted(c), fontSize: 11, lineHeight: 16 }}>
      {verbText(verb)} · {verb.available ? "available" : `not available — ${verb.refusal ?? "no reason recorded"}`}
    </Text>)}
  </View>;
}
/**
 * Spec 050 step 6: the Next section renders `task.next` at the top of task
 * detail: the current stop or wait in one plain line, the active run, and one
 * button per verb. An available verb opens a small form built from the fill
 * fields the registry names — a required reason or instruction, a role select
 * and a profile picker for the pool when the verb routes, plus any qualifying
 * fields the verb names (all or none: a descendant closeout's acceptance) — and its submit
 * button calls `queue.task` with the prefilled args, the operator caller
 * identity and the filled fields, then reports the result or refusal inline
 * and refreshes detail. Unavailable verbs sit greyed with their refusal on
 * hover. The renderer is generic in the verb list, so verbs the registry
 * gains later appear here with no further UI work.
 */
const VERB_FIELD_LABELS: Record<string, string> = {
  reason: "Reason", instruction: "Instruction", qualification: "Qualification", head: "Final PR head",
  reviewAuthorizationReason: "Authorization reason", reviewInstruction: "Reviewer instruction",
  dependsOn: "Prerequisites",
};
const VERB_FIELD_PLACEHOLDERS: Record<string, string> = {
  reason: "Why this control applies now",
  instruction: "Bounded instruction for the next turn",
  qualification: "What the owner accepts, and any deferred work",
  head: "Full 40-character head the PR merged at, read from the PR",
  reviewAuthorizationReason: "Why this continuation is authorized",
  reviewInstruction: "Bounded instruction for the reviewer",
  dependsOn: "Task references separated by commas; leave empty to clear",
};
const verbLabel = (verb: string) => verb === "accept_receipt" ? "Settings · accept receipt" : verb.replaceAll("_", " ");
/** Route verbs share one verb name across roles; move targets and effect keys do too. The prefilled args tell them apart. */
const verbKey = (verb: TaskNextVerb) => {
  const suffix = verb.args?.force === true ? ':force' : '';
  const role = verb.args?.role;
  if (verb.verb === "route" && typeof role === "string" && role) return `route:${role}`;
  const to = verb.args?.to;
  if (verb.verb === "move" && typeof to === "string" && to) return `move:${to}${suffix}`;
  const effect = verb.args?.effect;
  if (verb.verb === "retry_effect" && typeof effect === "string" && effect) return `retry_effect:${effect}${suffix}`;
  const kind = verb.args?.kind;
  if ((verb.verb === "release" || verb.verb === "keep_hold") && typeof kind === "string" && kind) return `${verb.verb}:${kind}`;
  return verb.verb;
};
/** Route buttons name the role they submit, move buttons the target; every other verb keeps its label. */
const verbText = (verb: TaskNextVerb) => {
  const role = verb.args?.role;
  if (verb.verb === "route" && typeof role === "string" && role) return `route ${role}`;
  const to = verb.args?.to;
  if (verb.verb === "move" && typeof to === "string" && to) return `${verb.args?.force === true ? 'force ' : ''}move to ${to}`;
  if (verb.verb === "retry_effect" && verb.args?.force === true) return `settle ${String(verb.args.effect)}`;
  const kind = verb.args?.kind;
  if (verb.verb === "release" && typeof kind === "string" && kind) return `release ${kind} hold`;
  if (verb.verb === "keep_hold" && typeof kind === "string" && kind) return `keep ${kind} hold`;
  return verbLabel(verb.verb);
};
export const NORMAL_USAGE: UsageView = { level: "normal", setLevel: "normal", until: null, expired: false };
function VerbField({ field, value, onChange, roleValue, pool, profiles, usage, availability, c, required = true }: {
  field: string; value: string; onChange: (value: string) => void; roleValue: string;
  pool: PoolEntry[]; profiles: Profile[]; usage: UsageView; availability: Availability; c: Colors; required?: boolean;
}) {
  if (field === "role") return <View style={row}>
    <Text style={muted(c)}>Role</Text>
    {(["worker", "reviewer", "coordinator"] as const).map(role =>
      <Button key={role} small c={c} text={role} selected={value === role} onPress={() => onChange(role)} />)}
  </View>;
  if (field === "profileId") {
    // Spec 053: every enabled profile can take any role.
    const choices = pool.filter(entry => entry.enabled)
      .map(entry => ({ entry, profile: profiles.find(profile => profile.id === entry.profileId) }))
      .filter(item => item.profile?.available);
    return <View style={{ gap: 5 }}>
      <Text style={{ ...muted(c), fontSize: 11 }}>Profile{roleValue ? ` for ${roleValue}` : ""}{choices.length ? "" : " · none eligible"}</Text>
      <View style={row}>{choices.map(({ entry, profile }) =>
        <Button key={entry.profileId} small wrap c={c} text={`${profile!.name}${choiceTag(entry, usage, availability)}`} label={`Profile ${profile!.name}`} selected={value === entry.profileId} onPress={() => onChange(entry.profileId)} />)}</View>
      <SelectedProfilePolicy entry={choices.find(item => item.entry.profileId === value)?.entry} usage={usage} availability={availability} explicit={() => "Route is an explicit request and applies at every usage level. "} c={c} />
    </View>;
  }
  const multiline = field === "instruction" || field === "reviewInstruction";
  const label = `${VERB_FIELD_LABELS[field] ?? field} (${required ? "required" : "optional"})`;
  return <Field c={c} label={label} value={value} onChange={onChange} multiline={multiline}
    placeholder={VERB_FIELD_PLACEHOLDERS[field] ?? field} />;
}

type Availability = { group: string; unavailable: boolean; reason: string; retryAt: string | null }[];
/** A chooser button's tag: an unavailable group, then the usage policy. The choosers offer enabled profiles only. */
export function choiceTag(entry: PoolEntry, usage: UsageView, availability: Availability): string {
  return activeGroupLimit(availability, entry.group) ? " · group unavailable" : automaticSelectionTag(entry, usage.level);
}
/** Spec 052: the chosen profile's automatic-selection policy under the level in force, beside the explicit choice. */
export function SelectedProfilePolicy({ entry, usage, availability, explicit, c }: { entry: PoolEntry | undefined; usage: UsageView; availability: Availability; explicit: (requestRequired: boolean) => string; c: Colors }) {
  if (!entry) return null;
  // An unavailable subscription group holds every dispatch to the profile, chosen or automatic, until it returns.
  const group = activeGroupLimit(availability, entry.group);
  if (group) return <Text style={{ color: c.statusWarning, fontSize: 11, flexShrink: 1 }}>Subscription group {entry.group} is unavailable{group.reason ? `: ${group.reason}` : ""}{group.retryAt ? ` · until ${formatLocalDateTime(group.retryAt)}` : ""}. Nothing dispatches to this profile until the group returns, whatever the usage level.</Text>;
  return <Text style={{ ...muted(c), fontSize: 11, flexShrink: 1 }}>{explicit(automaticSelection(entry, usage.level).startsWith("request"))}Automatic selection: {describeAutomaticSelection(entry, usage, formatLocalDateTime)}.</Text>;
}
/** Spec 052: the profiles this task's routing names, read against the usage level in force. */
export function RoutingPolicyLines({ policy, c }: { policy: RoutingPolicy | undefined; c: Colors }) {
  if (!policy?.profiles.length) return null;
  return <View style={{ gap: 2 }}>{policy.profiles.map(item =>
    <Text key={`${item.role}:${item.source}:${item.profileId}`} accessibilityLabel={`Routing policy for ${item.role} profile ${item.profileId}`} style={{ ...muted(c), fontSize: 12, flexShrink: 1 }}>{item.role} · {item.profileId} · {describeRoutePolicy(item, policy.usage, formatLocalDateTime)}</Text>)}
  </View>;
}
/**
 * The owner verbs this task accepts now. Loading and failed reads say so and offer
 * a retry; a failed refresh keeps the last reading and says it may be stale.
 */
export function NextSection({ next, loading, error, onRetry, busy, pool, profiles, usage, availability, onSubmit, c }: {
  next: TaskNext | null; loading: boolean; error: string | null; onRetry: () => void; busy: boolean; pool: PoolEntry[]; profiles: Profile[]; usage: UsageView; availability: Availability;
  onSubmit: (verb: TaskNextVerb, values: Record<string, string>) => Promise<unknown>; c: Colors;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [applying, setApplying] = useState(false);
  // Task 538: the two or three verbs that fit this state lead; the rest, and every
  // refusal, sit behind More or in the technical reference. Unavailable verbs never
  // render as actions.
  const [showMore, setShowMore] = useState(false);
  if (!next) return <DetailSection title="What you can do" c={c}>
    {error
      ? <View style={{ gap: 6 }}>
        <Text accessibilityLabel={`Owner verbs could not be read: ${error}`} style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17 }}>Owner verbs could not be read: {error}</Text>
        <Button small c={c} text="Retry" label="Retry reading owner verbs" disabled={loading} onPress={onRetry} />
      </View>
      : <Text accessibilityLabel="Reading owner verbs" style={{ ...muted(c), fontSize: 12 }}>{loading ? "Reading owner verbs…" : "Owner verbs are not loaded yet."}</Text>}
  </DetailSection>;
  const refusals = suggestedVerbRefusals(next);
  const forceVerbs = next.verbs.flatMap(verb => verb.forceArgs ? [{ ...verb, available: true, args: verb.forceArgs,
    fill: verb.forceFill, refusal: undefined, forceArgs: undefined, forceFill: undefined,
    note: 'Force records your reason and settles the named blockers.' }] : []);
  const plan = taskActionPlan(next.verbs);
  const actions = showMore ? [...plan.primary, ...plan.more, ...forceVerbs] : plan.primary;
  const activeVerb = [...next.verbs, ...forceVerbs].find(verb => verb.available && verbKey(verb) === active) ?? null;
  const fill = activeVerb?.fill ?? [];
  const qualifying = activeVerb?.qualifyingFill ?? [];
  // Qualifying fields are all or none: a partial pair would submit an incomplete acceptance.
  const qualifyingSupplied = qualifying.filter(field => values[field]?.trim()).length;
  const partialQualification = qualifyingSupplied > 0 && qualifyingSupplied < qualifying.length;
  const missing = fill.some(field => field !== "dependsOn" && !values[field]?.trim()) || partialQualification;
  const select = (verb: string) => { setActive(active === verb ? null : verb); setValues({}); setNotice(null); };
  const apply = () => {
    if (!activeVerb) return;
    setApplying(true);
    setNotice(null);
    // An emptied optional field is absent from the call, never a blank acceptance.
    const submitted = Object.fromEntries(Object.entries(values).filter(([field, value]) => fill.includes(field) || value.trim()));
    if (fill.includes("dependsOn")) submitted.dependsOn = values.dependsOn ?? "";
    onSubmit(activeVerb, submitted).then(result => {
      if (result && typeof result === "object" && "backpressured" in result) {
        const backpressured = result as unknown as { reason: string; retryAfterMs: number };
        setNotice({ kind: "error", text: `${backpressured.reason} Retry in about ${Math.max(1, Math.round(backpressured.retryAfterMs / 1000))}s.` });
      } else if (result && typeof result === "object" && "accepted" in result) {
        const accepted = result as unknown as { operation: { id: string } };
        setNotice({ kind: "ok", text: `Accepted ${verbLabel(activeVerb.verb)} · operation ${accepted.operation.id} is still running` });
        setActive(null); setValues({});
      } else {
        const task = result as { phase: Task["phase"] };
        setNotice({ kind: "ok", text: `Applied ${verbLabel(activeVerb.verb)} · phase ${task.phase}` });
        setActive(null); setValues({});
      }
    }).catch(e => {
      setNotice({ kind: "error", text: errorText(e) });
    }).finally(() => setApplying(false));
  };
  return <DetailSection title="What you can do" c={c}>
    {error && <Text accessibilityLabel={`Owner verbs may be stale: ${error}`} style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17 }}>Refresh failed: {error}. Showing the last reading, which may be stale.</Text>}
    {next.workerDemandStep && <Text style={{ ...muted(c), fontSize: 12 }}>Worker demand · {next.workerDemandStep}</Text>}
    <View style={row}>
      {actions.map(verb =>
        <Button key={verbKey(verb)} small c={c} text={verbText(verb)} label={verbText(verb)} hint={verb.note} selected={active === verbKey(verb)} disabled={busy || applying} onPress={() => select(verbKey(verb))} />)}
      {(plan.more.length + forceVerbs.length) > 0 &&
        <Button small c={c} text={showMore ? "Fewer" : `More (${plan.more.length + forceVerbs.length})`} label={showMore ? "Hide further owner verbs" : `Show ${plan.more.length + forceVerbs.length} further owner verbs`} selected={showMore} onPress={() => setShowMore(!showMore)} />}
    </View>
    {!actions.length && <Text style={{ ...muted(c), fontSize: 12 }}>No owner verb applies to this task now.</Text>}
    {/* The stop's suggested verbs that do not apply, each with its refusal. The full reference stays in Technical. */}
    {refusals.length > 0 && <View style={{ gap: 3 }}>
      <Text style={{ ...muted(c), fontSize: 11, fontWeight: "600" }}>Suggested, not available now</Text>
      {refusals.map(refusal => <Text key={refusal.verb} selectable
        accessibilityLabel={`${verbLabel(refusal.verb)} not available: ${refusal.reason}`}
        style={{ ...muted(c), fontSize: 12, lineHeight: 17 }}>
        {verbLabel(refusal.verb)} · {refusal.reason}
      </Text>)}
    </View>}
    {activeVerb && <View style={{ gap: 8 }}>
      {fill.map(field => <VerbField key={field} field={field} required={field !== "dependsOn"} value={values[field] ?? ""}
        onChange={value => setValues(current => ({ ...current, [field]: value }))}
        roleValue={values.role ?? (typeof activeVerb.args?.role === "string" ? activeVerb.args.role : "")} pool={pool} profiles={profiles} usage={next.routingPolicy?.usage ?? usage} availability={availability} c={c} />)}
      {qualifying.length > 0 && <Text accessibilityLabel={`Qualifying fields: ${qualifying.join(", ")}`} style={{ ...muted(c), fontSize: 12, flexShrink: 1 }}>
        {partialQualification ? "Supply every qualifying field or none; a partial acceptance cannot be applied." : "Optional, all or none: leave them empty for the ordinary path. Supply every one only for the qualified acceptance this verb names."}
      </Text>}
      {qualifying.map(field => <VerbField key={field} field={field} required={false} value={values[field] ?? ""}
        onChange={value => setValues(current => ({ ...current, [field]: value }))}
        roleValue="" pool={pool} profiles={profiles} usage={next.routingPolicy?.usage ?? usage} availability={availability} c={c} />)}
      <Button small c={c} text="Apply" label={`Confirm ${verbLabel(activeVerb.verb)}`} disabled={busy || applying || missing} onPress={apply} />
    </View>}
    {notice && <RecordNotice notice={notice} c={c} />}
  </DetailSection>;
}
