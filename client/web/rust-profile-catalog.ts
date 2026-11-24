import { z } from "zod";
import { t3HostCatalog } from "../../hosts/t3code/catalog";
import { optionDescriptor, runtimeMode } from "../../hosts/t3code/config";
import {
  t3codeProviderOf,
  t3codeVocabulary,
} from "../../hosts/t3code/vocabulary";
import type {
  HostCatalog,
  HostProvider,
  StoredHostCatalog,
} from "../../shared/host";
import {
  canonicalCatalog,
  isCanonicalOption,
} from "../../shared/profile-vocabulary";
import type { NucleusProfile } from "../../shared/profiles";
import type { RustCachedCatalog } from "./rust-api";

// The config stream is forward-compatible. A malformed optional value or model
// descriptor must not erase a whole provider's usable models.
const id = z.string().refine((value) => value.trim().length > 0);
const label = z.string().trim().min(1).optional().catch(undefined);
const entries = z.array(z.unknown()).catch([]);
const cachedChoice = z
  .object({
    id,
    label,
    description: label,
    isDefault: z.boolean().optional().catch(undefined),
  })
  .transform((choice) => ({ ...choice, label: choice.label ?? choice.id }));

const cachedDescriptor = z.object({
  id,
  label,
  description: label,
  type: z.enum(["select", "boolean"]),
  role: label,
  options: entries,
  currentValue: z.unknown().optional(),
});
const cachedModel = z.object({
  slug: id,
  name: label,
  capabilities: z.object({ optionDescriptors: entries }).nullish().catch(null),
});
const cachedProvider = z.object({
  instanceId: id,
  driver: z.string().optional(),
  enabled: z.boolean(),
  status: z.string(),
  supportedRuntimeModes: z.unknown().optional(),
  models: z.array(z.unknown()),
});

function parseEntries<T>(
  entries: readonly unknown[],
  schema: z.ZodType<T>,
): T[] {
  return entries.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

type Instance = { driver: string; id: string; provider: HostProvider };

export function cachedInstances(cached: RustCachedCatalog): Instance[] {
  return parseEntries(cached.providers ?? [], cachedProvider)
    .flatMap((provider) => {
      const driver = provider.driver ?? provider.instanceId;
      if (!t3codeProviderOf(driver)) return [];
      const rawModes = provider.supportedRuntimeModes;
      const supportedRuntimeModes = parseEntries(
        entries.parse(rawModes),
        runtimeMode,
      );
      const invalidModes =
        rawModes !== undefined &&
        (!Array.isArray(rawModes) ||
          (rawModes.length > 0 && !supportedRuntimeModes.length));
      const models = parseEntries(provider.models, cachedModel).map(
        (model) => ({
          name: model.name ?? model.slug,
          slug: model.slug,
          capabilities: {
            optionDescriptors: parseEntries(
              parseEntries(
                model.capabilities?.optionDescriptors ?? [],
                cachedDescriptor,
              ).map((option) => ({
                ...option,
                label: option.label ?? option.id,
                currentValue:
                  typeof option.currentValue ===
                  (option.type === "select" ? "string" : "boolean")
                    ? option.currentValue
                    : undefined,
                options: parseEntries(option.options, cachedChoice),
              })),
              optionDescriptor,
            ),
          },
        }),
      );
      // The actual instance is kept separately. T3's vocabulary is keyed by driver.
      return t3HostCatalog([
        {
          ...provider,
          instanceId: driver,
          enabled: provider.enabled && !invalidModes,
          supportedRuntimeModes,
          models,
        },
      ]).providers.map((native) => ({
        driver,
        id: provider.instanceId,
        provider: {
          ...native,
          models: native.models.map((model) => ({
            ...model,
            // A missing Rust carrier cannot express any explicit effort yet.
            thinkingOptions: model.unsettled ? [] : model.thinkingOptions,
          })),
        },
      }));
    })
    .sort(
      (a, b) =>
        Number(b.provider.available) - Number(a.provider.available) ||
        Number(b.id === b.driver) - Number(a.id === a.driver) ||
        (a.id < b.id ? -1 : Number(a.id > b.id)),
    );
}

export function vocabularyCatalog(
  cached: RustCachedCatalog,
): StoredHostCatalog {
  const byDriver = new Map<string, HostProvider>();
  for (const { driver, provider } of cachedInstances(cached)) {
    const current = byDriver.get(driver);
    if (!current) {
      byDriver.set(driver, { ...provider, models: [...provider.models] });
      continue;
    }
    // Default ready instance first; other instances can supply additional IDs.
    const ids = new Set(current.models.map((model) => model.id));
    current.models.push(
      ...provider.models.filter((model) => !ids.has(model.id)),
    );
  }
  const canonical = canonicalCatalog(t3codeVocabulary, {
    providers: [...byDriver.values()],
  });
  return {
    providers: canonical.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        features: model.features.filter((feature) =>
          isCanonicalOption(feature.id),
        ),
      })),
    })),
    readAt: catalogReadAt(cached) ?? "",
    cacheStatus: cached.status,
  };
}

export function catalogReadAt(cached: RustCachedCatalog) {
  return cached.readAtMs === null
    ? null
    : new Date(cached.readAtMs).toISOString();
}

export function profileInstanceCatalog(
  instances: readonly Instance[],
  profile: NucleusProfile,
  pin: string | undefined,
): HostCatalog {
  const candidates = instances.filter(
    (instance) =>
      t3codeProviderOf(instance.driver) === profile.provider &&
      (pin === undefined || instance.id === pin),
  );
  // Compatibility uses one instance at a time. A pinned profile must never
  // borrow a similarly named model from another instance.
  const instance =
    candidates.find(({ provider }) =>
      provider.models.some((model) => model.id === profile.model),
    ) ?? candidates[0];
  return { providers: instance ? [instance.provider] : [] };
}
