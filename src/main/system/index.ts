// System bar data and controls (docs/ARCHITECTURE.md section 4.7): status polling through one persistent
// PowerShell worker, plus volume, brightness, power mode, power actions and Windows Settings deep links.
export { createSystemService, WORKER_INIT, type SystemServiceOptions } from './status'
export { runPowerShell, runPowerShellJson } from './powershell'
export { readRegistryKey, registryValue } from './registry'
export { createPsWorker, PsError, type PsRunner, type PsWorker } from './ps-worker'
export type { SystemDeps, SystemService } from './types'
