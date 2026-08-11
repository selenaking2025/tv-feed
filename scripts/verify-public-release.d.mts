import type { RepositorySnapshot } from './verify-repository-boundaries.mjs'

export function findPublicReleaseSnapshotViolations(snapshot: RepositorySnapshot): string[]
export function findGitReleaseStateViolations(root: string): string[]
