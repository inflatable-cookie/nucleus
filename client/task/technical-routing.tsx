import { Text, View } from "react-native";
import { useRpc } from "../shell";
import { Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { type Task, type UiQueueState } from "../../shared/contracts";
import { workerThinking } from "../../shared/pool";
import { choiceTag, NORMAL_USAGE, SelectedProfilePolicy } from "./next-section";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import type { BoardAct } from "./parts";
import type { TaskDetailRead } from "./task-dialog";
import { space } from "../design";

export function TechnicalRouting({ task, state, drafts, busy, act, c }: {
  task: TaskDetailRead["task"];
  state: UiQueueState | undefined;
  drafts: TaskDrafts;
  busy: boolean;
  act: BoardAct;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl);
  const [routingOpen, setRoutingOpen] = useTaskDraft(drafts, "routingOpen", false);
  const [routingReason, setRoutingReason] = useTaskDraft(drafts, "routingReason", "");
  const [routingScope, setRoutingScope] = useTaskDraft<Task["scope"]>(drafts, "routingScope", "general");
  const [routingComplexity, setRoutingComplexity] = useTaskDraft<Task["complexity"]>(drafts, "routingComplexity", null);
  const [routingPreferred, setRoutingPreferred] = useTaskDraft(drafts, "routingPreferred", "");
  const [routingRequired, setRoutingRequired] = useTaskDraft(drafts, "routingRequired", false);
  const [routingThinking, setRoutingThinking] = useTaskDraft(drafts, "routingThinking", "");
  const [routingRequests, setRoutingRequests] = useTaskDraft<Record<"worker"|"reviewer"|"coordinator",{profileId:string;reason:string;required:boolean}>>(drafts, "routingRequests", {worker:{profileId:"",reason:"",required:false},reviewer:{profileId:"",reason:"",required:false},coordinator:{profileId:"",reason:"",required:false}});
  const canChangeRouting=Boolean(!task.removedAt&&["queued","needs_attention"].includes(task.phase)&&!task.agentIntent&&!task.agentId);
  const routingProfiles=(state?.pool??[]).filter(entry=>entry.enabled).map(entry=>({entry,profile:state?.profiles.find(profile=>profile.id===entry.profileId)})).filter(item=>item.profile?.available);
  return <>
    {canChangeRouting && (
      <DetailSection title="Routing" c={c}>
        <Text style={muted(c)}>
          Current: {task.scope} ·{" "}
          {task.complexity
            ? `complexity ${task.complexity} · `
            : "complexity unset · "}
          {task.preferredProfileId || "automatic"}
          {task.requirePreferred ? " required" : ""} · thinking{" "}
          {workerThinking(task) || "default"}
        </Text>
        <Button
          small
          c={c}
          text="Change routing"
          onPress={() => {
            setRoutingScope(task.scope);
            setRoutingComplexity(task.complexity ?? null);
            setRoutingPreferred(task.preferredProfileId);
            setRoutingRequired(task.requirePreferred);
            setRoutingThinking(workerThinking(task));
            setRoutingRequests({
              worker: (({
                thinkingOptionId: _level,
                ...request
              }) => request)(
                task.profileRequests?.worker ?? {
                  profileId: "",
                  reason: "",
                  required: false,
                },
              ),
              reviewer: task.profileRequests?.reviewer ?? {
                profileId: "",
                reason: "",
                required: false,
              },
              coordinator: task.profileRequests
                ?.coordinator ?? {
                profileId: "",
                reason: "",
                required: false,
              },
            });
            setRoutingReason("");
            setRoutingOpen(!routingOpen);
          }}
        />
        {routingOpen && (
          <View style={{ gap: space.xs }}>
            <View style={row}>
              <Text style={muted(c)}>Scope</Text>
              {(
                ["general", "mechanical", "complex"] as const
              ).map((scope) => (
                <Button
                  key={scope}
                  small
                  c={c}
                  text={scope}
                  selected={routingScope === scope}
                  onPress={() => setRoutingScope(scope)}
                />
              ))}
            </View>
            <View style={row}>
              <Text style={muted(c)}>Complexity</Text>
              <Button
                key="unset"
                small
                c={c}
                text="unset"
                selected={routingComplexity === null}
                onPress={() => setRoutingComplexity(null)}
              />
              {(
                [
                  "very_low",
                  "low",
                  "medium",
                  "high",
                  "very_high",
                ] as const
              ).map((complexity) => (
                <Button
                  key={complexity}
                  small
                  c={c}
                  text={complexity.replaceAll("_", " ")}
                  selected={routingComplexity === complexity}
                  onPress={() =>
                    setRoutingComplexity(complexity)
                  }
                />
              ))}
            </View>
            <Text style={muted(c)}>
              Complexity only steers future selection: profiles
              whose rated capability sits close to it are
              preferred, never guaranteed, and running or review
              assignments are untouched.
            </Text>
            <Text style={muted(c)}>
              Worker profiles for {routingScope}
              {routingProfiles.length
                ? ""
                : " · none currently eligible"}
            </Text>
            <View style={row}>
              <Button
                small
                c={c}
                text="Automatic"
                selected={!routingPreferred}
                onPress={() => setRoutingPreferred("")}
              />
              {routingProfiles.map(({ entry, profile }) => (
                <Button
                  key={entry.profileId}
                  small
                  wrap
                  c={c}
                  text={`${profile!.name}${choiceTag(entry, state?.usage ?? NORMAL_USAGE, state?.availability ?? [])}`}
                  selected={
                    routingPreferred === entry.profileId
                  }
                  onPress={() =>
                    setRoutingPreferred(entry.profileId)
                  }
                />
              ))}
            </View>
            <SelectedProfilePolicy
              entry={
                routingProfiles.find(
                  (item) =>
                    item.entry.profileId === routingPreferred,
                )?.entry
              }
              usage={state?.usage ?? NORMAL_USAGE}
              availability={state?.availability ?? []}
              explicit={(required) =>
                required
                  ? "A preference alone does not select this profile; add a worker request with a reason. "
                  : ""
              }
              c={c}
            />
            <Button
              small
              c={c}
              text={
                routingRequired
                  ? "Preferred required"
                  : "Preferred optional"
              }
              selected={routingRequired}
              onPress={() =>
                setRoutingRequired(!routingRequired)
              }
            />
            <Field
              c={c}
              label="Thinking option ID (blank uses profile default)"
              value={routingThinking}
              onChange={setRoutingThinking}
            />
            {(
              ["worker", "reviewer", "coordinator"] as const
            ).map((role) => (
              <View key={role} style={{ gap: space.xxs }}>
                <Field
                  c={c}
                  label={`${role} request profile ID (blank clears)`}
                  value={routingRequests[role].profileId}
                  onChange={(profileId) =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        profileId,
                      },
                    })
                  }
                />
                <Field
                  c={c}
                  label={`${role} request reason`}
                  value={routingRequests[role].reason}
                  onChange={(reason) =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        reason,
                      },
                    })
                  }
                />
                <Button
                  small
                  c={c}
                  text={`${role} request ${routingRequests[role].required ? "required" : "optional"}`}
                  selected={routingRequests[role].required}
                  onPress={() =>
                    setRoutingRequests({
                      ...routingRequests,
                      [role]: {
                        ...routingRequests[role],
                        required:
                          !routingRequests[role].required,
                      },
                    })
                  }
                />
              </View>
            ))}
            <Field
              c={c}
              label="Reason (required)"
              value={routingReason}
              onChange={setRoutingReason}
            />
            <Button
              small
              c={c}
              text="Save routing"
              disabled={busy || !routingReason.trim()}
              onPress={() =>
                void act(async () => {
                  await setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "set_routing",
                    reason: routingReason.trim(),
                    scope: routingScope,
                    complexity: routingComplexity,
                    preferredProfileId: routingPreferred,
                    requirePreferred: routingRequired,
                    thinkingOptionId: routingThinking,
                    profileRequests: Object.fromEntries(
                      (
                        [
                          "worker",
                          "reviewer",
                          "coordinator",
                        ] as const
                      ).map((role) => [
                        role,
                        routingRequests[role].profileId
                          ? {
                              ...routingRequests[role],
                              reason:
                                routingRequests[
                                  role
                                ].reason.trim(),
                            }
                          : null,
                      ]),
                    ),
                  });
                  setRoutingOpen(false);
                })
              }
            />
          </View>
        )}
      </DetailSection>
    )}
  </>;
}
