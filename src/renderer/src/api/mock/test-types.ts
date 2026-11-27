// Type aliases used by the mock's vitest suite (index.test.ts); nothing here ships in the bundle.
import type { PlayOutEvents, ScanProgress as SharedScanProgress } from '@shared/types'

export type ScanProgress = SharedScanProgress
export type SessionEndedPayload = PlayOutEvents['session:ended']
