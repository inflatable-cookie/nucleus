import { z } from "zod";

/**
 * T3's `server.getConfig` shapes. Pure schemas only, so both the TypeScript
 * adapter and the Rust engine's board (which reads the scheduler's cached
 * providers) decode the same contract.
 */
const id = z.string().min(1);
/** A model's option choice: one selectable value of one option descriptor (nightly `ProviderOptionChoice`). */
export const optionChoice = z.object({
  id,
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
/**
 * One configurable option of a model (nightly `ProviderOptionDescriptor`):
 * a select with its choices or a boolean toggle, `currentValue` when the provider reports one.
 * `role: "reasoning"` is the nightly's marker for a provider's own thought-level control;
 * every stock driver names its reasoning select `reasoningEffort`.
 */
export const optionDescriptor = z.discriminatedUnion("type", [
  z.object({
    id,
    label: z.string(),
    description: z.string().optional(),
    type: z.literal("select"),
    options: z.array(optionChoice),
    currentValue: z.string().optional(),
    role: z.string().optional(),
  }),
  z.object({
    id,
    label: z.string(),
    description: z.string().optional(),
    type: z.literal("boolean"),
    currentValue: z.boolean().optional(),
  }),
]);
/**
 * The nightly's runtime-mode contract (`packages/contracts/src/providerPolicy.ts`
 * in the source, `RuntimeMode` in the installed bundle): four thread-wide modes,
 * narrowest first, with `full-access` as the default a thread is launched with.
 * A provider reports the subset it offers as `supportedRuntimeModes`; omitting
 * the field means it offers all four, and a request outside the reported subset
 * silently runs as `approval-required` (`providerRuntimeMode`). The adapter never
 * relies on that downgrade: the catalog reports this list per provider and the
 * launch fence refuses a mode the provider does not offer.
 */
export const runtimeModes = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export const runtimeMode = z.enum(runtimeModes);
export type RuntimeMode = z.infer<typeof runtimeMode>;
/** The mode a launch uses when the profile names none (`DEFAULT_RUNTIME_MODE`). */
export const defaultRuntimeMode: RuntimeMode = "full-access";
export const modelCapabilities = z.object({
  optionDescriptors: z.array(optionDescriptor).optional(),
});
/**
 * The nightly's `ServerProviderModel.capabilities` is `NullOr(ModelCapabilities)`:
 * a model T3 has not probed yet reports `null`, which reads as no options here
 * rather than failing the whole `server.getConfig` decode. Whether that absence
 * is a settled fact or a provider mid-probe is the thinking carrier's decision
 * (`. /thinking`), never this schema's.
 */
export const modelCapabilitiesOrNull = modelCapabilities.nullable();
/** One provider of `server.getConfig`'s snapshot. */
export const configProvider = z.object({
  instanceId: id,
  displayName: z.string().optional(),
  enabled: z.boolean(),
  /**
   * The nightly's provider driver (`acpRegistry` for an ACP provider an operator
   * registered in settings). Read-only capability fact: the native-parent path
   * needs the Nucleus ACP instance, and a driver it does not report is not refused
   * on its own (an older nightly may omit it).
   */
  driver: z.string().optional(),
  /** The nightly `ServerProvider` field: the runtime modes this provider offers. Absent means all four. */
  supportedRuntimeModes: z.array(runtimeMode).optional(),
  status: z.string(),
  message: z.string().nullable().optional(),
  models: z.array(
    z.object({
      slug: id,
      name: z.string(),
      aliases: z.array(z.string()).optional(),
      capabilities: modelCapabilitiesOrNull.optional(),
    }),
  ),
});
export const config = z.object({
  environment: z.object({
    environmentId: id,
    serverVersion: id,
    orchestrationProtocolVersion: z.literal(2),
  }),
  /**
   * The server settings this adapter reads, and never writes: a client hides a
   * top-level thread whose tag is in `hiddenThreadTags` while
   * `hideTaggedThreads` is on (recorded contract `supportRows`). Absent means a
   * nightly that reports no settings, which reads as both defaults.
   */
  settings: z
    .object({
      hideTaggedThreads: z.boolean().optional(),
      hiddenThreadTags: z.array(z.string()).optional(),
      providerInstances: z
        .record(
          z.string(),
          z
            .object({
              driver: z.string().optional(),
              enabled: z.boolean().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough()
    .optional(),
  providers: z.array(configProvider),
});
