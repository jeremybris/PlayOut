import { Gamepad2 } from 'lucide-react'
import type { ReactElement } from 'react'
import { consoleIcon } from '../lib/consoleIcons'

/**
 * A system's console picture before its name in Filters > Platform (lib/consoleIcons.ts), or a plain controller for a
 * system without one, so every row lines up.
 */
export function ConsoleIcon({ systemId }: { systemId: string }): ReactElement {
  const url = consoleIcon(systemId)
  return (
    <span className="console-icon" aria-hidden="true">
      {url ? (
        <img className="console-icon__img" src={url} alt="" draggable={false} />
      ) : (
        <Gamepad2 className="console-icon__generic" />
      )}
    </span>
  )
}
