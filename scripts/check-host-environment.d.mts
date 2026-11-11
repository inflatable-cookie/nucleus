export interface HostEnvironmentViolation { path: string; name: string; count: number }
export function hostEnvironmentNames(path: string, source: string): string[];
export function hostEnvironmentViolations(root: string): HostEnvironmentViolation[];
export function checkHostEnvironment(root: string): string[];
