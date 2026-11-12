import { errorText as message } from "./error-text";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Lead, LeadDetail, LeadVersion } from "../shared/contracts";
import { formatLocalDateTime } from "../shared/date-time";
import { Button, Disclosure, Field, row, type Colors } from "./controls";
import { radius, roles, space, type } from "./design";
import { Readable } from "./readable-text";

/** The lead record as read. `data` is undefined until the first read completes, so loading never looks empty. */
export type LeadRead = { data?: LeadDetail; error?: string };

/** The newest version, other than the current one, whose check the history keeps. */
export const leadStateWord: Record<Lead["state"], string> = { open: "Open", promoted: "Promoted", dropped: "Dropped", closed: "Closed" };
/** A lead's body is a brief only with brief frontmatter; prose alone is not a brief to check or approve. */
export const briefBearing = (body: string) => /^---\r?\n/.test(body);
/**
 * A brief's body without its frontmatter. The frontmatter is routing mechanics, so it is
 * read under Details and never shown as the operator's text (Tom, 2026-11-07).
 */
export function briefParts(body: string): { frontmatter: string | null; text: string } {
  if (!briefBearing(body)) return { frontmatter: null, text: body };
  const end = body.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: null, text: body };
  const after = body.indexOf("\n", end + 4);
  return { frontmatter: body.slice(0, after < 0 ? body.length : after).trim(), text: after < 0 ? "" : body.slice(after + 1).trim() };
}
export const checkLabel = (check: Lead["check"]) => !check ? "Unchecked" : check.ok ? (check.message ? `Checks passed · ${check.message}` : "Checks passed") : (check.message ? `Checks failed · ${check.message}` : "Checks failed");

/**
 * What the check says about the version the operator is looking at. A new version
 * clears the check, so the history's last checked version is named as stale rather
 * than silently shown as this version's result.
 */
export type LeadCheckView =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "current"; check: NonNullable<Lead["check"]> }
  | { kind: "stale"; version: number; check: NonNullable<Lead["check"]> };

export function leadCheckView(lead: LeadDetail): LeadCheckView {
  if (lead.checkOperationId) return { kind: "pending" };
  if (lead.check) return { kind: "current", check: lead.check };
  const earlier = [...lead.versions]
    .filter(version => version.check && version.version < lead.version)
    .sort((a, b) => b.version - a.version)[0];
  return earlier ? { kind: "stale", version: earlier.version, check: earlier.check! } : { kind: "none" };
}

/** Approval binds to one version and its digest. An approval for another version is named stale, never implied. */
export type LeadApprovalView =
  | { kind: "none" }
  | { kind: "current"; approval: NonNullable<Lead["approval"]> }
  | { kind: "stale"; approval: NonNullable<Lead["approval"]> };

export function leadApprovalView(lead: LeadDetail): LeadApprovalView {
  const approval = lead.approval;
  if (approval) {
    if (approval.version !== lead.version || (lead.digest !== undefined && approval.digest !== lead.digest)) return { kind: "stale", approval };
    return { kind: "current", approval };
  }
  // Writing a new version clears the approval on the record, so an ordinary edit would otherwise hide
  // that the earlier version was approved. The version history keeps it, and it names its version.
  const earlier = [...lead.versions]
    .filter(version => version.approval && version.version < lead.version)
    .sort((a, b) => b.version - a.version)[0];
  return earlier ? { kind: "stale", approval: earlier.approval! } : { kind: "none" };
}

/** Who approved which version, and whether an agent relayed the operator's authority (Tom, 2026-09-26). */
export function approvalLine(approval: NonNullable<Lead["approval"]>): string {
  const who = approval.relayed ? `Approved by ${approval.approver}, relayed with the operator's authority` : `Approved by ${approval.approver}`;
  return approval.note ? `${who} · ${approval.note}` : who;
}

export function leadCheckReason(lead: LeadDetail): string | undefined {
  if (lead.state !== "open") return `Only open leads can be checked; this lead is ${lead.state.toLowerCase()}`;
  if (!briefBearing(lead.body)) return "Lead has no brief to check";
  if (lead.checkOperationId) return "A check is already running";
}
export function leadApproveReason(lead: LeadDetail): string | undefined {
  const check = leadCheckView(lead), approval = leadApprovalView(lead);
  if (lead.state !== "open") return `Only open leads can be approved; this lead is ${lead.state.toLowerCase()}`;
  if (!briefBearing(lead.body)) return "Lead has no brief to approve";
  if (check.kind === "pending") return "A check is running; approve once it passes";
  if (check.kind === "none") return "Check the brief first";
  if (check.kind === "stale") return `The check is for version ${check.version}; check version ${lead.version} first`;
  if (!check.check.ok) return check.check.message || "The current version failed its check";
  if (approval.kind === "current") return "Approved";
}
export function leadPromoteReason(lead: LeadDetail, origin: string): string | undefined {
  const approval = leadApprovalView(lead);
  if (lead.state === "dropped") return "A dropped lead cannot be promoted";
  if (lead.targets.some(target => target.kind === "task" && target.repository === origin)) return `Already promoted to a task in ${origin}`;
  if (approval.kind === "stale") return `The approval is for version ${approval.approval.version}; approve version ${lead.version} first`;
  if (approval.kind === "none") return "Approve the checked version first";
}
export function leadDropReason(lead: LeadDetail): string | undefined {
  if (lead.papercut) return "Close a papercut from its own record";
  if (lead.state !== "open") return `Only open leads can be dropped; this lead is ${lead.state.toLowerCase()}`;
}
export function leadReopenReason(lead: LeadDetail): string | undefined {
  if (lead.state !== "dropped") return "Only a dropped lead can be reopened";
  if (lead.papercut) return "A papercut is never reopened by this action";
}
export function leadPromoteToReason(lead: LeadDetail): string | undefined {
  if (lead.papercut) return "Papercuts promote to tasks";
  if (lead.state === "dropped") return "A dropped lead cannot be promoted";
}

/** Versions listed at once; a long history offers the next page rather than rendering every row. */
export const LEAD_VERSION_PAGE = 8;

type Notice = { kind: "ok" | "error"; text: string };

/** One action's own result or refusal, so a failure in one control never reads as another's outcome. */
function NoticeLine({ notice, label, c }: { notice?: Notice; label: string; c: Colors }) {
  if (!notice) return null;
  return <Text accessibilityRole={notice.kind === "error" ? "alert" : undefined} accessibilityLiveRegion="polite"
    accessibilityLabel={`${label} ${notice.kind === "error" ? "refusal" : "result"}`}
    style={{ color: notice.kind === "error" ? roles(c).danger : roles(c).foreground, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight }}>
    {notice.text}
  </Text>;
}

/** What each action does. A handler resolves with what happened, or rejects with the refusal to show beside it. */
export type LeadActions = {
  onCheck: () => Promise<string>;
  onApprove: () => Promise<string>;
  onPromote: (origin: string) => Promise<string>;
  onDrop: (reason: string) => Promise<string>;
  onReopen: (reason: string) => Promise<string>;
  onPromoteTo: (kind: "question" | "knowledge", reference: string) => Promise<string>;
};
const unloaded: LeadActions = {
  onCheck: async () => { throw new Error("The lead has not loaded yet"); },
  onApprove: async () => { throw new Error("The lead has not loaded yet"); },
  onPromote: async () => { throw new Error("The lead has not loaded yet"); },
  onDrop: async () => { throw new Error("The lead has not loaded yet"); },
  onReopen: async () => { throw new Error("The lead has not loaded yet"); },
  onPromoteTo: async () => { throw new Error("The lead has not loaded yet"); },
};

/**
 * The lead screen (nucleus#868): the brief the operator reads and the version of it
 * that was checked, beside separate Check, Approve and Promote actions, each
 * reporting its own result or refusal. Approval names the checked version, and a
 * version that moved shows its check and approval as stale and asks for the
 * existing recheck. Drop, reopen and the question or knowledge promotion sit in a
 * secondary menu with their reasons. Raw IDs, digests, repositories, targets and
 * every version stay behind Details; a long version list pages honestly.
 */
export function LeadScreen({ read, actions, readVersion, compact, busy, lane, c, onRetry }: {
  read: LeadRead; compact: boolean; busy: boolean;
  /** Null until the record loads; the loading and failed states need no actions. */
  actions: LeadActions | null;
  /** Reads one full version; `lead.get` carries earlier versions as metadata only. */
  readVersion: (version: number) => Promise<LeadVersion | null>;
  /** The lane the lead was opened from, so the screen says where it sits. */
  lane?: { key: string; title: string };
  c: Colors; onRetry: () => void;
}) {
  const r = roles(c);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState(false);
  const [shownVersions, setShownVersions] = useState(LEAD_VERSION_PAGE);
  const [drop, setDrop] = useState(""), [reopen, setReopen] = useState(""), [reference, setReference] = useState("");
  // The checked version's own brief, read on demand: earlier versions arrive as metadata only.
  const [checkedRead, setCheckedRead] = useState<{ version: number; text?: string; error?: string } | null>(null);
  const lead = read.data;
  useEffect(() => { setShownVersions(LEAD_VERSION_PAGE); setDrop(""); setReopen(""); setReference(""); setMore(false); setDetails(false); setCheckedRead(null); }, [lead?.id, lead?.version]);

  const text = { color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight } as const;
  const meta = { color: r.muted, fontSize: type.metadata.fontSize, lineHeight: type.metadata.lineHeight } as const;
  const sectionHeader = { color: r.foreground, fontSize: type.section.fontSize, lineHeight: type.section.lineHeight, fontWeight: "600" } as const;
  const panel = { gap: space.xs, padding: space.sm, borderRadius: radius.control, borderWidth: 1, borderColor: r.border, backgroundColor: r.section } as const;
  // The two columns share a wide row from a zero basis, so a long brief never pushes the check
  // and approval below it; narrow layouts stack each at full width.
  const column = { flexGrow: 1, flexShrink: 1, flexBasis: compact ? "100%" : 0, minWidth: compact ? "100%" : 280, maxWidth: "100%", gap: space.xs } as const;

  const run = async (key: string, action: () => Promise<string>) => {
    setRunning(key);
    setNotices(previous => { const next = { ...previous }; delete next[key]; return next; });
    try {
      const result = await action();
      setNotices(previous => ({ ...previous, [key]: { kind: "ok", text: result } }));
    } catch (error) {
      setNotices(previous => ({ ...previous, [key]: { kind: "error", text: message(error) } }));
    } finally {
      setRunning(null);
    }
  };
  const blocked = busy || running !== null;
  /** Reads the selected earlier version's full text, keeping loading, failure and the text distinct. */
  const showChecked = async (version: number) => {
    setCheckedRead({ version });
    try {
      const found = await readVersion(version);
      if (!found) throw new Error(`Version ${version} is not stored`);
      setCheckedRead({ version, text: found.body });
    } catch (error) {
      setCheckedRead({ version, error: message(error) });
    }
  };

  if (!lead) return <View accessibilityLabel="Lead" style={{ gap: space.xs }}>
    {read.error
      ? <View accessibilityRole="alert" style={{ ...panel, borderColor: r.danger }}>
        <Text style={text}>Couldn’t load this lead: {read.error}</Text>
        <Text style={meta}>No check, approval or action is shown until it loads.</Text>
        <View style={row}><Button small c={c} text="Retry" label="Retry loading the lead" onPress={onRetry} /></View>
      </View>
      : <Text style={meta}>Loading lead…</Text>}
  </View>;

  const checkView = leadCheckView(lead), approvalView = leadApprovalView(lead), brief = briefParts(lead.body);
  const { onCheck, onApprove, onPromote, onDrop, onReopen, onPromoteTo } = actions ?? unloaded;
  const checkReason = leadCheckReason(lead), approveReason = leadApproveReason(lead);
  const dropReason = leadDropReason(lead), reopenReason = leadReopenReason(lead), promoteToReason = leadPromoteToReason(lead);

  const checkBody = () => {
    if (checkView.kind === "pending") return <Text style={text}>A check is running. Its result replaces this text when it lands.</Text>;
    if (checkView.kind === "none") return <Text style={text}>Not checked yet.</Text>;
    if (checkView.kind === "stale") return <View accessibilityRole="alert" accessibilityLabel="Check out of date" style={{ gap: space.xxs }}>
      <Text style={{ ...text, color: r.warning }}>Version {checkView.version} was checked; this is version {lead.version}.</Text>
      <Text style={meta}>The check is out of date. Check the brief again before approving it.</Text>
      <View style={row}><Button small c={c} text="Show the checked brief" label={`Show the brief of version ${checkView.version}`} onPress={() => void showChecked(checkView.version)} /></View>
      {checkedRead?.version === checkView.version && (checkedRead.error
        ? <Text accessibilityRole="alert" style={{ ...meta, color: r.warning }}>Couldn’t load version {checkedRead.version}: {checkedRead.error}</Text>
        : checkedRead.text === undefined
          ? <Text style={meta}>Loading version {checkedRead.version}…</Text>
          : <View accessibilityLabel={`Brief of version ${checkView.version}`} style={{ gap: space.xxs }}>
            <Text style={meta}>Version {checkView.version}, as it was checked:</Text>
            {briefParts(checkedRead.text).text
              ? <Readable text={briefParts(checkedRead.text).text} c={c} />
              : <Text style={text}>That version has no brief text.</Text>}
          </View>)}
    </View>;
    return <View style={{ gap: space.xxs }}>
      <Text style={{ ...text, color: checkView.check.ok ? r.foreground : r.danger }}>{checkLabel(checkView.check)}</Text>
      <Text style={meta}>Version {lead.version} · checked {formatLocalDateTime(checkView.check.checkedAt)}</Text>
    </View>;
  };
  const approvalBody = () => {
    if (approvalView.kind === "none") return <Text style={text}>Not approved.</Text>;
    if (approvalView.kind === "stale") return <View accessibilityRole="alert" accessibilityLabel="Approval out of date" style={{ gap: space.xxs }}>
      <Text style={{ ...text, color: r.warning }}>Version {approvalView.approval.version} was approved; this is version {lead.version}.</Text>
      <Text style={meta}>Check the brief and approve the current version.</Text>
    </View>;
    return <View style={{ gap: space.xxs }}>
      <Text style={text}>{approvalLine(approvalView.approval)}</Text>
      <Text style={meta}>Version {approvalView.approval.version} · approved {formatLocalDateTime(approvalView.approval.approvedAt)}{approvalView.approval.relayed ? " · not the operator's own action" : ""}</Text>
    </View>;
  };

  const versions = [...lead.versions].sort((a, b) => b.version - a.version);
  const shown = versions.slice(0, shownVersions);
  const hidden = versions.length - shown.length;

  return <View accessibilityLabel={`Lead ${lead.title}`} style={{ gap: space.md }}>
    {/* The record sheet's header carries the title, persistently above this scroll; the screen says
        where the lead sits and where it stands. */}
    <View style={{ gap: space.xxs }}>
      <Text style={meta}>{lane ? `${lane.title} · lead` : "Planning lead"}</Text>
      <Text style={meta}>{leadStateWord[lead.state]} · version {lead.version}{lead.author ? ` · ${lead.author}` : ""}</Text>
    </View>
    <View accessibilityLabel={`Decision summary for ${lead.title}`} style={{ ...panel, gap: space.xs }}>
      <Text accessibilityRole="header" style={sectionHeader}>Decision status</Text>
      <Text style={text}>
        {checkView.kind === "pending" ? "Check running" : checkView.kind === "none" ? "Not checked" : checkView.kind === "stale" ? `Check stale · version ${checkView.version}` : checkView.check.ok ? `Current check passed · version ${lead.version}` : `Current check failed · version ${lead.version}`}
        {" · "}{approvalView.kind === "none" ? "Not approved" : approvalView.kind === "stale" ? `Approval stale · version ${approvalView.approval.version}` : `Approved · version ${approvalView.approval.version}`}
      </Text>
      <View style={row}>
        <Button small c={c} text={running === "check" ? "Checking…" : "Check brief"} label="Check the brief" disabled={blocked || Boolean(checkReason)} hint={checkReason} onPress={() => void run("check", onCheck)} />
        <Button small c={c} text={running === "approve" ? "Approving…" : "Approve"} label="Approve the checked version" disabled={blocked || Boolean(approveReason)} hint={approveReason} onPress={() => void run("approve", onApprove)} />
        {lead.repositories.map(repo => {
          const reason = leadPromoteReason(lead, repo.origin), key = `promote:${repo.origin}`;
          return <Button key={repo.origin} small c={c} text={running === key ? "Promoting…" : "Promote to task"} label={lead.repositories.length > 1 ? `Promote to a task in ${repo.origin}` : "Promote to a task"}
            disabled={blocked || Boolean(reason)} hint={reason} onPress={() => void run(key, () => onPromote(repo.origin))} />;
        })}
      </View>
      {[checkReason && `Check: ${checkReason}`, approveReason && `Approve: ${approveReason}`].filter(Boolean).map(reason => <Text key={reason} style={meta}>{reason}</Text>)}
      {lead.repositories.map(repo => {
        const reason = leadPromoteReason(lead, repo.origin);
        return reason ? <Text key={repo.origin} style={meta}>Promote: {reason}</Text> : null;
      })}
      <NoticeLine notice={notices.check} label="Check" c={c} />
      <NoticeLine notice={notices.approve} label="Approve" c={c} />
      {lead.repositories.map(repo => <NoticeLine key={repo.origin} notice={notices[`promote:${repo.origin}`]} label="Promote" c={c} />)}
    </View>
    {read.error && <View accessibilityRole="alert" style={{ ...panel, borderColor: r.warning }}>
      <Text style={{ ...text, color: r.warning }}>Showing the last read of this lead. It may be out of date: {read.error}</Text>
      <View style={row}><Button small c={c} text="Retry refresh" label="Retry refreshing the lead" onPress={onRetry} /></View>
    </View>}

    <View accessibilityLabel="Lead brief and decision" style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: space.md, alignItems: "flex-start" }}>
      <View accessibilityLabel="Lead brief" style={column}>
        <Text accessibilityRole="header" style={sectionHeader}>Brief</Text>
        <View style={panel}>
          {brief.text
            ? <Readable text={brief.text} c={c} />
            : <Text style={text}>No brief written yet.</Text>}
        </View>
      </View>

      <View accessibilityLabel="Check result and approval" style={column}>
        <Text accessibilityRole="header" style={sectionHeader}>Check</Text>
        <View style={panel}>{checkBody()}</View>
        <Text accessibilityRole="header" style={sectionHeader}>Approval</Text>
        <View style={panel}>{approvalBody()}</View>
        <View style={{ gap: space.xs }}>
          <Text style={meta}>Promotion is a separate step. A lead and its approval grant no dispatch authority by themselves.</Text>
        </View>
      </View>
    </View>

    <View accessibilityLabel={`More actions for ${lead.title}`}>
      <Disclosure c={c} label="More actions" expanded={more} onToggle={() => setMore(!more)} />
      {more && <View style={{ gap: space.sm, paddingTop: space.xs }}>
        <View style={{ gap: space.xxs }}>
          <Field c={c} label="Drop reason" value={drop} onChange={setDrop} disabled={blocked || Boolean(dropReason)} />
          <View style={row}>
            <Button small c={c} danger text={running === "drop" ? "Dropping…" : "Drop lead"} label="Drop the lead" disabled={blocked || Boolean(dropReason) || !drop.trim()}
              hint={dropReason} onPress={() => void run("drop", () => onDrop(drop))} />
          </View>
          {dropReason && <Text style={meta}>{dropReason}</Text>}
          <NoticeLine notice={notices.drop} label="Drop" c={c} />
        </View>
        <View style={{ gap: space.xxs }}>
          <Field c={c} label="Reopen reason" value={reopen} onChange={setReopen} disabled={blocked || Boolean(reopenReason)} />
          <View style={row}>
            <Button small c={c} text={running === "reopen" ? "Reopening…" : "Reopen lead"} label="Reopen the lead" disabled={blocked || Boolean(reopenReason) || !reopen.trim()}
              hint={reopenReason} onPress={() => void run("reopen", () => onReopen(reopen))} />
          </View>
          {reopenReason && <Text style={meta}>{reopenReason}</Text>}
          <NoticeLine notice={notices.reopen} label="Reopen" c={c} />
        </View>
        <View style={{ gap: space.xxs }}>
          <Field c={c} label="Question or knowledge reference" value={reference} onChange={setReference} disabled={blocked || Boolean(promoteToReason)}
            detail="Where it landed, such as a question id or the knowledge change on main." />
          <View style={row}>
            {(["question", "knowledge"] as const).map(kind => <Button key={kind} small c={c} disabled={blocked || Boolean(promoteToReason) || !reference.trim()} hint={promoteToReason}
              text={running === `promoteTo:${kind}` ? "Recording…" : kind === "question" ? "Record as question" : "Record as knowledge change"}
              label={kind === "question" ? "Record promotion to a question" : "Record promotion to a knowledge change"}
              onPress={() => void run(`promoteTo:${kind}`, () => onPromoteTo(kind, reference))} />)}
          </View>
          {promoteToReason && <Text style={meta}>{promoteToReason}</Text>}
          {(["question", "knowledge"] as const).map(kind => <NoticeLine key={kind} notice={notices[`promoteTo:${kind}`]}
            label={kind === "question" ? "Question promotion" : "Knowledge promotion"} c={c} />)}
        </View>
        {Boolean(lead.targets.length) && <Text style={meta}>{lead.targets.length} earlier promotion{lead.targets.length === 1 ? "" : "s"} recorded. The links are under Details.</Text>}
      </View>}
    </View>

    <View accessibilityLabel={`Details for ${lead.title}`}>
      <Disclosure c={c} label="Details" expanded={details} onToggle={() => setDetails(!details)} />
      {details && <View style={{ gap: space.xs, paddingTop: space.xs }}>
        <Text selectable style={meta}>Lead id · {lead.id}</Text>
        <Text selectable style={meta}>Digest · {lead.digest ?? "none yet"}</Text>
        <Text selectable style={meta}>Base branch · {lead.baseBranch}</Text>
        <Text selectable accessibilityLabel="Lead repositories" style={meta}>Repositories · {lead.repositories.map(repo => `${repo.origin} (${repo.path})`).join(", ") || "none"}</Text>
        <Text selectable style={meta}>Lanes · {lead.lanes.join(", ") || "none"}</Text>
        {brief.frontmatter && <View style={{ gap: space.xxs }}>
          <Text style={sectionHeader}>Brief frontmatter</Text>
          <Text selectable accessibilityLabel="Brief frontmatter" style={{ ...meta, fontFamily: "monospace" }}>{brief.frontmatter}</Text>
        </View>}
        {Boolean(lead.targets.length) && <View accessibilityLabel="Lead promotion targets" style={{ gap: space.xxs }}>
          <Text style={sectionHeader}>Promotions</Text>
          {lead.targets.map(target => <Text key={`${target.kind}:${target.reference}:${target.at}`} selectable style={meta}>
            {target.kind}{target.repository ? ` · ${target.repository}` : ""} · {target.reference} · {formatLocalDateTime(target.at)}
          </Text>)}
        </View>}
        {Boolean(lead.reopens.length) && <View accessibilityLabel="Lead reopens" style={{ gap: space.xxs }}>
          <Text style={sectionHeader}>Reopens</Text>
          {lead.reopens.map((episode, index) => <View key={`${episode.at}:${index}`} style={{ gap: space.xxs / 2 }}>
            <Text selectable style={meta}>Reopened by {episode.by} · {formatLocalDateTime(episode.at)} · {episode.reason}</Text>
            {episode.drop.reason && <Text selectable style={meta}>Dropped before that: {episode.drop.reason}</Text>}
          </View>)}
        </View>}
        <View accessibilityLabel="Lead versions" style={{ gap: space.xs }}>
          <Text style={sectionHeader}>Versions</Text>
          {hidden > 0 && <Text style={meta}>Showing the latest {shown.length} of {versions.length} versions.</Text>}
          {shown.map(version => <View key={version.version} style={{ gap: space.xxs / 2 }}>
            <Text style={text}>v{version.version} · {version.author} · {formatLocalDateTime(version.createdAt)}{version.version === lead.version ? " · current" : ""}</Text>
            <Text selectable style={meta}>{version.digest ?? "No digest"} · {checkLabel(version.check)} · {version.approval ? `approved for version ${version.approval.version}` : "unapproved"}</Text>
          </View>)}
          {!versions.length && <Text style={meta}>No versions yet.</Text>}
          {hidden > 0 && <View style={row}>
            <Button small c={c} text={`Show ${Math.min(LEAD_VERSION_PAGE, hidden)} more versions`} label={`Show ${Math.min(LEAD_VERSION_PAGE, hidden)} more versions of ${lead.title}`}
              onPress={() => setShownVersions(shownVersions + LEAD_VERSION_PAGE)} />
          </View>}
        </View>
      </View>}
    </View>
  </View>;
}
