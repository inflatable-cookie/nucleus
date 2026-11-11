export function pluginRegistration(plugins?: Record<string, { path?: unknown; enabled?: boolean } | null>): { id: string; path: string } | null;
export function pluginCatalogId(catalog: Array<{ id: string }>): string;
