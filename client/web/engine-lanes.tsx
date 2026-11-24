import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { z } from "zod";
import { Section, muted, type Colors } from "../controls";
import { space } from "../design";
import {
  putSettings,
  settingsKey,
  useSettingsWriter,
  type SettingsEdit,
} from "./engine-settings-api";
import {
  EditChoice,
  EditText,
  SettingsDisclosure,
  SettingValue,
  humanLabel,
} from "./engine-settings-fields";
import { createRustBoardTransport } from "./rust-board";

const api = createRustBoardTransport();
const horizons = z.enum(["now", "next", "later"]);
const version = z.number().int().nonnegative();
const planEntry = z.object({
  key: z.string(),
  horizon: horizons,
  doneWhen: z.string(),
  statusNote: z.string(),
});
const laneContent = z.object({
  version,
  title: z.string(),
  aim: z.string(),
  document: z.string(),
});
const lane = laneContent.extend({
  key: z.string(),
  status: z.enum(["open", "done", "dropped"]),
  note: z.string().optional(),
});
const plan = z.object({ version, lanes: z.array(planEntry) });
const planView = plan.extend({ documents: z.array(lane) });
type Lane = z.infer<typeof lane>;
type LaneFields = z.infer<typeof laneContent>;
type PlanEntry = z.infer<typeof planEntry>;
type PlanView = z.infer<typeof planView>;

export function EngineLanes({
  c,
  project,
  disabled,
}: {
  c: Colors;
  project: string;
  disabled: boolean;
}) {
  return (
    <SettingsDisclosure c={c} label="Lanes">
      <LaneSettings c={c} project={project} disabled={disabled} />
    </SettingsDisclosure>
  );
}

function LaneSettings({
  c,
  project,
  disabled,
}: {
  c: Colors;
  project: string;
  disabled: boolean;
}) {
  const path = "/planning/" + encodeURIComponent(project);
  const key = [...settingsKey, "plan", project];
  const client = useQueryClient();
  const { status, write } = useSettingsWriter<PlanView>(key);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.read(planView, path + "/plan", { signal }),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const editPlan = (id: string, edit: SettingsEdit<PlanEntry>) =>
    write(async (current) => {
      if (!current.lanes.some((entry) => entry.key === id))
        throw new Error("The lane is no longer in the plan.");
      const saved = await putSettings(plan, path + "/plan", {
        version: current.version,
        lanes: current.lanes.map((entry) =>
          entry.key === id ? edit(entry) : entry,
        ),
      });
      client.setQueryData<PlanView>(key, (latest) =>
        latest && latest.version <= saved.version
          ? { ...latest, ...saved }
          : latest,
      );
    });
  const editLane = (id: string, edit: SettingsEdit<LaneFields>) =>
    write(async (current) => {
      const prior = current.documents.find((document) => document.key === id);
      if (!prior) throw new Error("The lane no longer exists.");
      const saved = await putSettings(
        lane,
        path + "/lanes/" + encodeURIComponent(id),
        edit(laneContent.parse(prior)),
      );
      client.setQueryData<PlanView>(
        key,
        (latest) =>
          latest && {
            ...latest,
            documents: latest.documents.map((document) =>
              document.key === id && document.version <= saved.version
                ? saved
                : document,
            ),
          },
      );
    });
  const view = query.data;
  if (!view)
    return (
      <Text style={muted(c)}>{query.error?.message ?? "Loading lanes…"}</Text>
    );
  const documents = new Map(
    view.documents.map((document) => [document.key, document]),
  );
  const entries = new Map(view.lanes.map((entry) => [entry.key, entry]));
  const ids = new Set([...entries.keys(), ...documents.keys()]);
  return (
    <Section c={c} title="Lanes" status={status} last>
      {[...ids].map((id) => (
        <LanePanel
          key={id}
          c={c}
          id={id}
          entry={entries.get(id)}
          document={documents.get(id)}
          editPlan={(edit) => editPlan(id, edit)}
          editLane={(edit) => editLane(id, edit)}
          disabled={disabled}
        />
      ))}
      {!ids.size && <Text style={muted(c)}>No lanes yet.</Text>}
    </Section>
  );
}

function LanePanel({
  c,
  id,
  entry,
  document,
  editPlan,
  editLane,
  disabled,
}: {
  c: Colors;
  id: string;
  entry?: PlanEntry;
  document?: Lane;
  editPlan: (edit: SettingsEdit<PlanEntry>) => void;
  editLane: (edit: SettingsEdit<LaneFields>) => void;
  disabled: boolean;
}) {
  return (
    <SettingsDisclosure c={c} label={document?.title || id}>
      <View style={{ gap: space.sm }}>
        {entry && (
          <>
            <EditChoice
              c={c}
              label="Horizon"
              value={entry.horizon}
              choices={horizons.options}
              disabled={disabled}
              onSave={(horizon) => editPlan((entry) => ({ ...entry, horizon }))}
            />
            <EditText
              c={c}
              label="Done when"
              value={entry.doneWhen}
              disabled={disabled}
              onSave={(doneWhen) =>
                editPlan((entry) => ({ ...entry, doneWhen }))
              }
            />
            <EditText
              c={c}
              label="Status note"
              value={entry.statusNote}
              disabled={disabled}
              onSave={(statusNote) =>
                editPlan((entry) => ({ ...entry, statusNote }))
              }
            />
          </>
        )}
        {document && (
          <>
            <SettingValue
              c={c}
              label="Status"
              value={humanLabel(document.status)}
            />
            <EditText
              c={c}
              label="Title"
              value={document.title}
              disabled={disabled}
              onSave={(title) =>
                editLane((document) => ({ ...document, title }))
              }
            />
            <EditText
              c={c}
              label="Aim"
              value={document.aim}
              disabled={disabled}
              onSave={(aim) => editLane((document) => ({ ...document, aim }))}
            />
            <EditText
              c={c}
              label="Document"
              value={document.document}
              multiline
              disabled={disabled}
              onSave={(document) =>
                editLane((value) => ({ ...value, document }))
              }
            />
          </>
        )}
      </View>
    </SettingsDisclosure>
  );
}
