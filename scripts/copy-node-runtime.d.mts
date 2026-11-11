export function copyNodeRuntime(destination: string, source?: string): {
  libraries: Array<{ source: string; file: string }>;
  systemLibraries: string[];
};
