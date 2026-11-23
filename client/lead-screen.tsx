import { errorText as message } from "./error-text";
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Lead, LeadDetail, LeadVersion } from "../shared/contracts";
import {
  hasBriefFrontmatter,
  leadApprovalView,
  leadCheckView,
} from "../shared/lead-status";
export { leadApprovalView, leadCheckView } from "../shared/lead-status";
import { formatLocalDateTime } from "../shared/date-time";
import {
  Button,
  Disclosure,
  Field,
  row,
  useCardFill,
  type Colors,
} from "./controls";
import { radius, roles, space, toneWash, type } from "./design";
import { Readable } from "./readable-text";
import { ParkFields, ParkedNote } from "./park-controls";
import { defaultRecheckDate, recheckIsoFromDate } from "../shared/parking";

/** The lead record as read. `data` is undefined until the first read completes, so loading never looks empty. */
export type LeadRead = { data?: LeadDetail; error?: string };

/** The newest version, other than the current one, whose check the history keeps. */
export const leadStateWord: Record<Lead["state"], string> = {
  open: "Open",
  promoted: "Promoted",
  dropped: "Dropped",
  closed: "Closed",
};
/**
 * A brief's body without its frontmatter. The frontmatter is routing mechanics, so it is
 * read under Details and never shown as the operator's text (Tom, 2026-11-07).
 */
export function briefParts(body: string): {
  frontmatter: string | null;
  text: string;
} {
  if (!hasBriefFrontmatter(body)) return { frontmatter: null, text: body };
  const end = body.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: null, text: body };
  const after = body.indexOf("\n", end + 4);
  return {
    frontmatter: body.slice(0, after < 0 ? body.length : after).trim(),
    text: after < 0 ? "" : body.slice(after + 1).trim(),
  };
}
export const checkLabel = (check: Lead["check"]) =>
  !check
    ? "Unchecked"
    : check.ok
      ? check.message
        ? `Checks passed · ${check.message}`
        : "Checks passed"
      : check.message
        ? `Checks failed · ${check.message}`
        : "Checks failed";

/** Who approved which version, and whether an agent relayed the operator's authority (Tom, 2026-09-26). */
export function approvalLine(approval: NonNullable<Lead["approval"]>): string {
  const who = approval.relayed
    ? `Approved by ${approval.approver}, relayed with the operator's authority`
    : `Approved by ${approval.approver}`;
  return approval.note ? `${who} · ${approval.note}` : who;
}

/** Versions listed at once; a long history offers the next page rather than rendering every row. */
export const LEAD_VERSION_PAGE = 8;

type Notice = { kind: "ok" | "error"; text: string };

/** One action's own result or refusal, so a failure in one control never reads as another's outcome. */
function NoticeLine({
  notice,
  label,
  c,
}: {
  notice?: Notice;
  label: string;
  c: Colors;
}) {
  if (!notice) return null;
  return (
    <Text
      accessibilityRole={notice.kind === "error" ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${label} ${notice.kind === "error" ? "refusal" : "result"}`}
      style={{
        color: notice.kind === "error" ? roles(c).danger : roles(c).foreground,
        fontSize: type.metadata.fontSize,
        lineHeight: type.metadata.lineHeight,
      }}
    >
      {notice.text}
    </Text>
  );
}

/** What each action does. A handler resolves with what happened, or rejects with the refusal to show beside it. */
export type LeadActions = {
  onCheck: () => Promise<string>;
  onApprove: () => Promise<string>;
  onPromote: (origin: string) => Promise<string>;
  onDrop: (reason: string) => Promise<string>;
  onReopen: (reason: string) => Promise<string>;
  /** Nucleus#1543: `revisitAt` is null for a park with no recheck day. */
  onPark: (reason: string, revisitAt: string | null) => Promise<string>;
  onUnpark: () => Promise<string>;
  onPromoteTo: (
    kind: "question" | "knowledge",
    reference: string,
  ) => Promise<string>;
};
const unloaded: LeadActions = {
  onCheck: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onApprove: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onPromote: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onDrop: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onReopen: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onPark: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onUnpark: async () => {
    throw new Error("The lead has not loaded yet");
  },
  onPromoteTo: async () => {
    throw new Error("The lead has not loaded yet");
  },
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
export function LeadScreen({
  read,
  actions,
  readVersion,
  compact,
  busy,
  lane,
  c,
  onRetry,
}: {
  read: LeadRead;
  compact: boolean;
  busy: boolean;
  /** Null until the record loads; the loading and failed states need no actions. */
  actions: LeadActions | null;
  /** Reads one full version; `lead.get` carries earlier versions as metadata only. */
  readVersion: (version: number) => Promise<LeadVersion | null>;
  /** The lane the lead was opened from, so the screen says where it sits. */
  lane?: { key: string; title: string };
  c: Colors;
  onRetry: () => void;
}) {
  const r = roles(c);
  const fill = useCardFill(c);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState(false);
  const [shownVersions, setShownVersions] = useState(LEAD_VERSION_PAGE);
  const [drop, setDrop] = useState(""),
    [reopen, setReopen] = useState(""),
    [reference, setReference] = useState("");
  // Nucleus#1543: the park reason and the day to check again, which starts two weeks out.
  const [parkNote, setParkNote] = useState(""),
    [parkDay, setParkDay] = useState(() => defaultRecheckDate());
  // The checked version's own brief, read on demand: earlier versions arrive as metadata only.
  const [checkedRead, setCheckedRead] = useState<{
    version: number;
    text?: string;
    error?: string;
  } | null>(null);
  const lead = read.data;
  useEffect(() => {
    setShownVersions(LEAD_VERSION_PAGE);
    setDrop("");
    setReopen("");
    setReference("");
    setMore(false);
    setDetails(false);
    setCheckedRead(null);
  }, [lead?.id, lead?.version]);

  const text = {
    color: r.foreground,
    fontSize: type.body.fontSize,
    lineHeight: type.body.lineHeight,
  } as const;
  const meta = {
    color: r.muted,
    fontSize: type.metadata.fontSize,
    lineHeight: type.metadata.lineHeight,
  } as const;
  const sectionHeader = {
    color: r.foreground,
    fontSize: type.section.fontSize,
    lineHeight: type.section.lineHeight,
    fontWeight: "600",
  } as const;
  const panel = {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.control,
    backgroundColor: fill,
  } as const;
  // The two columns share a wide row from a zero basis, so a long brief never pushes the check
  // and approval below it; narrow layouts stack each at full width.
  const column = {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: compact ? "100%" : 0,
    minWidth: compact ? "100%" : 280,
    maxWidth: "100%",
    gap: space.xs,
  } as const;

  const run = async (key: string, action: () => Promise<string>) => {
    setRunning(key);
    setNotices((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    try {
      const result = await action();
      setNotices((previous) => ({
        ...previous,
        [key]: { kind: "ok", text: result },
      }));
    } catch (error) {
      setNotices((previous) => ({
        ...previous,
        [key]: { kind: "error", text: message(error) },
      }));
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

  if (!lead)
    return (
      <View accessibilityLabel="Lead" style={{ gap: space.xs }}>
        {read.error ? (
          <View
            accessibilityRole="alert"
            style={{ ...panel, backgroundColor: toneWash(r.danger, fill) }}
          >
            <Text style={text}>Couldn’t load this lead: {read.error}</Text>
            <Text style={meta}>
              No check, approval or action is shown until it loads.
            </Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Retry"
                label="Retry loading the lead"
                onPress={onRetry}
              />
            </View>
          </View>
        ) : (
          <Text style={meta}>Loading lead…</Text>
        )}
      </View>
    );

  const checkView = leadCheckView(lead),
    approvalView = leadApprovalView(lead),
    brief = briefParts(lead.body);
  const {
    onCheck,
    onApprove,
    onPromote,
    onDrop,
    onReopen,
    onPark,
    onUnpark,
    onPromoteTo,
  } = actions ?? unloaded;
  const {
    check: checkReason,
    approve: approveReason,
    drop: dropReason,
    reopen: reopenReason,
    promoteTo: promoteToReason,
    park: parkReason,
    unpark: unparkReason,
  } = lead.actions;

  const checkBody = () => {
    if (checkView.kind === "pending")
      return (
        <Text style={text}>
          A check is running. Its result replaces this text when it lands.
        </Text>
      );
    if (checkView.kind === "none")
      return <Text style={text}>Not checked yet.</Text>;
    if (checkView.kind === "stale")
      return (
        <View
          accessibilityRole="alert"
          accessibilityLabel="Check out of date"
          style={{ gap: space.xxs }}
        >
          <Text style={{ ...text, color: r.warning }}>
            Version {checkView.version} was checked; this is version{" "}
            {lead.version}.
          </Text>
          <Text style={meta}>
            The check is out of date. Check the brief again before approving it.
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Show the checked brief"
              label={`Show the brief of version ${checkView.version}`}
              onPress={() => void showChecked(checkView.version)}
            />
          </View>
          {checkedRead?.version === checkView.version &&
            (checkedRead.error ? (
              <Text
                accessibilityRole="alert"
                style={{ ...meta, color: r.warning }}
              >
                Couldn’t load version {checkedRead.version}: {checkedRead.error}
              </Text>
            ) : checkedRead.text === undefined ? (
              <Text style={meta}>Loading version {checkedRead.version}…</Text>
            ) : (
              <View
                accessibilityLabel={`Brief of version ${checkView.version}`}
                style={{ gap: space.xxs }}
              >
                <Text style={meta}>
                  Version {checkView.version}, as it was checked:
                </Text>
                {briefParts(checkedRead.text).text ? (
                  <Readable text={briefParts(checkedRead.text).text} c={c} />
                ) : (
                  <Text style={text}>That version has no brief text.</Text>
                )}
              </View>
            ))}
        </View>
      );
    return (
      <View style={{ gap: space.xxs }}>
        <Text
          style={{
            ...text,
            color: checkView.check.ok ? r.foreground : r.danger,
          }}
        >
          {checkLabel(checkView.check)}
        </Text>
        <Text style={meta}>
          Version {lead.version} · checked{" "}
          {formatLocalDateTime(checkView.check.checkedAt)}
        </Text>
      </View>
    );
  };
  const approvalBody = () => {
    if (approvalView.kind === "none")
      return <Text style={text}>Not approved.</Text>;
    if (approvalView.kind === "stale")
      return (
        <View
          accessibilityRole="alert"
          accessibilityLabel="Approval out of date"
          style={{ gap: space.xxs }}
        >
          <Text style={{ ...text, color: r.warning }}>
            Version {approvalView.approval.version} was approved; this is
            version {lead.version}.
          </Text>
          <Text style={meta}>
            Check the brief and approve the current version.
          </Text>
        </View>
      );
    return (
      <View style={{ gap: space.xxs }}>
        <Text style={text}>{approvalLine(approvalView.approval)}</Text>
        <Text style={meta}>
          Version {approvalView.approval.version} · approved{" "}
          {formatLocalDateTime(approvalView.approval.approvedAt)}
          {approvalView.approval.relayed
            ? " · not the operator's own action"
            : ""}
        </Text>
      </View>
    );
  };

  const versions = [...lead.versions].sort((a, b) => b.version - a.version);
  const shown = versions.slice(0, shownVersions);
  const hidden = versions.length - shown.length;

  return (
    <View accessibilityLabel={`Lead ${lead.title}`} style={{ gap: space.md }}>
      {/* The record sheet's header carries the title, persistently above this scroll; the screen says
        where the lead sits and where it stands. */}
      <View style={{ gap: space.xxs }}>
        <Text style={meta}>
          {lane ? `${lane.title} · lead` : "Planning lead"}
        </Text>
        <Text style={meta}>
          {leadStateWord[lead.state]} · version {lead.version}
          {lead.author ? ` · ${lead.author}` : ""}
        </Text>
      </View>
      <View
        accessibilityLabel={`Decision summary for ${lead.title}`}
        style={{ ...panel, gap: space.xs }}
      >
        <Text accessibilityRole="header" style={sectionHeader}>
          Decision status
        </Text>
        <Text style={text}>
          {checkView.kind === "pending"
            ? "Check running"
            : checkView.kind === "none"
              ? "Not checked"
              : checkView.kind === "stale"
                ? `Check stale · version ${checkView.version}`
                : checkView.check.ok
                  ? `Current check passed · version ${lead.version}`
                  : `Current check failed · version ${lead.version}`}
          {" · "}
          {approvalView.kind === "none"
            ? "Not approved"
            : approvalView.kind === "stale"
              ? `Approval stale · version ${approvalView.approval.version}`
              : `Approved · version ${approvalView.approval.version}`}
        </Text>
        {(lead.parked || lead.recheck) && (
          <View style={{ gap: space.xxs }}>
            <ParkedNote
              c={c}
              parked={lead.parked ?? null}
              recheck={lead.recheck ?? null}
            />
            {lead.parked && (
              <View style={row}>
                <Button
                  small
                  c={c}
                  text={running === "unpark" ? "Returning…" : "Unpark"}
                  label="Return the lead to the to-do list"
                  disabled={blocked || Boolean(unparkReason)}
                  hint={unparkReason ?? undefined}
                  onPress={() => void run("unpark", onUnpark)}
                />
              </View>
            )}
            <NoticeLine notice={notices.unpark} label="Unpark" c={c} />
          </View>
        )}
        <View style={row}>
          <Button
            small
            c={c}
            text={running === "check" ? "Checking…" : "Check brief"}
            label="Check the brief"
            disabled={blocked || Boolean(checkReason)}
            hint={checkReason ?? undefined}
            onPress={() => void run("check", onCheck)}
          />
          <Button
            small
            c={c}
            text={running === "approve" ? "Approving…" : "Approve"}
            label="Approve the checked version"
            disabled={blocked || Boolean(approveReason)}
            hint={approveReason ?? undefined}
            onPress={() => void run("approve", onApprove)}
          />
          {lead.repositories.map((repo) => {
            const reason = lead.actions.promote.find(
                (item) => item.origin === repo.origin,
              )?.reason,
              key = `promote:${repo.origin}`;
            return (
              <Button
                key={repo.origin}
                small
                c={c}
                text={running === key ? "Promoting…" : "Promote to task"}
                label={
                  lead.repositories.length > 1
                    ? `Promote to a task in ${repo.origin}`
                    : "Promote to a task"
                }
                disabled={blocked || Boolean(reason)}
                hint={reason ?? undefined}
                onPress={() => void run(key, () => onPromote(repo.origin))}
              />
            );
          })}
        </View>
        {[
          checkReason && `Check: ${checkReason}`,
          approveReason && `Approve: ${approveReason}`,
        ]
          .filter(Boolean)
          .map((reason) => (
            <Text key={reason} style={meta}>
              {reason}
            </Text>
          ))}
        {lead.repositories.map((repo) => {
          const reason = lead.actions.promote.find(
            (item) => item.origin === repo.origin,
          )?.reason;
          return reason ? (
            <Text key={repo.origin} style={meta}>
              Promote: {reason}
            </Text>
          ) : null;
        })}
        <NoticeLine notice={notices.check} label="Check" c={c} />
        <NoticeLine notice={notices.approve} label="Approve" c={c} />
        {lead.repositories.map((repo) => (
          <NoticeLine
            key={repo.origin}
            notice={notices[`promote:${repo.origin}`]}
            label="Promote"
            c={c}
          />
        ))}
      </View>
      {read.error && (
        <View
          accessibilityRole="alert"
          style={{ ...panel, backgroundColor: toneWash(r.warning, fill) }}
        >
          <Text style={{ ...text, color: r.warning }}>
            Showing the last read of this lead. It may be out of date:{" "}
            {read.error}
          </Text>
          <View style={row}>
            <Button
              small
              c={c}
              text="Retry refresh"
              label="Retry refreshing the lead"
              onPress={onRetry}
            />
          </View>
        </View>
      )}

      <View
        accessibilityLabel="Lead brief and decision"
        style={{
          flexDirection: compact ? "column" : "row",
          flexWrap: "wrap",
          gap: space.md,
          alignItems: "flex-start",
        }}
      >
        <View accessibilityLabel="Lead brief" style={column}>
          <Text accessibilityRole="header" style={sectionHeader}>
            Brief
          </Text>
          <View style={panel}>
            {brief.text ? (
              <Readable text={brief.text} c={c} />
            ) : (
              <Text style={text}>No brief written yet.</Text>
            )}
          </View>
        </View>

        <View accessibilityLabel="Check result and approval" style={column}>
          <Text accessibilityRole="header" style={sectionHeader}>
            Check
          </Text>
          <View style={panel}>{checkBody()}</View>
          <Text accessibilityRole="header" style={sectionHeader}>
            Approval
          </Text>
          <View style={panel}>{approvalBody()}</View>
          <View style={{ gap: space.xs }}>
            <Text style={meta}>
              Promotion is a separate step. A lead and its approval grant no
              dispatch authority by themselves.
            </Text>
          </View>
        </View>
      </View>

      <View accessibilityLabel={`More actions for ${lead.title}`}>
        <Disclosure
          c={c}
          label="More actions"
          expanded={more}
          onToggle={() => setMore(!more)}
        />
        {more && (
          <View style={{ gap: space.sm, paddingTop: space.xs }}>
            <View style={{ gap: space.xxs }}>
              <ParkFields
                c={c}
                reason={parkNote}
                onReasonChange={setParkNote}
                date={parkDay}
                onDateChange={setParkDay}
                disabled={blocked || Boolean(parkReason)}
              />
              <View style={row}>
                <Button
                  small
                  c={c}
                  text={running === "park" ? "Parking…" : "Park lead"}
                  label="Park the lead"
                  disabled={
                    blocked ||
                    Boolean(parkReason) ||
                    !parkNote.trim() ||
                    (Boolean(parkDay.trim()) && !recheckIsoFromDate(parkDay))
                  }
                  hint={
                    parkReason ??
                    (parkDay.trim() && !recheckIsoFromDate(parkDay)
                      ? "Check again on needs a day after today, as YYYY-MM-DD, or blank"
                      : undefined)
                  }
                  onPress={() =>
                    void run("park", () =>
                      onPark(
                        parkNote,
                        parkDay.trim() ? recheckIsoFromDate(parkDay) : null,
                      ),
                    )
                  }
                />
              </View>
              {parkReason && <Text style={meta}>{parkReason}</Text>}
              <NoticeLine notice={notices.park} label="Park" c={c} />
            </View>
            <View style={{ gap: space.xxs }}>
              <Field
                c={c}
                label="Drop reason"
                value={drop}
                onChange={setDrop}
                disabled={blocked || Boolean(dropReason)}
              />
              <View style={row}>
                <Button
                  small
                  c={c}
                  danger
                  text={running === "drop" ? "Dropping…" : "Drop lead"}
                  label="Drop the lead"
                  disabled={blocked || Boolean(dropReason) || !drop.trim()}
                  hint={dropReason ?? undefined}
                  onPress={() => void run("drop", () => onDrop(drop))}
                />
              </View>
              {dropReason && <Text style={meta}>{dropReason}</Text>}
              <NoticeLine notice={notices.drop} label="Drop" c={c} />
            </View>
            <View style={{ gap: space.xxs }}>
              <Field
                c={c}
                label="Reopen reason"
                value={reopen}
                onChange={setReopen}
                disabled={blocked || Boolean(reopenReason)}
              />
              <View style={row}>
                <Button
                  small
                  c={c}
                  text={running === "reopen" ? "Reopening…" : "Reopen lead"}
                  label="Reopen the lead"
                  disabled={blocked || Boolean(reopenReason) || !reopen.trim()}
                  hint={reopenReason ?? undefined}
                  onPress={() => void run("reopen", () => onReopen(reopen))}
                />
              </View>
              {reopenReason && <Text style={meta}>{reopenReason}</Text>}
              <NoticeLine notice={notices.reopen} label="Reopen" c={c} />
            </View>
            <View style={{ gap: space.xxs }}>
              <Field
                c={c}
                label="Question or knowledge reference"
                value={reference}
                onChange={setReference}
                disabled={blocked || Boolean(promoteToReason)}
                detail="Where it landed, such as a question id or the knowledge change on main."
              />
              <View style={row}>
                {(["question", "knowledge"] as const).map((kind) => (
                  <Button
                    key={kind}
                    small
                    c={c}
                    disabled={
                      blocked || Boolean(promoteToReason) || !reference.trim()
                    }
                    hint={promoteToReason ?? undefined}
                    text={
                      running === `promoteTo:${kind}`
                        ? "Recording…"
                        : kind === "question"
                          ? "Record as question"
                          : "Record as knowledge change"
                    }
                    label={
                      kind === "question"
                        ? "Record promotion to a question"
                        : "Record promotion to a knowledge change"
                    }
                    onPress={() =>
                      void run(`promoteTo:${kind}`, () =>
                        onPromoteTo(kind, reference),
                      )
                    }
                  />
                ))}
              </View>
              {promoteToReason && <Text style={meta}>{promoteToReason}</Text>}
              {(["question", "knowledge"] as const).map((kind) => (
                <NoticeLine
                  key={kind}
                  notice={notices[`promoteTo:${kind}`]}
                  label={
                    kind === "question"
                      ? "Question promotion"
                      : "Knowledge promotion"
                  }
                  c={c}
                />
              ))}
            </View>
            {Boolean(lead.targets.length) && (
              <Text style={meta}>
                {lead.targets.length} earlier promotion
                {lead.targets.length === 1 ? "" : "s"} recorded. The links are
                under Details.
              </Text>
            )}
          </View>
        )}
      </View>

      <View accessibilityLabel={`Details for ${lead.title}`}>
        <Disclosure
          c={c}
          label="Details"
          expanded={details}
          onToggle={() => setDetails(!details)}
        />
        {details && (
          <View style={{ gap: space.xs, paddingTop: space.xs }}>
            <Text selectable style={meta}>
              Lead id · {lead.id}
            </Text>
            <Text selectable style={meta}>
              Digest · {lead.digest ?? "none yet"}
            </Text>
            <Text selectable style={meta}>
              Base branch · {lead.baseBranch}
            </Text>
            <Text
              selectable
              accessibilityLabel="Lead repositories"
              style={meta}
            >
              Repositories ·{" "}
              {lead.repositories
                .map((repo) => `${repo.origin} (${repo.path})`)
                .join(", ") || "none"}
            </Text>
            <Text selectable style={meta}>
              Lanes · {lead.lanes.join(", ") || "none"}
            </Text>
            {brief.frontmatter && (
              <View style={{ gap: space.xxs }}>
                <Text style={sectionHeader}>Brief frontmatter</Text>
                <Text
                  selectable
                  accessibilityLabel="Brief frontmatter"
                  style={{ ...meta, fontFamily: "monospace" }}
                >
                  {brief.frontmatter}
                </Text>
              </View>
            )}
            {Boolean(lead.targets.length) && (
              <View
                accessibilityLabel="Lead promotion targets"
                style={{ gap: space.xxs }}
              >
                <Text style={sectionHeader}>Promotions</Text>
                {lead.targets.map((target) => (
                  <Text
                    key={`${target.kind}:${target.reference}:${target.at}`}
                    selectable
                    style={meta}
                  >
                    {target.kind}
                    {target.repository ? ` · ${target.repository}` : ""} ·{" "}
                    {target.reference} · {formatLocalDateTime(target.at)}
                  </Text>
                ))}
              </View>
            )}
            {Boolean(lead.reopens.length) && (
              <View
                accessibilityLabel="Lead reopens"
                style={{ gap: space.xxs }}
              >
                <Text style={sectionHeader}>Reopens</Text>
                {lead.reopens.map((episode, index) => (
                  <View
                    key={`${episode.at}:${index}`}
                    style={{ gap: space.xxs / 2 }}
                  >
                    <Text selectable style={meta}>
                      Reopened by {episode.by} ·{" "}
                      {formatLocalDateTime(episode.at)} · {episode.reason}
                    </Text>
                    {episode.drop.reason && (
                      <Text selectable style={meta}>
                        Dropped before that: {episode.drop.reason}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            )}
            <View accessibilityLabel="Lead versions" style={{ gap: space.xs }}>
              <Text style={sectionHeader}>Versions</Text>
              {hidden > 0 && (
                <Text style={meta}>
                  Showing the latest {shown.length} of {versions.length}{" "}
                  versions.
                </Text>
              )}
              {shown.map((version) => (
                <View key={version.version} style={{ gap: space.xxs / 2 }}>
                  <Text style={text}>
                    v{version.version} · {version.author} ·{" "}
                    {formatLocalDateTime(version.createdAt)}
                    {version.version === lead.version ? " · current" : ""}
                  </Text>
                  <Text selectable style={meta}>
                    {version.digest ?? "No digest"} ·{" "}
                    {checkLabel(version.check)} ·{" "}
                    {version.approval
                      ? `approved for version ${version.approval.version}`
                      : "unapproved"}
                  </Text>
                </View>
              ))}
              {!versions.length && <Text style={meta}>No versions yet.</Text>}
              {hidden > 0 && (
                <View style={row}>
                  <Button
                    small
                    c={c}
                    text={`Show ${Math.min(LEAD_VERSION_PAGE, hidden)} more versions`}
                    label={`Show ${Math.min(LEAD_VERSION_PAGE, hidden)} more versions of ${lead.title}`}
                    onPress={() =>
                      setShownVersions(shownVersions + LEAD_VERSION_PAGE)
                    }
                  />
                </View>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}
