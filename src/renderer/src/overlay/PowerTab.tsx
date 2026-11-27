import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { PowerMenu } from '../screens/QuickPanel/PowerMenu'
import { GameActions } from './GameActions'
import { OverlayGroup } from './parts'

/** Power tab: the game actions again, then PlayOut's power menu (sleep, restart, shut down…). */
export function PowerTab(): ReactElement {
  const t = useT()
  return (
    <>
      <OverlayGroup title={t('overlay.power.game')}>
        <GameActions focusKey="overlay:power:game" />
      </OverlayGroup>
      <OverlayGroup title={t('overlay.power.power')}>
        <PowerMenu focusKey="overlay:power" />
      </OverlayGroup>
    </>
  )
}
