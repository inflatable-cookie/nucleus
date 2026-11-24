import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  Button,
  Field,
  Section,
  TabRow,
  muted,
  row,
  type Colors,
} from "../controls";
import { roles, space, type as typeScale } from "../design";
import { EngineProfiles } from "./engine-profiles";
import { EngineProjects } from "./engine-projects";
import {
  dispatchView,
  hostsView,
  storageView,
  usage,
  useEditor,
} from "./engine-settings-api";
import {
  EditChoice,
  EditNumber,
  EditText,
  SettingValue,
  humanLabel,
} from "./engine-settings-fields";

const sections = [
  { id: "dispatch", text: "Dispatch" },
  { id: "profiles", text: "Profiles" },
  { id: "projects", text: "Projects" },
  { id: "hosts", text: "Hosts" },
  { id: "storage", text: "Storage" },
] as const;

export function EngineSettings({
  c,
  canEdit,
  onBack,
}: {
  c: Colors;
  canEdit: boolean;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<(typeof sections)[number]["id"]>("dispatch");
  const disabled = !canEdit;
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: roles(c).canvas }}>
      <View
        style={{ ...row, padding: space.sm, backgroundColor: roles(c).header }}
      >
        <Button c={c} small text="Board" icon="ArrowLeft" onPress={onBack} />
        <Text
          accessibilityRole="header"
          style={{ ...typeScale.heading, color: c.foreground }}
        >
          Settings
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={{
          padding: space.md,
          maxWidth: 760,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <TabRow
          c={c}
          label="Settings sections"
          tabs={sections}
          value={tab}
          onChange={setTab}
        />
        {disabled && (
          <Text style={{ ...muted(c), paddingTop: space.sm }}>
            Only the operator can edit Settings.
          </Text>
        )}
        {tab === "dispatch" && <DispatchSettings c={c} disabled={disabled} />}
        {tab === "profiles" && <EngineProfiles c={c} disabled={disabled} />}
        {tab === "projects" && <EngineProjects c={c} disabled={disabled} />}
        {tab === "hosts" && <HostSettings c={c} disabled={disabled} />}
        {tab === "storage" && <StorageSettings c={c} disabled={disabled} />}
      </ScrollView>
    </View>
  );
}

function DispatchSettings({ c, disabled }: { c: Colors; disabled: boolean }) {
  const editor = useEditor("dispatch", dispatchView);
  const value = editor.query.data?.settings.value;
  const [invalidEnd, setInvalidEnd] = useState(false);
  if (!value)
    return (
      <Text style={muted(c)}>
        {editor.query.error?.message ?? "Loading dispatch…"}
      </Text>
    );
  const temporary = value.usage !== "low" && value.usage !== "normal";
  return (
    <Section c={c} title="Dispatch" status={editor.status}>
      <EditChoice
        c={c}
        label="Usage"
        value={value.usage}
        choices={usage.options}
        disabled={disabled}
        onSave={(usage) => {
          setInvalidEnd(false);
          editor.save((value) => ({ ...value, usage, usageUntilMs: null }));
        }}
      />
      {temporary && (
        <Section
          c={c}
          title="Temporary usage"
          description="Use an ISO date and time such as 2026-11-24T18:00:00Z. Leave it blank to keep the level until you change it."
          last
        >
          <EditText
            c={c}
            label="Ends at"
            value={
              value.usageUntilMs
                ? (new Date(value.usageUntilMs).toJSON() ?? "")
                : ""
            }
            disabled={disabled}
            onSave={(text) => {
              const usageUntilMs = text ? Date.parse(text) : null;
              if (
                usageUntilMs !== null &&
                (!Number.isFinite(usageUntilMs) || usageUntilMs <= 0)
              ) {
                setInvalidEnd(true);
                return;
              }
              setInvalidEnd(false);
              editor.save((value) => ({ ...value, usageUntilMs }));
            }}
          />
          {invalidEnd && (
            <Text accessibilityRole="alert" style={{ color: c.statusWarning }}>
              Enter a valid date and time.
            </Text>
          )}
        </Section>
      )}
      <EditNumber
        c={c}
        label="Slots"
        value={value.slots}
        disabled={disabled}
        onSave={(slots) => editor.save((value) => ({ ...value, slots }))}
      />
      <EditNumber
        c={c}
        label="Allowance"
        unit="min"
        value={value.allowanceMinutes}
        disabled={disabled}
        onSave={(allowanceMinutes) =>
          editor.save((value) => ({ ...value, allowanceMinutes }))
        }
        onClear={() =>
          editor.save((value) => ({ ...value, allowanceMinutes: null }))
        }
      />
      {value.providerLimitCooldownSeconds !== undefined && (
        <EditNumber
          c={c}
          label="Provider cooldown"
          unit="sec"
          value={value.providerLimitCooldownSeconds}
          disabled={disabled}
          onSave={(providerLimitCooldownSeconds) =>
            editor.save((value) => ({ ...value, providerLimitCooldownSeconds }))
          }
        />
      )}
    </Section>
  );
}

function HostSettings({ c, disabled }: { c: Colors; disabled: boolean }) {
  const editor = useEditor("hosts", hostsView);
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState(
    "NUCLEUS_ENGINE_T3_BEARER",
  );
  const view = editor.query.data;
  if (!view)
    return (
      <Text style={muted(c)}>
        {editor.query.error?.message ?? "Loading hosts…"}
      </Text>
    );
  const current = view.settings.value.t3;
  return (
    <Section
      c={c}
      title="T3"
      status={editor.status}
      description="The credential reference is an environment variable name. Connection changes apply the next time the engine starts."
    >
      <SettingValue
        c={c}
        label="Active endpoint"
        value={view.active.endpoint}
      />
      <SettingValue
        c={c}
        label="Status"
        value={humanLabel(view.active.status)}
      />
      {current ? (
        <>
          <EditText
            c={c}
            label="Endpoint"
            value={current.endpoint}
            disabled={disabled}
            onSave={(endpoint) =>
              editor.save(({ t3 }) => ({ t3: t3 && { ...t3, endpoint } }))
            }
          />
          <EditText
            c={c}
            label="Credential reference"
            value={current.credentialRef}
            disabled={disabled}
            onSave={(credentialRef) =>
              editor.save(({ t3 }) => ({ t3: t3 && { ...t3, credentialRef } }))
            }
          />
        </>
      ) : (
        !disabled && (
          <>
            <Field
              c={c}
              label="Endpoint"
              value={endpoint}
              onChange={setEndpoint}
            />
            <Field
              c={c}
              label="Credential reference"
              value={credentialRef}
              onChange={setCredentialRef}
            />
            <Button
              c={c}
              text="Add T3"
              disabled={!endpoint.trim() || !credentialRef.trim()}
              onPress={() =>
                editor.save(() => ({
                  t3: {
                    endpoint: endpoint.trim(),
                    credentialRef: credentialRef.trim(),
                  },
                }))
              }
            />
          </>
        )
      )}
    </Section>
  );
}

function StorageSettings({ c, disabled }: { c: Colors; disabled: boolean }) {
  const editor = useEditor("storage", storageView);
  const view = editor.query.data;
  if (!view)
    return (
      <Text style={muted(c)}>
        {editor.query.error?.message ?? "Loading storage…"}
      </Text>
    );
  const { workVolume, retention } = view.settings.value;
  const roots = [
    { key: "workRoot", label: "Work" },
    { key: "scratchRoot", label: "Scratch" },
    { key: "logRoot", label: "Logs" },
  ] as const;
  return (
    <>
      <Section
        c={c}
        title="Storage"
        status={editor.status}
        description="Root changes apply the next time the engine starts. Clearing an override uses the default."
      >
        {workVolume && (
          <SettingValue c={c} label="Pinned volume" value={workVolume.mount} />
        )}
        <SettingValue c={c} label="Database" value={view.active.databaseRoot} />
        {roots.map(({ key, label }) => (
          <View key={key} style={{ gap: space.xs }}>
            <SettingValue c={c} label={label} value={view.active[key]} />
            <EditText
              c={c}
              label={label + " root override"}
              value={view.settings.value[key] ?? ""}
              disabled={disabled}
              onSave={(path) =>
                editor.save((value) => ({ ...value, [key]: path || null }))
              }
            />
          </View>
        ))}
      </Section>
      <Section c={c} title="Backups" last>
        <SettingValue c={c} label="Location" value={view.active.backupRoot} />
        <EditNumber
          c={c}
          label="Keep newest"
          value={retention.keepNewest}
          disabled={disabled}
          onSave={(keepNewest) =>
            editor.save((value) => ({
              ...value,
              retention: { ...value.retention, keepNewest },
            }))
          }
        />
        <EditNumber
          c={c}
          label="Maximum age"
          unit="days"
          value={retention.maxAgeDays}
          disabled={disabled}
          onSave={(maxAgeDays) =>
            editor.save((value) => ({
              ...value,
              retention: { ...value.retention, maxAgeDays },
            }))
          }
          onClear={() =>
            editor.save((value) => ({
              ...value,
              retention: { ...value.retention, maxAgeDays: null },
            }))
          }
        />
        {view.backups && (
          <>
            {!view.backups.complete && (
              <Text style={{ color: c.statusWarning }}>
                Some backups could not be verified.
              </Text>
            )}
            {view.backups.verified.map((backup) => (
              <SettingValue
                key={backup.id}
                c={c}
                label={backup.id}
                value={backup.createdAt}
              />
            ))}
            {view.backups.complete && !view.backups.verified.length && (
              <Text style={muted(c)}>No verified backups.</Text>
            )}
          </>
        )}
      </Section>
    </>
  );
}
