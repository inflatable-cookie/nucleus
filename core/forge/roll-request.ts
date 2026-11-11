/** Synchronous service-owned advisory action; core never loads the service. */
let requestRoll: ((repositoryPath: string) => boolean) | null = null;
export function onRepositorySyncRollRequest(handler: (repositoryPath: string) => boolean) { requestRoll = handler; }
export function requestServiceRollAfterRepositorySync(repositoryPath: string): boolean { return requestRoll?.(repositoryPath) ?? false; }
