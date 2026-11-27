import React from "react";
import { Text, View } from "react-native";
import { FieldCaption, type Colors } from "../controls";
import { space, type } from "../design";
import { identityOf, type ProjectRepository } from "../project-helpers";
import type { RepositorySetInput, RepositorySettings } from "../../shared/contracts";
import type { ProjectEditActions, ProjectSaves } from "./types";

/**
 * The operator's per-repository settings on the Rust engine: the base branch is the
 * only one shown. QA (ruling 12), host choice (ruling 5) and merge commands (ruling 13)
 * are retired, so their fields and `repository.set` patches are gone.
 */
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
  const id = identityOf(repo);
  const patch = (
    field: string,
    value: Omit<RepositorySetInput, "repository">,
    delay = 0,
  ) =>
    saves.queue(
      `repo:${id}:${field}`,
      { run: () => setRepository({ repository: id, ...value }) },
      delay,
    );
  return (
    <RustRepositoryFields
      c={c}
      label={label}
      settings={settings}
      disabled={disabled}
      save={patch}
      flush={saves.flush}
    />
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
  save: (field: string, value: Omit<RepositorySetInput, "repository">, delay: number) => unknown;
  flush: () => void;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <View style={{ gap: space.xxs }}>
        <FieldCaption c={c} text="Base branch" />
        <Text
          accessibilityLabel={`Base branch for ${label}`}
          style={{ color: c.foreground, fontSize: type.body.fontSize }}
        >
          {settings?.base ?? "Unresolved"}
        </Text>
      </View>
    </View>
  );
}
