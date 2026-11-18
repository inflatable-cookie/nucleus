import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ActionButton,
  Button,
  DropdownSelect,
  HelpPopover,
  HelpTip,
  InlineConfirm,
  Section,
  muted,
  row,
  sectionCard,
  useSectionAutoSave,
  type Colors,
} from "./controls";
import { radius, roles, space, type } from "./design";
import { formatLocalDateTime } from "./date-time-field";
import { errorText } from "./error-text";
import type * as api from "../shared/contracts";
import type { HostDependency, HostView } from "../shared/rpc/hosts";

/*
 * Settings → Hosts (nucleus#1325): every registered host with its status, a
 * Default mark, details on demand and Remove inside the details. The default host
 * picker moved here from Limits so host matters live in one place. Explanations sit
 * behind (?) popovers (Tom, 2026-11-08: minimal labels).
 */

export type HostList = {
  hosts: HostView[];
  defaultHostKind: api.HostKind | null;
};

const small = (c: Colors) => ({
  ...muted(c),
  fontSize: type.metadata.fontSize,
  lineHeight: type.metadata.lineHeight,
});
const STATE_TEXT: Record<HostView["state"], string> = {
  online: "Online",
  offline: "Offline",
  conflict: "Identity conflict",
  unknown: "Unknown",
};

const REMOVE_HELP =
  "Remove forgets this host from Nucleus's list. Threads, workspaces, events and run records keep its ID. If the host connects again, it registers again as normal.";
const DEPENDENTS_HELP =
  "Live tasks, unreleased runs and unsettled effects on this host block Remove; clear them with the ordinary owner verbs first. Repositories route to a host kind, not to this host, so they never block.";

/** The operator default host kind, moved from Limits. */
export function HostDefault({
  c,
  values,
  save,
}: {
  c: Colors;
  values: api.CapacityAuthorityValues | null;
  save: (
    host: api.CapacityAuthorityValues["operatorDefaultHostKind"],
  ) => Promise<void>;
}) {
  const [host, setHost] = useState<
    api.CapacityAuthorityValues["operatorDefaultHostKind"]
  >(values ? values.operatorDefaultHostKind : "paseo");
  const auto = useSectionAutoSave(save);
  useEffect(() => {
    if (values && !auto.saver.busy && !auto.failed)
      setHost(values.operatorDefaultHostKind);
  }, [values?.operatorDefaultHostKind, auto.failed]);
  return (
    <Section
      c={c}
      title="Default host"
      status={auto.status}
      description="New tasks use this host when their repository has no override. If it is offline, Nucleus uses the planner's host. Existing tasks keep their host."
    >
      <DropdownSelect
        c={c}
        label="Default host"
        value={host ?? "inherit"}
        disabled={!values}
        options={[
          { value: "paseo", label: "Paseo" },
          { value: "t3code", label: "T3Code" },
          { value: "bb", label: "BB" },
          { value: "inherit", label: "Planner's host" },
        ]}
        onChange={(value) => {
          const next =
            value === "paseo" || value === "t3code" || value === "bb"
              ? value
              : null;
          setHost(next);
          if (values) auto.enqueue(next);
        }}
      />
    </Section>
  );
}

/** A label with its own (?) popover, anchored to the line. */
function HelpLine({
  c,
  label,
  text,
  children,
}: {
  c: Colors;
  label: string;
  text: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View | null>(null);
  return (
    <View ref={anchor} style={{ ...row, flexWrap: "nowrap" }}>
      {children}
      <HelpTip
        c={c}
        label={label}
        text={text}
        open={open}
        onOpenChange={setOpen}
      />
      {open && <HelpPopover c={c} anchor={anchor} label={label} text={text} />}
    </View>
  );
}

function Detail({
  c,
  label,
  value,
}: {
  c: Colors;
  label: string;
  value: string;
}) {
  return (
    <View style={{ flexDirection: "row", gap: space.sm, minWidth: 0 }}>
      <Text style={{ ...small(c), width: 96, flexShrink: 0 }}>{label}</Text>
      <Text
        selectable
        style={{
          color: roles(c).foreground,
          fontSize: type.metadata.fontSize,
          lineHeight: type.metadata.lineHeight,
          flex: 1,
          minWidth: 0,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/** A dependents row lists this many names before Show all (Tom, 2026-11-18). */
export const DEPENDENT_PREVIEW = 8;

/**
 * Repeated kinds in a long row, most frequent first: "thread cleanup ×417". The
 * kind is the text before " for "; a row with no repeats has no summary.
 */
export function dependencyGroups(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const at = name.indexOf(" for ");
    if (at <= 0) return "";
    const kind = name.slice(0, at);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size >= names.length) return "";
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind))
    .join(" · ");
}

/** One "Depends on it" row: the count, the first few names, and Show all when long. */
function DependencyRow({
  c,
  hostId,
  dependency,
}: {
  c: Colors;
  hostId: string;
  dependency: HostDependency;
}) {
  const [all, setAll] = useState(false);
  const count = dependency.names.length;
  const noun =
    count === 1
      ? dependency.label
      : /[^aeiou]y$/.test(dependency.label)
        ? `${dependency.label.slice(0, -1)}ies`
        : `${dependency.label}s`;
  const long = count > DEPENDENT_PREVIEW;
  const shown =
    long && !all
      ? dependency.names.slice(0, DEPENDENT_PREVIEW)
      : dependency.names;
  // Only effects follow the service's "kind for task" wording; repository paths may contain " for ".
  const groups =
    long && dependency.kind === "effect"
      ? dependencyGroups(dependency.names)
      : "";
  return (
    <View style={{ gap: space.xxs }}>
      <Detail
        c={c}
        label={`${count} ${noun}`}
        value={`${groups ? `${groups}\n` : ""}${shown.join(", ")}${long && !all ? ", …" : ""}`}
      />
      {long && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${all ? "Show fewer" : "Show all"} ${count} ${noun} on ${hostId}`}
          accessibilityState={{ expanded: all }}
          onPress={() => setAll((value) => !value)}
          style={{ marginLeft: 96 + space.sm, alignSelf: "flex-start" }}
        >
          <Text
            style={{
              color: roles(c).accent,
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
            }}
          >
            {all ? "Show fewer" : "Show all"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const ago = (at: string, now: number) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return seconds < 90
    ? `${seconds} s ago`
    : `${Math.round(seconds / 60)} min ago`;
};

/** One host: the summary line, and its details and Remove when open. */
export function HostRow({
  c,
  host,
  remove,
  now = Date.now(),
}: {
  c: Colors;
  host: HostView;
  remove: (hostId: string) => Promise<void>;
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const r = roles(c);
  const stateColor =
    host.state === "online"
      ? r.success
      : host.state === "offline"
        ? r.muted
        : r.warning;
  const name = `${host.label} host`;
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await remove(host.id);
      setConfirming(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      accessibilityLabel={`${name} ${host.id}, ${STATE_TEXT[host.state]}${host.isDefault ? ", default" : ""}`}
      style={{ ...sectionCard(c), gap: space.xs }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Hide" : "Show"} details for ${host.id}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          minWidth: 0,
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: radius.control,
            backgroundColor: stateColor,
            flexShrink: 0,
          }}
        />
        <Text
          numberOfLines={1}
          style={{
            color: r.foreground,
            fontWeight: "600",
            fontSize: type.body.fontSize,
            lineHeight: type.body.lineHeight,
            flexShrink: 0,
          }}
        >
          {host.label}
        </Text>
        <Text
          numberOfLines={1}
          style={{ ...small(c), flexShrink: 1, minWidth: 0 }}
        >
          {host.id}
        </Text>
        {host.isDefault && (
          <Text
            accessibilityLabel="Default host"
            style={{
              color: r.accent,
              fontSize: type.metadata.fontSize,
              lineHeight: type.metadata.lineHeight,
              flexShrink: 0,
            }}
          >
            Default
          </Text>
        )}
        <View style={{ flex: 1 }} />
        <Text
          style={{
            color: stateColor,
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
            flexShrink: 0,
          }}
        >
          {STATE_TEXT[host.state]}
        </Text>
        <Text
          style={{
            color: r.accent,
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
            flexShrink: 0,
          }}
        >
          {open ? "Hide" : "Show"}
        </Text>
      </Pressable>
      {host.state !== "online" && host.reason ? (
        <Text
          accessibilityLabel={`${host.id} offline reason`}
          style={{
            color: host.state === "offline" ? r.muted : r.warning,
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
          }}
        >
          {host.reason}
        </Text>
      ) : null}
      {open && (
        <View style={{ gap: space.xxs }}>
          <Detail c={c} label="ID" value={host.id} />
          <Detail c={c} label="Endpoint" value={host.endpoint} />
          {host.connectedAt ? (
            <Detail
              c={c}
              label="Connected"
              value={formatLocalDateTime(host.connectedAt)}
            />
          ) : host.lastSeenAt ? (
            <Detail
              c={c}
              label="Last seen"
              value={formatLocalDateTime(host.lastSeenAt)}
            />
          ) : null}
          {host.versions.map((version) => (
            <Detail
              key={version.label}
              c={c}
              label={version.label}
              value={version.value}
            />
          ))}
          {host.heartbeat && (
            <Detail
              c={c}
              label="Heartbeat"
              value={
                host.heartbeat.at
                  ? `${ago(host.heartbeat.at, now)}${host.heartbeat.stale ? " · stale" : ""}`
                  : "None yet"
              }
            />
          )}
          <HelpLine
            c={c}
            label={`Depends on ${host.id}`}
            text={DEPENDENTS_HELP}
          >
            <Text style={{ ...small(c), fontWeight: "600" }}>
              Depends on it
            </Text>
          </HelpLine>
          {host.dependents.length ? (
            host.dependents.map((dependency) => (
              <DependencyRow
                key={dependency.kind}
                c={c}
                hostId={host.id}
                dependency={dependency}
              />
            ))
          ) : (
            <Text style={small(c)}>Nothing</Text>
          )}
          <View style={{ ...row, justifyContent: "flex-end" }}>
            <ActionButton
              c={c}
              action="remove"
              label={`Remove ${host.id}`}
              disabled={busy || confirming}
              onPress={() => {
                setError("");
                setConfirming(true);
              }}
            />
          </View>
          {confirming &&
            (host.removalBlockers.length ? (
              <View
                accessibilityRole="alert"
                accessibilityLabel={`${host.id} cannot be removed`}
                style={{ gap: space.xxs }}
              >
                <HelpLine c={c} label={`Remove ${host.id}`} text={REMOVE_HELP}>
                  <Text
                    style={{
                      color: r.warning,
                      fontSize: type.metadata.fontSize,
                      lineHeight: type.metadata.lineHeight,
                      flexShrink: 1,
                    }}
                  >
                    Can't remove this host yet:
                  </Text>
                </HelpLine>
                {host.removalBlockers.map((reason) => (
                  <Text
                    key={reason}
                    style={{
                      color: r.warning,
                      fontSize: type.metadata.fontSize,
                      lineHeight: type.metadata.lineHeight,
                    }}
                  >{`· ${reason}`}</Text>
                ))}
                <View style={row}>
                  <Button
                    small
                    c={c}
                    text="Close"
                    label={`Close the removal notice for ${host.id}`}
                    onPress={() => setConfirming(false)}
                  />
                </View>
              </View>
            ) : (
              <HelpLine c={c} label={`Remove ${host.id}`} text={REMOVE_HELP}>
                <InlineConfirm
                  c={c}
                  question="Remove this host?"
                  confirmLabel="Remove"
                  label={`host ${host.id}`}
                  busy={busy}
                  onConfirm={() => void confirm()}
                  onCancel={() => setConfirming(false)}
                />
              </HelpLine>
            ))}
          {error ? (
            <Text
              accessibilityRole="alert"
              style={{
                color: r.danger,
                fontSize: type.metadata.fontSize,
                lineHeight: type.metadata.lineHeight,
              }}
            >
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Settings → Hosts: the default host picker, then one row per registered host. */
export function HostsPanel({
  c,
  list,
  loading,
  loadError,
  retry,
  defaultValues,
  saveDefaultHost,
  remove,
}: {
  c: Colors;
  list: HostList | undefined;
  loading: boolean;
  loadError: unknown;
  retry: () => void;
  defaultValues: api.CapacityAuthorityValues | null;
  saveDefaultHost: (
    host: api.CapacityAuthorityValues["operatorDefaultHostKind"],
  ) => Promise<void>;
  remove: (hostId: string) => Promise<void>;
}) {
  return (
    <View>
      <HostDefault c={c} values={defaultValues} save={saveDefaultHost} />
      <Section
        c={c}
        title="Registered hosts"
        last
        description="Every host Nucleus has seen. A disconnect never removes a host; Remove does, once it is offline and nothing depends on it."
      >
        {loadError ? (
          <View style={{ gap: space.xs }}>
            <Text
              accessibilityRole="alert"
              style={{
                color: roles(c).warning,
                fontSize: type.body.fontSize,
                lineHeight: type.body.lineHeight,
              }}
            >{`Couldn't read the hosts: ${errorText(loadError)}`}</Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Retry"
                label="Retry reading the hosts"
                onPress={retry}
              />
            </View>
          </View>
        ) : null}
        {!list && loading && (
          <Text accessibilityLiveRegion="polite" style={muted(c)}>
            Reading the hosts…
          </Text>
        )}
        {list && !list.hosts.length && (
          <Text style={muted(c)}>
            None yet. A host registers when it connects.
          </Text>
        )}
        {list && list.hosts.length > 0 && (
          <View style={{ gap: space.sm }}>
            {list.hosts.map((host) => (
              <HostRow key={host.id} c={c} host={host} remove={remove} />
            ))}
          </View>
        )}
      </Section>
    </View>
  );
}
