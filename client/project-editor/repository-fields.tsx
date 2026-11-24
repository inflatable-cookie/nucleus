import { useEngineFeatures } from "../engine-features";
import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  DropdownSelect,
  Field,
  FieldCaption,
  NumberStepper,
  row,
  type Colors,
} from "../controls";
import { roles, space, type } from "../design";
import {
  identityOf,
  joinCommand,
  splitCommand,
  type ProjectRepository,
} from "../project-helpers";
import {
  PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES,
  VALIDATION_TIMEOUT_MAX_MS,
  type RepositorySetInput,
  type RepositorySettings,
} from "../../shared/contracts";
import type { ProjectEditActions, ProjectSaves, SaveOp } from "./types";
import { Pair } from "./common";

const CHECKS_HELP =
  "Required gates only the checks GitHub requires for the base branch; the rest are recorded as advisory. Needs GitHub's required-check settings to be readable for this repository.";
const REVIEWER_HELP =
  "Account that posts formal reviews. Its token stays in the login keychain.";
const HOST_HELP =
  "Choose a preferred host for new tasks, or Inherit the operator default. The worker profile may choose another host; dispatched tasks keep theirs.";
const MERGE_HELP = "Runs on every task's prospective merge.";
const STAGED_HELP = "A staged QA is edited with `nucleus repository.set`.";
const MERGE_TIMEOUT_MAX_MIN = VALIDATION_TIMEOUT_MAX_MS / 60_000;
const MERGE_TIMEOUT_DEFAULT_MIN = 15;
const minutes = (ms: number | undefined, fallback: number, max: number) =>
  ms ? Math.min(max, Math.max(1, Math.round(ms / 60_000))) : fallback;

/** The operator's per-repository settings. Each field is its own `repository.set` patch; an empty field clears its setting. */
export function RepositoryFields({
  c,
  repo,
  label,
  settings,
  disabled,
  saves,
  setRepository,
}: {
  c: Colors;
  repo: ProjectRepository;
  label: string;
  settings: RepositorySettings | null;
  disabled: boolean;
  saves: ProjectSaves;
  setRepository: ProjectEditActions["setRepository"];
}) {
  const features = useEngineFeatures();
  const r = roles(c);
  const id = identityOf(repo);
  const key = (field: string) => `repo:${id}:${field}`;
  const patch = (
    field: string,
    value: Omit<RepositorySetInput, "repository">,
    op: Partial<SaveOp> = {},
    delay = 0,
  ) =>
    saves.queue(
      key(field),
      { run: () => setRepository({ repository: id, ...value }), ...op },
      delay,
    );
  const server = useRef(settings);
  server.current = settings;
  const qa = settings?.qa ?? null,
    validation = settings?.validation ?? null;
  const [command, setCommand] = useState(qa?.argv ? joinCommand(qa.argv) : "");
  const [checks, setChecks] = useState(settings?.checksPolicy ?? "all");
  const [hostKind, setHostKind] = useState(settings?.hostKind ?? "inherit");
  const [reviewer, setReviewer] = useState(settings?.reviewer?.login ?? "");
  const [mergeCommand, setMergeCommand] = useState(
    validation ? joinCommand(validation.argv) : "",
  );
  const [mergeTimeout, setMergeTimeout] = useState(
    minutes(
      validation?.timeoutMs,
      MERGE_TIMEOUT_DEFAULT_MIN,
      MERGE_TIMEOUT_MAX_MIN,
    ),
  );
  // Follow the server when nothing is waiting.
  const revision = `${settings?.revision ?? -1}:${settings?.updatedAt ?? ""}`;
  useEffect(() => {
    if (!saves.quiet()) return;
    setCommand(qa?.argv ? joinCommand(qa.argv) : "");
    setChecks(settings?.checksPolicy ?? "all");
    setHostKind(settings?.hostKind ?? "inherit");
    setReviewer(settings?.reviewer?.login ?? "");
    setMergeCommand(validation ? joinCommand(validation.argv) : "");
    setMergeTimeout(
      minutes(
        validation?.timeoutMs,
        MERGE_TIMEOUT_DEFAULT_MIN,
        MERGE_TIMEOUT_MAX_MIN,
      ),
    );
  }, [saves.landed, revision]);
  const writeQa = (next: { command?: string }) => {
    const value = {
      command,
      ...next,
    };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) {
      saves.hold(key("qa"), `QA: ${parsed.error}`);
      return;
    }
    if (!parsed.argv.length) {
      patch("qa", { qa: null }, {}, 600);
      return;
    }
    if (parsed.argv.length > 32) {
      saves.hold(key("qa"), "QA takes at most 32 words");
      return;
    }
    patch(
      "qa",
      {
        qa: {
          argv: parsed.argv,
          ...(qa?.schedule ? { schedule: null } : {}),
        },
      },
      {},
      600,
    );
  };
  const writeMerge = (next: { command?: string; timeout?: number }) => {
    const value = { command: mergeCommand, timeout: mergeTimeout, ...next };
    const parsed = splitCommand(value.command);
    if ("error" in parsed) {
      saves.hold(key("validation"), `Merge check: ${parsed.error}`);
      return;
    }
    if (!parsed.argv.length) {
      patch("validation", { validation: null }, {}, 600);
      return;
    }
    if (parsed.argv.length > 32) {
      saves.hold(key("validation"), "Merge check takes at most 32 words");
      return;
    }
    patch(
      "validation",
      {
        validation: {
          argv: parsed.argv,
          timeoutMs: value.timeout * 60_000,
          maxOutputBytes:
            validation?.maxOutputBytes ?? PROJECT_QA_DEFAULT_MAX_OUTPUT_BYTES,
          ...(validation
            ? { terminationGraceMs: validation.terminationGraceMs }
            : {}),
        },
      },
      {},
      600,
    );
  };
  const changeReviewer = (text: string) => {
    setReviewer(text);
    const login = text.trim();
    if (login && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login)) {
      saves.hold(key("reviewer"), "Reviewer must be a GitHub login");
      return;
    }
    if (login.length > 200) {
      saves.hold(key("reviewer"), "Reviewer is over 200 characters");
      return;
    }
    patch("reviewer", { reviewer: login ? { login } : null }, {}, 600);
  };
  const changeChecks = (value: string) => {
    const policyValue = value === "required" ? "required" : "all";
    setChecks(policyValue);
    // A refusal (GitHub's required checks unreadable) puts the dropdown back.
    patch(
      "checksPolicy",
      { checksPolicy: policyValue },
      { revert: () => setChecks(server.current?.checksPolicy ?? "all") },
    );
  };
  const changeHost = (value: string) => {
    // Inherit clears the repository override; named kinds pin new tasks to that host kind.
    const next =
      value === "t3code" || value === "bb" || value === "paseo" ? value : null;
    setHostKind(value);
    patch(
      "hostKind",
      { hostKind: next },
      { revert: () => setHostKind(server.current?.hostKind ?? "inherit") },
    );
  };
  const hasMerge = Boolean(mergeCommand.trim());
  // Rust engine (Spec 070 ruling 8): the repository keeps its base branch, the
  // GitHub checks a merge waits for, and the hung-tool limit. QA (ruling 12),
  // host choice (ruling 5) and merge commands (ruling 13) are retired.
  if (features.engine === "rust")
    return (
      <RustRepositoryFields
        c={c}
        label={label}
        settings={settings}
        disabled={disabled}
        save={(field, value, delay) => patch(field, value, {}, delay)}
        flush={saves.flush}
      />
    );

  return (
    <View style={{ gap: space.sm }}>
      {qa?.stages ? (
        <View style={{ ...row }}>
          <FieldCaption c={c} text="QA" help={STAGED_HELP} />
          <Text
            accessibilityLabel={`QA for ${label}`}
            style={{
              color: r.foreground,
              fontSize: type.body.fontSize,
              lineHeight: type.body.lineHeight,
            }}
          >
            Staged · {qa.stages.length}{" "}
            {qa.stages.length === 1 ? "step" : "steps"}
          </Text>
        </View>
      ) : (
        <Pair>
          <Field
            c={c}
            label="QA"
            a11yLabel={`QA command for ${label}`}
            placeholder="Command"
            value={command}
            disabled={disabled}
            onChange={(text) => {
              setCommand(text);
              writeQa({ command: text });
            }}
            onBlur={saves.flush}
          />
        </Pair>
      )}
      <Pair>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Host" help={HOST_HELP} />
          <DropdownSelect
            c={c}
            hideLabel
            label={`Host for ${label}`}
            value={hostKind ?? "inherit"}
            disabled={disabled}
            options={[
              { value: "inherit", label: "Inherit" },
              { value: "paseo", label: "Paseo" },
              { value: "t3code", label: "T3Code" },
              { value: "bb", label: "BB" },
            ]}
            onChange={changeHost}
          />
        </View>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Checks" help={CHECKS_HELP} />
          <DropdownSelect
            c={c}
            hideLabel
            label={`Checks for ${label}`}
            value={checks}
            disabled={disabled}
            options={[
              { value: "all", label: "All" },
              { value: "required", label: "Required" },
            ]}
            onChange={changeChecks}
          />
        </View>
      </Pair>
      <Pair>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Reviewer" help={REVIEWER_HELP} />
          <Field
            c={c}
            label=""
            hideLabel
            a11yLabel={`Reviewer for ${label}`}
            placeholder="GitHub login"
            value={reviewer}
            disabled={disabled}
            onChange={changeReviewer}
            onBlur={saves.flush}
          />
        </View>
      </Pair>
      <Pair>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Merge check" help={MERGE_HELP} />
          <Field
            c={c}
            label=""
            hideLabel
            a11yLabel={`Merge check for ${label}`}
            placeholder="Command"
            value={mergeCommand}
            disabled={disabled}
            onChange={(text) => {
              setMergeCommand(text);
              writeMerge({ command: text });
            }}
            onBlur={saves.flush}
          />
        </View>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Timeout" />
          <View style={{ flexDirection: "row" }}>
            <NumberStepper
              c={c}
              a11yLabel={`Merge check timeout for ${label}`}
              unit="min"
              value={mergeTimeout}
              min={1}
              max={MERGE_TIMEOUT_MAX_MIN}
              disabled={disabled || !hasMerge}
              onChange={(next) => {
                setMergeTimeout(next);
                writeMerge({ timeout: next });
              }}
              onCommit={saves.flush}
            />
          </View>
        </View>
      </Pair>
    </View>
  );
}

function RustRepositoryFields({
  c,
  label,
  settings,
  disabled,
  save,
  flush,
}: {
  c: Colors;
  label: string;
  settings: RepositorySettings | null;
  disabled: boolean;
  save: (field: string, value: Omit<RepositorySetInput, "repository">, delay: number) => void;
  flush: () => void;
}) {
  const [checks, setChecks] = useState((settings?.requiredChecks ?? []).join(", "));
  const [hung, setHung] = useState(settings?.toolQuietLimitMinutes ?? 30);
  return (
    <View style={{ gap: space.sm }}>
      <Pair>
        <View style={{ gap: space.xxs }}>
          <FieldCaption c={c} text="Base branch" />
          <Text
            accessibilityLabel={`Base branch for ${label}`}
            style={{ color: c.foreground, fontSize: type.body.fontSize }}
          >
            {settings?.base ?? "Unresolved"}
          </Text>
        </View>
        <Field
          c={c}
          label="Checks"
          a11yLabel={`Required GitHub checks for ${label}`}
          placeholder="ci, lint"
          value={checks}
          disabled={disabled}
          onChange={(next) => {
            setChecks(next);
            save(
              "requiredChecks",
              { requiredChecks: [...new Set(next.split(",").map((name) => name.trim()).filter(Boolean))] },
              600,
            );
          }}
          onBlur={flush}
        />
      </Pair>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Hung tool limit" />
        <View style={{ flexDirection: "row" }}>
          <NumberStepper
            c={c}
            a11yLabel={`Hung tool limit for ${label}`}
            unit="min"
            value={hung}
            min={1}
            max={240}
            disabled={disabled}
            onChange={(next) => {
              setHung(next);
              save("toolQuietLimitMinutes", { toolQuietLimitMinutes: next }, 600);
            }}
            onCommit={flush}
          />
        </View>
      </View>
    </View>
  );
}
