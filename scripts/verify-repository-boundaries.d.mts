export type RepositoryEntries = ReadonlyMap<string, string>

export interface RepositorySnapshot {
  files: readonly string[]
  entries: RepositoryEntries
}

export function findForbiddenPathViolations(files: readonly string[]): string[]
export function findLockfileRegistryViolations(lockfileText: string): string[]
export function findRendererBoundaryViolations(entries: RepositoryEntries): string[]
export function findSecretViolations(entries: RepositoryEntries): string[]
export function findWorkflowViolations(workflowText: string): string[]
export function verifyRepositorySnapshot(snapshot: RepositorySnapshot): string[]
export function readTrackedSnapshot(root: string): RepositorySnapshot
