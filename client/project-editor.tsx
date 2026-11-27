import { projectNameProblem } from "../shared/project-scope";
import { errorText } from "./error-text";
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "./shell";
import {
  Button,
  Field,
  FieldCaption,
  muted,
  row,
  type Colors,
} from "./controls";
import { roles, space, type } from "./design";
import {
  identityOf,
  withoutHostPaths,
  type ProjectRepository,
} from "./project-helpers";
import {
  type Project,
  type ProjectSettings,
  type ProjectSettingsRow,
  type ProjectUpsertInput,
} from "../shared/contracts";
import {
  AddRepository,
  MoveRepositoryConfirm,
  Pair,
  RepositoryBlock,
  SaveWord,
  useProjectSaves,
  type ProjectEditActions,
} from "./project-editor/index";
export type { ProjectEditActions } from "./project-editor/index";

/*
 * Settings → Projects → an opened project (lane `nucleus-ui`, "Projects in
 * Settings", build task 3, as amended by Tom's rulings of 2026-11-08): name,
 * the claimed planner, and the repositories with their settings. Every field
 * autosaves through one ordered queue per project; writes stay on
 * `project.upsert`, `project.set-planner`, `repository.set`,
 * `project.remove-repository` (nucleus#967) and `project.merge` (nucleus#969:
 * Add repository taking a repository out of another project).
 */

const NONE = "__none__";
export function ProjectEditor({
  c,
  compact = false,
  projectKey,
  data,
  error,
  refetch,
  actions,
  onBack,
  onOpenProject,
}: {
  c: Colors;
  compact?: boolean;
  projectKey: string;
  data: ProjectSettings | undefined;
  error: unknown;
  refetch: () => unknown;
  actions: ProjectEditActions;
  onBack: () => void;
  /** Opens another project: where Move into lands. */ onOpenProject?: (
    key: string,
  ) => void;
}) {
  const r = roles(c);
  const saved = data?.projects.find(
    (candidate) => candidate.project.key === projectKey,
  );
  // Live planner and agent state comes from the focused read; the saved row
  // keeps the project, its version and every count, so a live read never changes what is saved.
  const focused =
    actions.focus?.row?.project.key === projectKey
      ? actions.focus.row
      : undefined;
  const entry =
    saved && focused
      ? {
          ...saved,
          plannerLive: focused.plannerLive,
          agents: focused.agents,
        }
      : saved;
  const back = (
    <Button
      small
      c={c}
      icon="ChevronLeft"
      text="Projects"
      label="Back to Projects"
      onPress={onBack}
    />
  );
  if (!entry)
    return (
      <View style={{ gap: space.sm }}>
        <View style={{ ...row, flexWrap: "nowrap" }}>{back}</View>
        {data ? (
          <Text style={muted(c)}>This project no longer exists.</Text>
        ) : error ? (
          <LoadFailure
            c={c}
            name="the project"
            error={error}
            refetch={refetch}
          />
        ) : (
          <Text style={muted(c)}>Loading…</Text>
        )}
      </View>
    );
  return (
    <OpenedProject
      key={projectKey}
      c={c}
      compact={compact}
      entry={entry}
      data={data!}
      error={error}
      refetch={refetch}
      actions={actions}
      back={back}
      onBack={onBack}
      onOpenProject={onOpenProject}
      r={r}
    />
  );
}

function LoadFailure({
  c,
  name,
  error,
  refetch,
}: {
  c: Colors;
  name: string;
  error: unknown;
  refetch: () => unknown;
}) {
  return (
    <View style={{ gap: space.xs, alignItems: "flex-start" }}>
      <Text
        accessibilityRole="alert"
        style={{
          color: roles(c).danger,
          fontSize: type.body.fontSize,
          lineHeight: type.body.lineHeight,
        }}
      >
        Couldn't load {name}
      </Text>
      <Text style={{ ...muted(c), fontSize: type.metadata.fontSize }}>
        {withoutHostPaths(errorText(error))}
      </Text>
      <Button
        small
        c={c}
        text="Retry"
        label={`Retry ${name}`}
        onPress={() => void refetch()}
      />
    </View>
  );
}

function OpenedProject({
  c,
  compact,
  entry,
  data,
  error,
  refetch,
  actions,
  back,
  onBack,
  onOpenProject,
  r,
}: {
  c: Colors;
  compact: boolean;
  entry: ProjectSettingsRow;
  data: ProjectSettings;
  error: unknown;
  refetch: () => unknown;
  actions: ProjectEditActions;
  back: React.ReactNode;
  onBack: () => void;
  onOpenProject?: (key: string) => void;
  r: ReturnType<typeof roles>;
}) {
  const project = entry.project;
  const saves = useProjectSaves(actions.refresh);
  // Fields stay, never blank, but take no edits while the project could not be re-read.
  const disabled = Boolean(error);
  const [name, setName] = useState(project.name);
  const [members, setMembers] = useState<ProjectRepository[]>(
    project.repositories,
  );
  const [planner, setPlanner] = useState<string | null>(
    project.planner?.agentId ?? null,
  );
  const [adding, setAdding] = useState<{
    repo: ProjectRepository;
    source: Project;
  } | null>(null);
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  // Writes read the newest draft when they run, so a rename and a repository change
  // queued together never undo each other; versions follow every reply.
  const draft = useRef({ name, members });
  draft.current = { name, members };
  const version = useRef(project.version);
  version.current = Math.max(version.current, project.version);
  const took = (result: Project) => {
    version.current = Math.max(version.current, result.version);
    return result;
  };
  // The server's values come back only when nothing is waiting, so a re-read after one save never replaces a newer draft.
  const serverMembers = JSON.stringify(project.repositories);
  useEffect(() => {
    if (!saves.quiet()) return;
    setName(project.name);
    setMembers(project.repositories);
    setPlanner(project.planner?.agentId ?? null);
  }, [
    saves.landed,
    project.name,
    serverMembers,
    project.planner?.agentId,
  ]);

  // A repository change while the name is held back (empty) keeps the stored name.
  const storedName = useRef(project.name);
  storedName.current = project.name;
  const projectInput = (): ProjectUpsertInput => {
    const { name: nextName, members: list } = draft.current;
    const trimmed = nextName.trim();
    return {
      key: project.key,
      name: projectNameProblem(trimmed) ? storedName.current : trimmed,
      repositories: list,
      ...(list.length > 1 ? { primary: list[0] } : {}),
    };
  };
  const saveProject = (delay = 0) =>
    saves.queue(
      "project",
      { run: () => actions.saveProject(projectInput()).then(took) },
      delay,
    );
  const rename = (text: string) => {
    setName(text);
    // Held under "name", not "project": a repository change queues "project" and must not clear the name's reason.
    const problem = projectNameProblem(text);
    if (problem) {
      saves.hold("name", problem);
      return;
    }
    saves.release("name");
    saveProject(600);
  };
  const changeMembers = (list: ProjectRepository[]) => {
    setMembers(list);
    draft.current = { ...draft.current, members: list };
    saveProject();
  };
  // Add repository from another project: the repository (or its whole project) moves here in one server step.
  const moveHere = (source: Project, repository?: string) => {
    setAdding(null);
    saves.queue(`merge:${source.key}`, {
      run: () =>
        actions
          .merge({
            source: source.key,
            target: project.key,
            versions: { source: source.version, target: version.current },
            ...(repository ? { repository } : {}),
            reason: `Added to ${storedName.current} in Settings`,
          })
          .then((result) => {
            took(result.project);
            const moved = result.project.repositories.filter(
              (repo) =>
                !draft.current.members.some(
                  (member) => identityOf(member) === identityOf(repo),
                ),
            );
            const next = [...draft.current.members, ...moved];
            draft.current = { ...draft.current, members: next };
            setMembers(next);
          }),
    });
  };
  const choosePlanner = (value: string) => {
    const agentId = value === NONE ? null : value;
    setPlanner(agentId);
    saves.queue("planner", {
      run: () => actions.setPlanner({ key: project.key, agentId }).then(took),
    });
  };
  const single = members.length === 1;
  const settingsFor = (repo: ProjectRepository) =>
    entry.repositories.find(
      (item) => identityOf(item.repository) === identityOf(repo),
    )?.settings ?? null;

  return (
    <View
      accessibilityLabel={`${project.name} project`}
      style={{ gap: space.sm }}
    >
      <View style={{ ...row, flexWrap: "nowrap" }}>
        {back}
        <View style={{ flex: 1 }} />
      </View>
      <View style={{ ...row, flexWrap: "nowrap" }}>
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={{
            color: r.foreground,
            fontWeight: "600",
            fontSize: type.page.fontSize,
            lineHeight: type.page.lineHeight,
            flex: 1,
            minWidth: 0,
          }}
        >
          {project.name}
        </Text>
        <SaveWord c={c} status={saves.status} name={project.name} />
      </View>
      {disabled && (
        <LoadFailure
          c={c}
          name={project.name}
          error={error}
          refetch={refetch}
        />
      )}
      <Pair>
        <Field
          c={c}
          label="Name"
          a11yLabel="Project name"
          value={name}
          disabled={disabled}
          onChange={rename}
          onBlur={saves.flush}
        />
        <View style={{ gap: space.xs }}>
            <View style={{ gap: space.xs }}>
              <FieldCaption c={c} text="Planner" help="New messages go to the thread that ran nucleus planner.claim. Clearing it restores fallback delivery." />
              <Text selectable style={muted(c)}>{planner ?? "Unclaimed"}</Text>
              {planner && <Button small c={c} text="Clear" label="Clear claimed planner" disabled={disabled} onPress={() => choosePlanner(NONE)} />}
            </View>
        </View>
      </Pair>
      {Boolean(actions.focus?.error) && (
        <Text
          style={{
            color: r.warning,
            fontSize: type.metadata.fontSize,
            lineHeight: type.metadata.lineHeight,
          }}
        >
          Live status is unavailable:{" "}
          {withoutHostPaths(errorText(actions.focus?.error))}. Saved settings
          still apply.
        </Text>
      )}
      <View
        style={{
          gap: space.xs,
          paddingTop: space.sm,
        }}
      >
        <View style={{ ...row, flexWrap: "nowrap" }}>
          <Text
            accessibilityRole="header"
            style={{
              color: r.foreground,
              fontWeight: "600",
              fontSize: type.section.fontSize,
              lineHeight: type.section.lineHeight,
              flex: 1,
            }}
          >
            Repositories
          </Text>
          <AddRepository
            c={c}
            rows={data.projects}
            projectKey={project.key}
            members={members}
            disabled={disabled}
            onAdd={(repo) => changeMembers([...members, repo])}
            onMove={(repo, source) => setAdding({ repo, source })}
          />
        </View>
        {adding && (
          <MoveRepositoryConfirm
            key={`${adding.source.key}:${identityOf(adding.repo)}`}
            c={c}
            repo={adding.repo}
            source={adding.source}
            target={project.name}
            onMoveRepository={() =>
              moveHere(adding.source, identityOf(adding.repo))
            }
            onCancel={() => setAdding(null)}
          />
        )}
        {members.map((repo, index) => {
          const id = identityOf(repo);
          const open = single || openRepo === id;
          return (
            <RepositoryBlock
              key={id}
              c={c}
              repo={repo}
              primary={index === 0}
              single={single}
              open={open}
              disabled={disabled}
              settings={settingsFor(repo)}
              saves={saves}
              setRepository={actions.setRepository}
              onToggle={() => setOpenRepo(open ? null : id)}
            />
          );
        })}
      </View>
    </View>
  );
}
