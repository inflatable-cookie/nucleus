import { Text, View } from "react-native";
import { Section, muted, type Colors } from "../controls";
import { space } from "../design";
import { EngineLanes } from "./engine-lanes";
import {
  projectsView,
  useEditor,
  type Project,
  type Projects,
  type Repository,
  type SettingsEdit,
} from "./engine-settings-api";
import {
  EditNumber,
  EditText,
  EditToggle,
  SettingsDisclosure,
  SettingValue,
} from "./engine-settings-fields";

export function EngineProjects({
  c,
  disabled,
}: {
  c: Colors;
  disabled: boolean;
}) {
  const editor = useEditor("projects", projectsView);
  const view = editor.query.data;
  if (!view)
    return (
      <Text style={muted(c)}>
        {editor.query.error?.message ?? "Loading projects…"}
      </Text>
    );
  const projects = view.settings.value.projects;
  const entries = Object.entries(projects).sort(([, left], [, right]) =>
    left.name.localeCompare(right.name),
  );
  const update = (id: string, edit: SettingsEdit<Project>) =>
    editor.save((current) => patchProject(current, id, edit));
  return (
    <Section c={c} title="Projects" status={editor.status}>
      {entries.map(([id, project]) => (
        <SettingsDisclosure
          key={id}
          c={c}
          label={project.archived ? project.name + " (archived)" : project.name}
        >
          <View style={{ gap: space.sm }}>
            <EditText
              c={c}
              label="Name"
              value={project.name}
              disabled={disabled}
              onSave={(name) => update(id, (current) => ({ ...current, name }))}
            />
            <EditNumber
              c={c}
              label="Slots"
              value={project.slots}
              disabled={disabled}
              onSave={(slots) =>
                update(id, (current) => ({ ...current, slots }))
              }
            />
            <SettingValue
              c={c}
              label="Planners"
              value={
                (view.verifiedPlanners?.[id]?.join(", ") ??
                  view.resolvedPlanners[id]) ||
                "Unresolved"
              }
            />
            <EditToggle
              c={c}
              label="Archived"
              checked={project.archived}
              disabled={disabled}
              onSave={(archived) =>
                update(id, (current) => ({ ...current, archived }))
              }
            />
            <EngineLanes c={c} project={id} disabled={disabled} />
            <Section c={c} title="Repositories" last>
              {project.repositories.map((repo) => (
                <RepositorySettings
                  key={repo.origin}
                  c={c}
                  repo={repo}
                  disabled={disabled}
                  save={(edit) =>
                    update(id, (current) => ({
                      ...current,
                      repositories: current.repositories.map((candidate) =>
                        candidate.origin === repo.origin
                          ? edit(candidate)
                          : candidate,
                      ),
                    }))
                  }
                />
              ))}
            </Section>
          </View>
        </SettingsDisclosure>
      ))}
      {!entries.length && <Text style={muted(c)}>No projects registered.</Text>}
    </Section>
  );
}

function patchProject(
  value: Projects,
  id: string,
  edit: SettingsEdit<Project>,
): Projects {
  const project = value.projects[id];
  if (!project) throw new Error("The project no longer exists.");
  return { projects: { ...value.projects, [id]: edit(project) } };
}

function RepositorySettings({
  c,
  repo,
  disabled,
  save,
}: {
  c: Colors;
  repo: Repository;
  disabled: boolean;
  save: (edit: SettingsEdit<Repository>) => Promise<boolean>;
}) {
  return (
    <SettingsDisclosure c={c} label={repo.origin}>
      <View style={{ gap: space.sm }}>
        <SettingValue c={c} label="Path" value={repo.path} />
        <SettingValue c={c} label="Base" value={repo.base} />
        <Section
          c={c}
          title="Merge checks"
          description="Enter one required GitHub check name per line."
          last
        >
          <EditText
            c={c}
            label="Required checks"
            value={repo.requiredChecks.join("\n")}
            disabled={disabled}
            multiline
            onSave={(text) =>
              save((current) => ({
                ...current,
                requiredChecks: text
                  .split("\n")
                  .map((check) => check.trim())
                  .filter(Boolean),
              }))
            }
          />
        </Section>
        <EditNumber
          c={c}
          label="Hung tool limit"
          value={repo.hungToolMinutes}
          unit="min"
          disabled={disabled}
          onSave={(hungToolMinutes) =>
            save((current) => ({ ...current, hungToolMinutes }))
          }
        />
      </View>
    </SettingsDisclosure>
  );
}
