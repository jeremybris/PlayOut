import type { CredentialService, ServiceCredentials } from '@shared/types'
import { useCallback, useEffect } from 'react'
import { api } from '../../api/client'
import { t } from '../../i18n'
import {
  CREDENTIAL_SERVICE_NAMES,
  credentialsReady,
  credentialsSignature
} from '../../lib/credentials'
import { useUiStore } from '../../state/ui'
import { log } from './common'

/** Pause after the last keystroke before the service is asked; a paste is one keystroke. */
const TEST_DELAY_MS = 800

interface GroupState {
  timer: ReturnType<typeof setTimeout> | null
  /** Bumped by every edit; a result for an older edit is dropped. */
  seq: number
  /** The values whose last answer was definite (works / doesn't work): not asked again until they change. */
  answered: string | null
  run: (() => void) | null
}

/**
 * Per service, shared by every mount of the Metadata section: Settings shows one section at a time, so a test
 * flushed when the section closes can still be answering when it reopens, and an edit there must overtake it.
 */
const groups = new Map<CredentialService, GroupState>()

/**
 * Test a metadata service's credentials shortly after they are typed or pasted, and show the answer as a toast.
 * Call the returned function with every edit of a service's fields; it waits until the fields are complete, asks
 * once per pause, and drops answers that an edit made since has overtaken. Pending tests still run when the
 * Metadata section closes, so a key pasted just before leaving is checked too.
 */
export function useCredentialTest(): <S extends CredentialService>(
  service: S,
  credentials: ServiceCredentials<S>
) => void {
  const toast = useUiStore((s) => s.toast)

  useEffect(
    () => () => {
      for (const state of groups.values()) {
        if (state.timer) clearTimeout(state.timer)
        state.timer = null
        state.run?.()
      }
    },
    []
  )

  return useCallback(
    <S extends CredentialService>(service: S, credentials: ServiceCredentials<S>) => {
      let state = groups.get(service)
      if (!state) {
        state = { timer: null, seq: 0, answered: null, run: null }
        groups.set(service, state)
      }
      const group = state
      const seq = ++group.seq
      if (group.timer) clearTimeout(group.timer)
      group.timer = null
      group.run = null
      if (!credentialsReady(service, credentials)) {
        // Cleared or half typed: entering the same values again is a fresh request for an answer.
        group.answered = null
        return
      }
      const signature = credentialsSignature(credentials)
      if (signature === group.answered) return

      group.run = () => {
        group.run = null
        api
          .testCredentials(service, credentials)
          .then((result) => {
            if (group.seq !== seq) return
            if (result.status !== 'unchecked') group.answered = signature
            toast(
              result.message,
              result.status === 'valid' ? 'success' : result.status === 'invalid' ? 'error' : 'info'
            )
          })
          .catch((err) => {
            log.error(`testCredentials(${service}) failed`, err)
            if (group.seq === seq) {
              toast(
                t('settings.credentials.checkFailed', {
                  service: CREDENTIAL_SERVICE_NAMES[service]
                }),
                'info'
              )
            }
          })
      }
      group.timer = setTimeout(() => {
        group.timer = null
        group.run?.()
      }, TEST_DELAY_MS)
    },
    [toast]
  )
}
