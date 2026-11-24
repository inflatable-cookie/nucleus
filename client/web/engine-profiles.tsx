import { useState } from "react";
import { Text, View } from "react-native";
import {
  Button,
  Field,
  FieldCaption,
  InlineConfirm,
  Section,
  StopSlider,
  muted,
  type Colors,
} from "../controls";
import { space } from "../design";
import {
  capabilities,
  efforts,
  profilesView,
  providers,
  useEditor,
  weights,
  type NamedProfile,
} from "./engine-settings-api";
import {
  EditChoice,
  EditText,
  EditToggle,
  SettingsDisclosure,
  humanLabel,
} from "./engine-settings-fields";

const effortChoices = ["default", ...efforts.options] as const;

export function EngineProfiles({
  c,
  disabled,
}: {
  c: Colors;
  disabled: boolean;
}) {
  const editor = useEditor("profiles", profilesView);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] =
    useState<NamedProfile["selection"]["provider"]>("codex");
  const [adding, setAdding] = useState(false);
  const view = editor.query.data;
  if (!view)
    return (
      <Text style={muted(c)}>
        {editor.query.error?.message ?? "Loading profiles…"}
      </Text>
    );
  const { profiles, pausedGroups } = view.settings.value;
  const groups = [
    ...new Set(
      profiles
        .flatMap((profile) => (profile.group ? [profile.group] : []))
        .concat(pausedGroups ?? []),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return (
    <>
      <Section c={c} title="Profiles" status={editor.status}>
        {profiles.map((profile) => (
          <ProfileSettings
            key={profile.selection.id}
            c={c}
            profile={profile}
            disabled={disabled}
            update={(edit) =>
              editor.save((value) => ({
                ...value,
                profiles: value.profiles.map((candidate) =>
                  candidate.selection.id === profile.selection.id
                    ? edit(candidate)
                    : candidate,
                ),
              }))
            }
            remove={() =>
              editor.save((value) => ({
                ...value,
                profiles: value.profiles.filter(
                  (candidate) =>
                    candidate.selection.id !== profile.selection.id,
                ),
              }))
            }
          />
        ))}
        {!profiles.length && (
          <Text style={muted(c)}>No profiles configured.</Text>
        )}
        {!disabled && (
          <SettingsDisclosure c={c} label="Add profile">
            <View style={{ gap: space.sm }}>
              <Field c={c} label="Name" value={name} onChange={setName} />
              <EditChoice
                c={c}
                label="Provider"
                value={provider}
                choices={providers.options}
                disabled={adding}
                onSave={setProvider}
              />
              <Field c={c} label="Model" value={model} onChange={setModel} />
              <Button
                c={c}
                text="Add profile"
                disabled={adding || !name.trim() || !model.trim()}
                onPress={() => {
                  const title = name.trim();
                  const modelId = model.trim();
                  setAdding(true);
                  void editor
                    .save((value) => {
                      const ids = Object.fromEntries(
                        value.profiles.map((profile) => [
                          profile.selection.id,
                          true,
                        ]),
                      );
                      return {
                        ...value,
                        profiles: [
                          ...value.profiles,
                          {
                            name: title,
                            selection: {
                              id: uniqueProfileId(title, ids),
                              provider,
                              model: modelId,
                              effort: null,
                              capability: "worker",
                              weight: "default",
                            },
                          },
                        ],
                      };
                    })
                    .then((saved) => {
                      if (saved) {
                        setName("");
                        setModel("");
                      }
                      setAdding(false);
                    });
                }}
              />
            </View>
          </SettingsDisclosure>
        )}
      </Section>
      {pausedGroups && groups.length > 0 && (
        <Section
          c={c}
          title="Subscriptions"
          description="Pause dispatch for all profiles in a group."
          last
        >
          {groups.map((group) => (
            <EditToggle
              key={group}
              c={c}
              label={group}
              checked={pausedGroups.includes(group)}
              disabled={disabled}
              onSave={(paused) =>
                editor.save((value) => ({
                  ...value,
                  pausedGroups: paused
                    ? [...new Set([...(value.pausedGroups ?? []), group])]
                    : (value.pausedGroups ?? []).filter(
                        (entry) => entry !== group,
                      ),
                }))
              }
            />
          ))}
        </Section>
      )}
    </>
  );
}

function ProfileSettings({
  c,
  profile,
  disabled,
  update,
  remove,
}: {
  c: Colors;
  profile: NamedProfile;
  disabled: boolean;
  update: (edit: (profile: NamedProfile) => NamedProfile) => void;
  remove: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const selection = profile.selection;
  const select = (change: Partial<NamedProfile["selection"]>) =>
    update((value) => ({
      ...value,
      selection: { ...value.selection, ...change },
    }));
  return (
    <SettingsDisclosure c={c} label={profile.name}>
      <View style={{ gap: space.sm }}>
        <EditText
          c={c}
          label="Name"
          value={profile.name}
          disabled={disabled}
          onSave={(name) => update((value) => ({ ...value, name }))}
        />
        <EditChoice
          c={c}
          label="Provider"
          value={selection.provider}
          choices={providers.options}
          disabled={disabled}
          onSave={(provider) => select({ provider })}
        />
        <EditText
          c={c}
          label="Model"
          value={selection.model}
          disabled={disabled}
          onSave={(model) => select({ model })}
        />
        <EditChoice
          c={c}
          label="Effort"
          value={selection.effort ?? "default"}
          choices={effortChoices}
          disabled={disabled}
          onSave={(effort) =>
            select({ effort: effort === "default" ? null : effort })
          }
        />
        <EditChoice
          c={c}
          label="Capability"
          value={selection.capability}
          choices={capabilities.options}
          disabled={disabled}
          onSave={(capability) => select({ capability })}
        />
        <EditText
          c={c}
          label="Subscription"
          value={profile.group ?? ""}
          disabled={disabled}
          onSave={(group) =>
            update((value) => ({ ...value, group: group || undefined }))
          }
        />
        <FieldCaption c={c} text="Weight" />
        <StopSlider
          c={c}
          a11yLabel="Weight"
          stops={weights.options}
          value={selection.weight}
          disabled={disabled}
          stopLabel={humanLabel}
          labelFor={humanLabel}
          onChange={(weight) => select({ weight })}
        />
        {!disabled &&
          (confirm ? (
            <InlineConfirm
              c={c}
              question="Remove profile?"
              label="profile"
              confirmLabel="Remove"
              onConfirm={remove}
              onCancel={() => setConfirm(false)}
            />
          ) : (
            <Button
              c={c}
              small
              text="Remove profile"
              onPress={() => setConfirm(true)}
            />
          ))}
      </View>
    </SettingsDisclosure>
  );
}

function uniqueProfileId(name: string, existing: Record<string, boolean>) {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 120) || "profile";
  let id = stem;
  let next = 2;
  while (Object.hasOwn(existing, id)) id = stem + "-" + next++;
  return id;
}
