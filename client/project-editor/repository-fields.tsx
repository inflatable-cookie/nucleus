import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button, DropdownSelect, Field, FieldCaption, NumberStepper, muted, row, type Colors } from "../controls";
import { roles, space, type } from "../design";
import { identityOf, joinCommand, splitCommand, type ProjectRepository } from "../project-helpers";
import { PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES, PROJECT_QA_TIMEOUT_MAX_MS, VALIDATION_TIMEOUT_MAX_MS, type RepositorySetInput, type RepositorySettings } from "../../shared/contracts";
import type { ProjectEditActions, ProjectSaves, SaveOp } from "./types";
import { Pair } from "./common";

const CHECKS_HELP = "Required gates only the checks GitHub requires for the base branch; the rest are recorded as advisory. Needs GitHub's required-check settings to be readable for this repository.";
const REVIEWER_HELP = "Account that posts formal reviews. Its token stays in the login keychain.";
const HOST_HELP = "Paseo is the default host. T3Code is trial opt-in: new tasks on this repository dispatch there. Live tasks keep the host they started on.";
const MERGE_HELP = "Runs on every task's prospective merge.";
const STAGED_HELP = "A staged QA is edited with `nucleus repository.set`.";
const QA_TIMEOUT_MAX_MIN = PROJECT_QA_TIMEOUT_MAX_MS / 60_000;
const MERGE_TIMEOUT_MAX_MIN = VALIDATION_TIMEOUT_MAX_MS / 60_000;
const QA_TIMEOUT_DEFAULT_MIN = 60, MERGE_TIMEOUT_DEFAULT_MIN = 15, AFTER_MERGES_DEFAULT = 10;
const minutes = (ms: number | undefined, fallback: number, max: number) => ms ? Math.min(max, Math.max(1, Math.round(ms / 60_000))) : fallback;

/** The operator's per-repository settings. Each field is its own `repository.set` patch; an empty field clears its setting. */
export function RepositoryFields({ c, repo, label, settings, disabled, saves, setRepository }: {
  c: Colors; repo: ProjectRepository; label: string; settings: RepositorySettings | null; disabled: boolean;
  saves: ProjectSaves; setRepository: ProjectEditActions["setRepository"];
}) {
  const r = roles(c);
  const id = identityOf(repo);
  const key = (field: string) => `repo:${id}:${field}`;
  const patch = (field: string, value: Omit<RepositorySetInput, "repository">, op: Partial<SaveOp> = {}, delay = 0) =>
    saves.queue(key(field), { run: () => setRepository({ repository: id, ...value }), ...op }, delay);
  const server = useRef(settings); server.current = settings;
  const qa = settings?.qa ?? null, validation = settings?.validation ?? null;
  const [command, setCommand] = useState(qa?.argv ? joinCommand(qa.argv) : "");
  const [qaTimeout, setQaTimeout] = useState(minutes(qa?.timeoutMs, QA_TIMEOUT_DEFAULT_MIN, QA_TIMEOUT_MAX_MIN));
  const [scheduled, setScheduled] = useState(Boolean(qa?.schedule));
  const [afterMerges, setAfterMerges] = useState(qa?.schedule?.afterMerges ?? AFTER_MERGES_DEFAULT);
  const [checks, setChecks] = useState(settings?.checksPolicy ?? "all");
  const [hostKind, setHostKind] = useState(settings?.hostKind ?? "paseo");
  const [reviewer, setReviewer] = useState(settings?.reviewer?.login ?? "");
  const [mergeCommand, setMergeCommand] = useState(validation ? joinCommand(validation.argv) : "");
  const [mergeTimeout, setMergeTimeout] = useState(minutes(validation?.timeoutMs, MERGE_TIMEOUT_DEFAULT_MIN, MERGE_TIMEOUT_MAX_MIN));
  // Follow the server when nothing is waiting.
  const revision = `${settings?.revision ?? -1}:${settings?.updatedAt ?? ""}`;
  useEffect(() => {
    if (!saves.quiet()) return;
    setCommand(qa?.argv ? joinCommand(qa.argv) : "");
    setQaTimeout(minutes(qa?.timeoutMs, QA_TIMEOUT_DEFAULT_MIN, QA_TIMEOUT_MAX_MIN));
    setScheduled(Boolean(qa?.schedule)); setAfterMerges(qa?.schedule?.afterMerges ?? AFTER_MERGES_DEFAULT);
    setChecks(settings?.checksPolicy ?? "all");
    setHostKind(settings?.hostKind ?? "paseo");
    setReviewer(settings?.reviewer?.login ?? "");
    setMergeCommand(validation ? joinCommand(validation.argv) : "");
    setMergeTimeout(minutes(validation?.timeoutMs, MERGE_TIMEOUT_DEFAULT_MIN, MERGE_TIMEOUT_MAX_MIN));
  }, [saves.landed, revision]);
  const writeQa = (next: { command?: string; timeout?: number; scheduled?: boolean; afterMerges?: number }) => {
    const value = { command, timeout: qaTimeout, scheduled, afterMerges, ...next };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) { saves.hold(key("qa"), `QA: ${parsed.error}`); return; }
    if (!parsed.argv.length) { patch("qa", { qa: null }, {}, 600); return; }
    if (parsed.argv.length > 32) { saves.hold(key("qa"), "QA takes at most 32 words"); return; }
    const kept = qa && !qa.stages ? { maxOutputBytes: qa.maxOutputBytes, terminationGraceMs: qa.terminationGraceMs } : {};
    patch("qa", { qa: { ...kept, argv: parsed.argv, timeoutMs: value.timeout * 60_000,
      schedule: value.scheduled ? { afterMerges: value.afterMerges, maxIntervalHours: qa?.schedule?.maxIntervalHours ?? 24 } : null } }, {}, 600);
  };
  const writeMerge = (next: { command?: string; timeout?: number }) => {
    const value = { command: mergeCommand, timeout: mergeTimeout, ...next };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) { saves.hold(key("validation"), `Merge check: ${parsed.error}`); return; }
    if (!parsed.argv.length) { patch("validation", { validation: null }, {}, 600); return; }
    if (parsed.argv.length > 32) { saves.hold(key("validation"), "Merge check takes at most 32 words"); return; }
    patch("validation", { validation: { argv: parsed.argv, timeoutMs: value.timeout * 60_000,
      maxOutputBytes: validation?.maxOutputBytes ?? PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES,
      ...(validation ? { terminationGraceMs: validation.terminationGraceMs } : {}) } }, {}, 600);
  };
  const changeReviewer = (text: string) => {
    setReviewer(text);
    const login = text.trim();
    if (login && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) { saves.hold(key("reviewer"), "Reviewer must be a GitHub login"); return; }
    if (login.length > 200) { saves.hold(key("reviewer"), "Reviewer is over 200 characters"); return; }
    patch("reviewer", { reviewer: login ? { login } : null }, {}, 600);
  };
  const changeChecks = (value: string) => {
    const policyValue = value === "required" ? "required" : "all";
    setChecks(policyValue);
    // A refusal (GitHub's required checks unreadable) puts the dropdown back.
    patch("checksPolicy", { checksPolicy: policyValue }, { revert: () => setChecks(server.current?.checksPolicy ?? "all") });
  };
  const changeHost = (value: string) => {
    const next = value === "t3code" ? "t3code" : "paseo";
    setHostKind(next);
    patch("hostKind", { hostKind: next }, { revert: () => setHostKind(server.current?.hostKind ?? "paseo") });
  };
  const hasCommand = Boolean(command.trim());
  const hasMerge = Boolean(mergeCommand.trim());

  return <View style={{ gap: space.sm }}>
    {qa?.stages
      ? <View style={{ ...row }}>
          <FieldCaption c={c} text="QA" help={STAGED_HELP} />
          <Text accessibilityLabel={`QA for ${label}`} style={{ color: r.foreground, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>Staged · {qa.stages.length} {qa.stages.length === 1 ? "step" : "steps"}</Text>
        </View>
      : <>
          <Pair>
            <Field c={c} label="QA" a11yLabel={`QA command for ${label}`} placeholder="Command" value={command} disabled={disabled}
              onChange={text => { setCommand(text); writeQa({ command: text }); }} onBlur={saves.flush} />
            <View style={{ gap: space.xxs }}>
              <FieldCaption c={c} text="Timeout" />
              <View style={{ flexDirection: "row" }}>
                <NumberStepper c={c} a11yLabel={`QA timeout for ${label}`} unit="min" value={qaTimeout} min={1} max={QA_TIMEOUT_MAX_MIN} disabled={disabled || !hasCommand}
                  onChange={next => { setQaTimeout(next); writeQa({ timeout: next }); }} onCommit={saves.flush} />
              </View>
            </View>
          </Pair>
          <View style={{ ...row }}>
            <FieldCaption c={c} text="Schedule" />
            <Button matchField c={c} checked={scheduled} text={scheduled ? "On" : "Off"} label={`QA schedule for ${label}`} disabled={disabled || !hasCommand}
              onPress={() => { setScheduled(!scheduled); writeQa({ scheduled: !scheduled }); }} />
            {scheduled && <>
              <Text style={muted(c)}>After</Text>
              <NumberStepper c={c} a11yLabel={`Merges between QA runs for ${label}`} unit="merges" value={afterMerges} min={1} max={1000} disabled={disabled || !hasCommand}
                onChange={next => { setAfterMerges(next); writeQa({ afterMerges: next }); }} onCommit={saves.flush} />
            </>}
          </View>
        </>}
    <Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Host" help={HOST_HELP} />
        <DropdownSelect c={c} hideLabel label={`Host for ${label}`} value={hostKind} disabled={disabled} options={[{ value: "paseo", label: "Paseo" }, { value: "t3code", label: "T3Code" }]} onChange={changeHost} />
      </View>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Checks" help={CHECKS_HELP} />
        <DropdownSelect c={c} hideLabel label={`Checks for ${label}`} value={checks} disabled={disabled} options={[{ value: "all", label: "All" }, { value: "required", label: "Required" }]} onChange={changeChecks} />
      </View>
    </Pair>
    <Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Reviewer" help={REVIEWER_HELP} />
        <Field c={c} label="" hideLabel a11yLabel={`Reviewer for ${label}`} placeholder="GitHub login" value={reviewer} disabled={disabled} onChange={changeReviewer} onBlur={saves.flush} />
      </View>
    </Pair>
    <Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Merge check" help={MERGE_HELP} />
        <Field c={c} label="" hideLabel a11yLabel={`Merge check for ${label}`} placeholder="Command" value={mergeCommand} disabled={disabled}
          onChange={text => { setMergeCommand(text); writeMerge({ command: text }); }} onBlur={saves.flush} />
      </View>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Timeout" />
        <View style={{ flexDirection: "row" }}>
          <NumberStepper c={c} a11yLabel={`Merge check timeout for ${label}`} unit="min" value={mergeTimeout} min={1} max={MERGE_TIMEOUT_MAX_MIN} disabled={disabled || !hasMerge}
            onChange={next => { setMergeTimeout(next); writeMerge({ timeout: next }); }} onCommit={saves.flush} />
        </View>
      </View>
    </Pair>
  </View>;
}
