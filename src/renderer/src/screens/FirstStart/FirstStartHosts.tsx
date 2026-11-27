import type { DiscoveredHost } from '@shared/types'
import { Cast } from 'lucide-react'
import type { ReactElement } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useT } from '../../i18n'
import { useUiStore } from '../../state/ui'

/**
 * PlayOut's first start on this PC found PlayOut hosts on the network (main streaming firstStartHosts): offer to pair
 * with one. Picking a host opens Settings › Streaming with its address in the pair form; the host shows the PIN to
 * type (Settings › Streaming › Show PIN on that PC). Once paired, its games, metadata and logins come over, and the
 * Emulation folder downloads (everything but roms, Updates and DLC and texturepacks).
 */
export function FirstStartHosts({
  hosts,
  onClose
}: {
  hosts: DiscoveredHost[]
  onClose: () => void
}): ReactElement {
  const t = useT()
  const connect = (host: DiscoveredHost): void => {
    const ui = useUiStore.getState()
    ui.requestPairing(host.port ? `${host.address}:${host.port}` : host.address)
    onClose()
    ui.openModal({ type: 'settings', section: 'streaming' })
  }
  return (
    <Modal
      size="dialog"
      narrow
      focusKey="first-start"
      title={t('firstStart.title')}
      onClose={onClose}
      footer={
        <Button focusKey="first-start:later" onPress={onClose}>
          {t('firstStart.notNow')}
        </Button>
      }
    >
      <p className="dialog__message">
        {hosts.length === 1
          ? t('firstStart.messageOne', { name: hosts[0]!.name })
          : t('firstStart.messageMany', { count: hosts.length })}
      </p>
      <div className="first-start__hosts">
        {hosts.map((host) => (
          <Button
            key={host.id}
            focusKey={`first-start:host:${host.id}`}
            variant="primary"
            icon={<Cast />}
            onPress={() => connect(host)}
          >
            {t('firstStart.connectTo', { name: host.name })}
          </Button>
        ))}
      </div>
    </Modal>
  )
}
