import type { WindowsSettingsPage } from '../../shared/types'

/**
 * Windows Settings deep links (ms-settings: URI scheme). The research reports give no page table, so these are
 * the documented Windows 11 page names. Controllers have no page of their own: "Bluetooth & devices > Devices"
 * is where Windows 11 lists and configures them.
 */
export const SETTINGS_URIS: Record<WindowsSettingsPage, string> = {
  bluetooth: 'ms-settings:bluetooth',
  wifi: 'ms-settings:network-wifi',
  sound: 'ms-settings:sound',
  display: 'ms-settings:display',
  power: 'ms-settings:powersleep',
  gamepad: 'ms-settings:connecteddevices'
}

export function settingsUri(page: WindowsSettingsPage): string {
  const uri = SETTINGS_URIS[page]
  if (!uri) throw new Error(`Unknown Windows Settings page: ${String(page)}`)
  return uri
}

/** Loaded lazily so this module (and its tests) can run outside Electron. */
async function openExternal(uri: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(uri)
}

export async function openWindowsSettings(
  page: WindowsSettingsPage,
  open: (uri: string) => Promise<void> = openExternal
): Promise<void> {
  await open(settingsUri(page))
}
