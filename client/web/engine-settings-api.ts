import { useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { z } from "zod";
import { errorText } from "../error-text";
import { createRustBoardTransport } from "./rust-board";

export const providers = z.enum([
  "codex",
  "claude",
  "pi",
  "grok",
  "cursor",
  "opencode",
  "copilot",
  "omp",
  "antigravity",
  "muse",
  "fx",
  "kiro",
]);
export const efforts = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const capabilities = z.enum([
  "mechanical",
  "worker",
  "heavyweight",
  "frontier",
]);
export const weights = z.enum(["fewest", "fewer", "default", "more", "most"]);
export const usage = z.enum(["low", "normal", "high", "extra_high", "maximum"]);

const integer = z.number().int().nonnegative();
const namedProfile = z.object({
  name: z.string(),
  selection: z.object({
    id: z.string(),
    provider: providers,
    model: z.string(),
    effort: efforts.nullable(),
    capability: capabilities,
    weight: weights,
  }),
  group: z.string().optional(),
  enabled: z.boolean().optional(),
  roles: z.array(z.enum(["worker", "reviewer", "coordinator"])).optional(),
  scopes: z.array(z.string()).optional(),
  providerInstanceId: z.string().optional(),
  modeId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
  unrated: z.boolean().optional(),
});
const profiles = z.object({
  profiles: z.array(namedProfile),
  pausedGroups: z.array(z.string()).optional(),
});
const dispatch = z.object({
  usage,
  usageUntilMs: integer.nullable(),
  slots: integer,
  hostConcurrency: integer,
  allowanceMinutes: integer.nullable(),
  providerLimitCooldownSeconds: integer.optional(),
});
const repository = z.object({
  origin: z.string(),
  path: z.string(),
  base: z.string(),
  requiredChecks: z.array(z.string()),
  hungToolMinutes: integer,
  hostProject: z.string().optional(),
  hostProjectTitle: z.string().optional(),
});
const project = z.object({
  name: z.string(),
  slots: integer,
  archived: z.boolean(),
  repositories: z.array(repository),
});
const projects = z.object({ projects: z.record(z.string(), project) });
const host = z.object({ endpoint: z.string(), credentialRef: z.string() });
const hosts = z.object({ t3: host.nullable() });
const storage = z.object({
  enabled: z.boolean(),
  workVolume: z.object({ volumeId: z.string(), mount: z.string() }).nullable(),
  workRoot: z.string().nullable(),
  scratchRoot: z.string().nullable(),
  logRoot: z.string().nullable(),
  retention: z.object({ keepNewest: integer, maxAgeDays: integer.nullable() }),
});

function snapshot<T>(value: z.ZodType<T>) {
  return z.object({ value, revision: z.string(), configured: z.boolean() });
}

export const profilesView = snapshot(profiles).transform((settings) => ({
  settings,
}));
export const dispatchView = snapshot(dispatch).transform((settings) => ({
  settings,
}));
export const projectsView = z.object({
  settings: snapshot(projects),
  resolvedPlanners: z.record(z.string(), z.string().nullable()),
  verifiedPlanners: z.record(z.string(), z.array(z.string())).optional(),
});
export const hostsView = z.object({
  settings: snapshot(hosts),
  active: z.object({
    endpoint: z.string(),
    status: z.enum(["unknown", "reachable", "unavailable"]),
  }),
});
export const storageView = z.object({
  settings: snapshot(storage),
  active: z.object({
    databaseRoot: z.string(),
    workRoot: z.string(),
    backupRoot: z.string(),
    scratchRoot: z.string(),
    logRoot: z.string(),
  }),
  backups: z
    .object({
      complete: z.boolean(),
      issues: integer,
      verified: z.array(z.object({ id: z.string(), createdAt: z.string() })),
    })
    .optional(),
});
export const browserSession = z.object({ canEditSettings: z.boolean() });

export type Project = z.infer<typeof project>;
export type Repository = z.infer<typeof repository>;
export type Projects = z.infer<typeof projects>;
export type NamedProfile = z.infer<typeof namedProfile>;
export type Profiles = z.infer<typeof profiles>;
export type SettingsEdit<T> = (value: T) => T;

type Domain = "profiles" | "dispatch" | "projects" | "hosts" | "storage";
type View = {
  settings: { value: unknown; revision: string; configured: boolean };
};
export const settingsKey = ["rust-settings"];
const api = createRustBoardTransport();

export function readBrowserSession() {
  return api.read(browserSession, "/session");
}

export function useEditor<R extends View>(
  domain: Domain,
  schema: z.ZodType<R>,
) {
  const client = useQueryClient();
  const key = [...settingsKey, domain];
  const path = "/settings/" + domain;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.read(schema, path, { signal }),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { status, write } = useSettingsWriter<R>(key);
  return {
    query,
    status,
    save: (edit: SettingsEdit<R["settings"]["value"]>) =>
      write(async (current) => {
        const { revision, value } = current.settings;
        const saved = await putSettings(schema, path, {
          revision,
          value: edit(value),
        });
        await client.cancelQueries({ queryKey: key, exact: true });
        // PUT storage omits its backup listing. Keep it until the next read.
        client.setQueryData<R>(key, (latest) =>
          latest &&
          ![revision, saved.settings.revision].includes(
            latest.settings.revision,
          )
            ? latest
            : { ...latest, ...saved },
        );
        if (domain === "storage")
          void client.invalidateQueries({ queryKey: key, exact: true });
      }),
  };
}

export function useSettingsWriter<R>(key: QueryKey) {
  const client = useQueryClient();
  const tail = useRef(Promise.resolve());
  const [status, setStatus] = useState("");
  const write = (operation: (current: R) => Promise<void>) => {
    setStatus("");
    const attempt = tail.current.then(async () => {
      const current = client.getQueryData<R>(key);
      if (!current) return false;
      try {
        await operation(current);
        setStatus("Saved");
        return true;
      } catch (error) {
        setStatus("Not saved: " + errorText(error));
        void client.invalidateQueries({ queryKey: key, exact: true });
        return false;
      }
    });
    tail.current = attempt.then(() => {});
    return attempt;
  };
  return { status, write };
}

export function putSettings<R>(
  schema: z.ZodType<R>,
  path: string,
  value: unknown,
) {
  return api.read(schema, path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}
