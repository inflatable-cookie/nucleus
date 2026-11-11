export function install(source: string, expected?: string, options?: { activate?: boolean }): Promise<any>;
export function verifyVersion(root: string): Promise<any>;
export function activateVersion(root: string): Promise<void>;
export function installBase(): string;
export function recoverPrevious(): Promise<{ revision: string; next: string }>;
