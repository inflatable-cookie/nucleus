import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { Button, DropdownSelect, Field, LabelHelp, muted, row, type Colors } from "../controls";
import { space } from "../design";
import { errorText } from "../error-text";
import { createRustBoardTransport, isRustHttpError } from "./rust-board";

const account = z.strictObject({
  host: z.string().min(1),
  userId: z.string().regex(/^\d+$/),
  login: z.string().min(1),
});

const presence = z.enum(["present", "missing", "unavailable"]);
const settingsView = z.strictObject({
  revision: z.string(),
  accounts: z.array(account.extend({ presence })),
  reviewerAccountId: z.string().nullable(),
  workerAccountId: z.string().nullable(),
  canSignIn: z.boolean(),
  canImportReviewer: z.boolean(),
});

const flowId = z.string().min(1);
const flowView = z.discriminatedUnion("status", [
  z.strictObject({ id: flowId, status: z.literal("starting") }),
  z.strictObject({
    id: flowId,
    status: z.literal("waiting"),
    verificationUri: z.literal("https://github.com/login/device"),
    userCode: z.string().min(1),
    expiresAtMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ id: flowId, status: z.literal("confirm"), account }),
  z.strictObject({ id: flowId, status: z.literal("failed"), message: z.string() }),
]);

type Flow = z.infer<typeof flowView>;
type AccountForm =
  | { kind: "import" }
  | { kind: "sign-out"; id: string; label: string; revision: string };
const board = createRustBoardTransport();
const settingsPath = "/settings/github-accounts";
const flowPath = (id: string) => `${settingsPath}/flows/${encodeURIComponent(id)}`;
const accountId = (identity: z.infer<typeof account>) => `${identity.host}:${identity.userId}`;
const accountLabel = (identity: z.infer<typeof account>) => `@${identity.login}`;
const settingsKey = ["nucleus", "github-accounts", "settings"];
const currentFlowKey = ["nucleus", "github-accounts", "active-flow"];
const flowKey = (id: string | null) => ["nucleus", "github-accounts", "flow", id];
const messageFor = {
  present: "Saved sign-in",
  missing: "Sign-in required",
  unavailable: "Account storage unavailable",
} satisfies Record<z.infer<typeof presence>, string>;

function json(method: "POST" | "PUT", body: object) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function inProgress(flow: Flow | undefined) {
  return flow?.status === "starting" || flow?.status === "waiting";
}

export function GitHubReviewerSettings({ c, inset }: { c: Colors; inset: number }) {
  const queryClient = useQueryClient();
  const [activeFlow, setActiveFlow] = useState(() =>
    queryClient.getQueryData<string | null>(currentFlowKey) ?? null,
  );
  const [form, setForm] = useState<AccountForm | null>(null);
  const [organization, setOrganization] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => board.read(settingsView, settingsPath, { signal }),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const progress = useQuery({
    queryKey: flowKey(activeFlow),
    enabled: activeFlow !== null,
    queryFn: ({ signal }) => {
      if (activeFlow === null) throw Error("No GitHub sign-in is open.");
      return board.read(flowView, flowPath(activeFlow), { signal });
    },
    refetchInterval: ({ state }) =>
      inProgress(state.data) && !isRustHttpError(state.error, 404) ? 1000 : false,
    retry: false,
  });
  const state = settings.isError ? undefined : settings.data;
  const flow = progress.data;
  const selected = state?.accounts.find((identity) => accountId(identity) === state.reviewerAccountId);
  const reconnect = selected && selected.presence !== "present";
  const unavailableFlow = isRustHttpError(progress.error, 404);
  const locked = busy || activeFlow !== null || form !== null;
  const canSignOut = selected !== undefined && accountId(selected) !== state?.workerAccountId;

  function showFlow(next: Flow) {
    queryClient.setQueryData(flowKey(next.id), next);
    queryClient.setQueryData(currentFlowKey, next.id);
    setActiveFlow(next.id);
  }

  function clearFlow() {
    queryClient.setQueryData(currentFlowKey, null);
    if (activeFlow !== null) queryClient.removeQueries({ queryKey: flowKey(activeFlow), exact: true });
    setActiveFlow(null);
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
      if (isRustHttpError(failure, 409)) void settings.refetch();
    } finally {
      setBusy(false);
    }
  }

  function startReviewSignIn() {
    return perform(async () => {
      showFlow(await board.read(flowView, settingsPath + "/sign-in", json("POST", {})));
    });
  }

  function lookupReviewer() {
    return perform(async () => {
      const next = await board.read(
        flowView,
        settingsPath + "/import-reviewer",
        json("POST", { organization: organization.trim() }),
      );
      setForm(null);
      setOrganization("");
      showFlow(next);
    });
  }

  const dismissFlow = () => {
    setError("");
    clearFlow();
  };

  function cancelFlow(id: string) {
    return perform(async () => {
      await queryClient.cancelQueries({ queryKey: flowKey(id), exact: true });
      try {
        await board.read(z.null(), flowPath(id), { method: "DELETE" });
      } catch (failure) {
        if (!isRustHttpError(failure, 404)) throw failure;
      }
      clearFlow();
    });
  }

  async function writeSettings(path: string, method: "POST" | "PUT", body: object) {
    const next = await board.read(settingsView, path, json(method, body));
    await queryClient.cancelQueries({ queryKey: settingsKey, exact: true });
    queryClient.setQueryData(settingsKey, next);
  }

  function chooseReviewer(revision: string, id: string) {
    return perform(() => writeSettings(settingsPath + "/reviewer", "PUT", { revision, accountId: id || null }));
  }

  function confirmReviewer(revision: string, id: string) {
    return perform(async () => {
      await writeSettings(flowPath(id) + "/confirm", "POST", { revision });
      clearFlow();
    });
  }

  function disconnectReviewer(revision: string, id: string) {
    return perform(async () => {
      await writeSettings(
        `${settingsPath}/accounts/${encodeURIComponent(id)}/sign-out`,
        "POST",
        { revision },
      );
      setForm(null);
    });
  }

  return (
    <ScrollView
      accessibilityLabel="GitHub reviewer settings"
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{ gap: space.sm, paddingBottom: inset }}
    >
      <LabelHelp
        c={c}
        label="Reviewer"
        text="Use a GitHub account for formal reviews, or choose Installed gh to use the GitHub CLI identity. The engine keeps sign-in credentials in the system keychain. Sign out removes the saved sign-in from this profile."
      />
      {settings.isPending && <Text accessibilityRole="text" style={muted(c)}>Loading GitHub accounts…</Text>}
      {settings.isError && (
        <View style={row}>
          <Text accessibilityRole="alert" style={muted(c)}>{errorText(settings.error)}</Text>
          <Button c={c} text="Retry" label="Retry GitHub accounts" onPress={() => void settings.refetch()} />
        </View>
      )}
      {state && (
        <>
          <DropdownSelect
            c={c}
            label="Reviewer"
            hideLabel
            value={state.reviewerAccountId ?? ""}
            options={[
              { value: "", label: "Installed gh" },
              ...state.accounts.map((identity) => ({
                value: accountId(identity),
                label: accountLabel(identity),
                detail: messageFor[identity.presence],
              })),
            ]}
            disabled={locked}
            onChange={(id) => void chooseReviewer(state.revision, id)}
          />
          {!state.canSignIn && <Text style={muted(c)}>GitHub sign-in is unavailable.</Text>}
          {form === null && activeFlow === null && (
            <View style={row}>
              {state.canSignIn && (
                <Button c={c} text={reconnect ? "Reconnect" : "Sign in"} disabled={busy} onPress={() => void startReviewSignIn()} />
              )}
              {state.canImportReviewer && (
                <Button c={c} text="Import existing reviewer" disabled={busy} onPress={() => { setError(""); setForm({ kind: "import" }); }} />
              )}
              {canSignOut && (
                <Button c={c} text="Sign out" disabled={busy} onPress={() => {
                  setError("");
                  setForm({
                    kind: "sign-out",
                    id: accountId(selected),
                    label: accountLabel(selected),
                    revision: state.revision,
                  });
                }} />
              )}
            </View>
          )}
          {form?.kind === "import" && (
            <>
              <Field c={c} label="Organization" value={organization} onChange={setOrganization} disabled={busy} />
              <View style={row}>
                <Button c={c} text="Look up reviewer" disabled={busy || !organization.trim()} onPress={() => void lookupReviewer()} />
                <Button c={c} text="Cancel" disabled={busy} onPress={() => { setForm(null); setError(""); }} />
              </View>
            </>
          )}
          {form?.kind === "sign-out" && (
            <View style={row}>
              <Text style={muted(c)}>Sign out of {form.label} and use Installed gh for reviews?</Text>
              <Button c={c} text="Sign out" disabled={busy} onPress={() => void disconnectReviewer(form.revision, form.id)} />
              <Button c={c} text="Cancel" disabled={busy} onPress={() => { setForm(null); setError(""); }} />
            </View>
          )}
        </>
      )}
      {activeFlow !== null && (
        <View style={{ gap: space.xs }}>
          {unavailableFlow ? (
            <Text accessibilityRole="alert" style={muted(c)}>This sign-in is no longer available.</Text>
          ) : flow?.status === "waiting" ? (
            flow.expiresAtMs <= Date.now() ? (
              <Text accessibilityRole="alert" style={muted(c)}>This code has expired.</Text>
            ) : (
              <>
                <a href={flow.verificationUri} target="_blank" rel="noreferrer" style={{ color: c.accent }}>
                  Open GitHub
                </a>
                <Text selectable accessibilityLabel="GitHub device code" style={{ color: c.foreground }}>
                  {flow.userCode}
                </Text>
                <Text style={muted(c)}>Expires at {new Date(flow.expiresAtMs).toLocaleTimeString()}.</Text>
              </>
            )
          ) : flow?.status === "confirm" ? (
            <Text style={muted(c)}>Use {accountLabel(flow.account)} for reviews?</Text>
          ) : flow?.status === "failed" ? (
            <Text accessibilityRole="alert" style={muted(c)}>{flow.message}</Text>
          ) : (
            <Text style={muted(c)}>Starting GitHub sign-in…</Text>
          )}
          {progress.isError && !unavailableFlow && (
            <View style={row}>
              <Text accessibilityRole="alert" style={muted(c)}>Couldn’t read sign-in progress.</Text>
              <Button c={c} text="Retry" label="Retry GitHub sign-in" disabled={busy} onPress={() => void progress.refetch()} />
            </View>
          )}
          <View style={row}>
            {flow?.status === "confirm" && state && !progress.isError && (
              <Button c={c} text="Use account" disabled={busy} onPress={() => void confirmReviewer(state.revision, flow.id)} />
            )}
            {flow?.status === "failed" || unavailableFlow ? (
              <Button c={c} text="Dismiss" onPress={dismissFlow} />
            ) : (
              <Button c={c} text="Cancel" disabled={busy} onPress={() => void cancelFlow(activeFlow)} />
            )}
          </View>
        </View>
      )}
      {error && <Text accessibilityRole="alert" style={muted(c)}>{error}</Text>}
    </ScrollView>
  );
}
