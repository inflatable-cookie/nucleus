import type { PoolEntry } from '../../shared/contracts';
import type { HostCatalog } from '../../shared/host';

/**
 * The installed nightly's provider snapshot as `server.getConfig` reports it
 * (0.1.10-nightly.20261111.4529): the option descriptors each model carries, and
 * the runtime modes each provider restricts itself to. Codex and Claude report
 * no `supportedRuntimeModes`, so the nightly passes any of the four through
 * (`providerRuntimeMode`); Grok and Pi report a subset, and a request outside it
 * silently runs as `approval-required`. Copied, never connected: identifiers are
 * synthetic and the shapes are the contract.
 */
export const nightlyProviders = () => [
  { instanceId: 'codex', displayName: 'Codex', enabled: true, status: 'ready', models: [
    { slug: 'gpt-6-luna', name: 'Luna', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, label: id })) },
      { id: 'serviceTier', label: 'Service Tier', type: 'select', currentValue: 'default', options: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'priority', label: 'Priority' }] },
    ] } },
    { slug: 'gpt-6.1-sol', name: 'Sol', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'gpt-6.1-terra', name: 'Terra', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'claudeAgent', displayName: 'Claude', enabled: true, status: 'ready', models: [
    { slug: 'claude-haiku-5-5', name: 'Haiku', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'claude-opus-5-5', name: 'Opus', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'grok', displayName: 'Grok', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto', 'full-access'], models: [
    { slug: 'grok-4.6', name: 'Grok 4.6', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'high', options: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'pi', displayName: 'Pi', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'full-access'], models: [
    { slug: 'opencode-go/muse-spark-1.3-contributor', name: 'Muse 1.3', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['minimal', 'low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'opencode-go/deepseek-v4.1-flash', name: 'Deepseek 4.1 Flash', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['low', 'high', 'max'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'cursor', displayName: 'Cursor', enabled: false, status: 'disabled', models: [] },
];

/**
 * Synthetic copies of the live profile pool's shapes (read once, read-only),
 * in Nucleus's canonical vocabulary (task 1158): provider, model, thinking level,
 * runtime mode, roles, capability, cost and whether the pool enables it. The
 * live pool's Paseo spellings moved once: Claude's `bypassPermissions` is
 * `full-access`, and Grok's `auto_accept` option is the `full-access` mode. The
 * ids and names are synthetic so the fixture carries no live identity.
 */
export type ShapeProfile = { label: string; provider: string; model: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> };
export const poolShapes: Array<{ entry: Omit<PoolEntry, 'profileId'>; profile: ShapeProfile }> = [
  { entry: { enabled: true, group: 'codex', roles: ['worker', 'coordinator', 'reviewer'], cost: 'very_low', capability: 'low', weight: 2, scopes: ['general', 'mechanical'] },
    profile: { label: 'Codex grind (full-access)', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer', 'worker'], cost: 'high', capability: 'very_high', weight: 1, scopes: ['complex', 'general'] },
    profile: { label: 'Codex oracle (full-access)', provider: 'codex', model: 'gpt-6.1-sol', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'codex', roles: ['worker'], cost: 'medium', capability: 'high', weight: 1, scopes: ['general'] },
    profile: { label: 'Codex worker (full-access)', provider: 'codex', model: 'gpt-6.1-terra', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['worker', 'reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general', 'mechanical'] },
    profile: { label: 'Claude haiku (auto)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'auto', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['reviewer', 'worker'], cost: 'very_high', capability: 'frontier', weight: 1, scopes: ['general', 'complex'] },
    profile: { label: 'Claude opus (full-access)', provider: 'claude', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: 'medium' } },
  { entry: { enabled: false, group: 'claude', roles: ['worker'], cost: 'very_high', capability: 'very_high', weight: 1, scopes: ['general'] },
    profile: { label: 'Claude sonnet (full-access, disabled)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'grok', roles: ['worker', 'reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general', 'complex'] },
    profile: { label: 'Grok (full-access)', provider: 'grok', model: 'grok-4.6', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'meta', roles: ['worker', 'reviewer', 'coordinator'], cost: 'very_low', capability: 'low', weight: 1, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi muse (no mode)', provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'deepseek', roles: ['worker', 'reviewer'], cost: 'low', capability: 'medium', weight: 2, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi deepseek (no mode)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high', featureValues: {} } },
  { entry: { enabled: false, group: 'glm', roles: ['worker', 'reviewer', 'coordinator'], cost: 'low', capability: 'medium', weight: 2, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi glm (no mode, disabled)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' } },
  // The mode fence itself: a canonical mode neither host's Codex can express,
  // and one both can.
  { entry: { enabled: true, group: 'codex', roles: ['worker'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general'] },
    profile: { label: 'Mode-only (plan)', provider: 'codex', model: 'gpt-6-luna', modeId: 'plan' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general'] },
    profile: { label: 'Mode-only (auto)', provider: 'codex', model: 'gpt-6-luna', modeId: 'auto' } },
];


/**
 * A synthetic Paseo catalog in the shape the daemon reports (read once from the
 * live catalog, 2026-11-12): Claude's five modes and its thinking ids with
 * `ultracode`, Codex's three modes, Pi's opencode-go models with thinking levels
 * and no modes, and Grok with its `auto_accept` toggle (a read with a project
 * directory). Identifiers are synthetic.
 */
const levels = (...ids: string[]) => ids.map(id => ({ id, label: id }));
export const paseoCatalog = (): HostCatalog => ({ providers: [
  { key: 'claude', label: 'Claude', available: true, problem: '', models: ['claude-haiku-5-5', 'claude-opus-5-5'].map(id => ({ id, label: id, aliases: [],
    thinkingOptions: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultracode'), defaultThinkingOptionId: null,
    modes: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'].map(mode => ({ id: mode, label: mode })), features: [] })) },
  { key: 'codex', label: 'Codex', available: true, problem: '', models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, label: id, aliases: [],
    thinkingOptions: levels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), defaultThinkingOptionId: null,
    modes: ['auto', 'auto-review', 'full-access'].map(mode => ({ id: mode, label: mode })), features: [] })) },
  { key: 'pi', label: 'Pi', available: true, problem: '', models: [
    { id: 'opencode-go/muse-spark-1.3-contributor', label: 'Muse', aliases: [], thinkingOptions: levels('minimal', 'low', 'medium', 'high', 'xhigh'), defaultThinkingOptionId: null, modes: [], features: [] },
    { id: 'opencode-go/deepseek-v4.1-flash', label: 'Deepseek', aliases: [], thinkingOptions: levels('low', 'high', 'max'), defaultThinkingOptionId: null, modes: [], features: [] }] },
  { key: 'grok', label: 'Grok', available: true, problem: '', models: [{ id: 'grok-4.6', label: 'Grok 4.6', aliases: [], thinkingOptions: levels('xhigh', 'high', 'medium', 'low'), defaultThinkingOptionId: null, modes: [],
    features: [{ type: 'toggle' as const, id: 'auto_accept', label: 'Auto accept', value: false }] }] },
] });
