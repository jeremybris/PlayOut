import type { SteamLinkKind, WebViewerState } from '@shared/web-viewer'
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { api, isMock } from '../../api/client'
import { Button } from '../../components/Button'
import { ButtonHints } from '../../components/ButtonHints'
import { IconButton } from '../../components/IconButton'
import { Modal } from '../../components/Modal'
import { useActionHandlers, useLayerId } from '../../hooks/useActionHandlers'
import { useT } from '../../i18n'
import { addLayerListener, setGamepadActiveElsewhere, topLayer } from '../../input'
import { createLog } from '../../lib/log'
import { WEB_VIEWER_LINE_STEP, WEB_VIEWER_PAGE_SHARE } from './steamLinks'

const log = createLog('web-viewer')

const VIEWER_FOCUS = 'detail:web-viewer'
const CLOSE_FOCUS = `${VIEWER_FOCUS}:close`

export interface WebViewerProps {
  kind: SteamLinkKind
  appId: number
  /** The link's name ("Steam Workshop"), until the page has its own title. */
  title: string
  onClose: () => void
}

/**
 * A Steam game's link (Store, Workshop, PCGamingWiki, Guides) inside PlayOut: a large panel over the game page with
 * PlayOut's own top bar (the page's title and site, Back, Forward, Reload, Open in browser, Close) and, below it, the
 * page itself, which main lays over the panel's empty body (main/web-viewer: a sandboxed view on its own session,
 * limited to Steam's and PCGamingWiki's sites; other links open in the default browser). Mouse, touch and keyboard
 * work in the page as in a browser. Controller: B goes back (closes on the first page), LB / RB back / forward, the
 * D-pad's up / down and the right stick scroll the page, X reloads, Y opens the page in the default browser, A presses
 * the bar's focused button. It closes with the game page and when a game starts. The preview (mock API) shows a
 * placeholder where the page would be.
 */
export function WebViewer({ kind, appId, title, onClose }: WebViewerProps): ReactElement {
  const t = useT()
  const [state, setState] = useState<WebViewerState | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const stateRef = useRef<WebViewerState | null>(null)
  useEffect(() => {
    onCloseRef.current = onClose
    stateRef.current = state
  })

  // Open the page, follow its state; main closing it (a game started, Escape in the page) closes the panel.
  useEffect(() => {
    let live = true
    let opened = false
    const off = api.on('web-viewer:state', (next) => {
      if (!live || !opened) return
      if (!next.open) onCloseRef.current()
      else setState(next)
    })
    api
      .openWebViewer(kind, appId)
      .then((next) => {
        if (!live) return
        opened = true
        setState(next)
      })
      .catch((err) => {
        log.warn('openWebViewer failed', err)
        if (live) onCloseRef.current()
      })
    return () => {
      live = false
      off()
    }
  }, [kind, appId])

  // The page goes away with the panel (B, Close, the game page closing).
  useEffect(
    () => () => {
      api.closeWebViewer().catch((err) => log.warn('closeWebViewer failed', err))
    },
    []
  )

  // The controller keeps working once the page has the keyboard focus (a view inside PlayOut's window), as long as
  // PlayOut is the foreground window.
  useEffect(() => {
    let windowFocused = typeof document.hasFocus !== 'function' || document.hasFocus()
    const off = api.on('window:focus', ({ focused }) => {
      windowFocused = focused
    })
    setGamepadActiveElsewhere(() => windowFocused)
    return () => {
      off()
      setGamepadActiveElsewhere(null)
    }
  }, [])

  // Where the page sits: the panel's empty body, measured again while the panel animates in and on every resize.
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    let last = ''
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const bounds = {
        x: Math.max(0, r.left),
        y: Math.max(0, r.top),
        width: Math.max(0, r.width),
        height: Math.max(0, r.height)
      }
      const key = JSON.stringify(bounds)
      if (key === last) return
      last = key
      api.setWebViewerBounds(bounds).catch((err) => log.warn('setWebViewerBounds failed', err))
    }
    measure()
    const timers = [120, 280, 500].map((ms) => setTimeout(measure, ms))
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  const backOrClose = useCallback(() => {
    if (stateRef.current?.canGoBack) void api.webViewerAction('back').catch(() => undefined)
    else onCloseRef.current()
  }, [])

  const shown = state?.title || title
  const status = state?.failed
    ? t('webViewer.viewer.failed')
    : state?.loading || !state
      ? t('webViewer.viewer.loading')
      : null

  // Rendered at the window's top level, not inside the game panel: the panel's entrance animation (will-change:
  // transform) would hold the viewer inside its box, below the library tabs and inset on every side.
  return createPortal(
    <Modal
      size="dialog"
      bare
      scrim
      closeOnBackdrop={false}
      focusKey={VIEWER_FOCUS}
      preferredChildFocusKey={CLOSE_FOCUS}
      onClose={backOrClose}
      aria-label={t('webViewer.viewer.label', { title })}
      className="web-viewer"
    >
      <ViewerActions />
      <ViewerCover />
      <div className="web-viewer__bar">
        <IconButton
          icon={<ArrowLeft />}
          aria-label={t('webViewer.viewer.back')}
          variant="glass"
          focusKey={`${VIEWER_FOCUS}:back`}
          disabled={!state?.canGoBack}
          onPress={() => void api.webViewerAction('back').catch(() => undefined)}
        />
        <IconButton
          icon={<ArrowRight />}
          aria-label={t('webViewer.viewer.forward')}
          variant="glass"
          focusKey={`${VIEWER_FOCUS}:forward`}
          disabled={!state?.canGoForward}
          onPress={() => void api.webViewerAction('forward').catch(() => undefined)}
        />
        <IconButton
          icon={<RotateCw />}
          aria-label={t('webViewer.viewer.reload')}
          variant="glass"
          focusKey={`${VIEWER_FOCUS}:reload`}
          onPress={() => void api.webViewerAction('reload').catch(() => undefined)}
        />
        <div className="web-viewer__title">
          <span className="web-viewer__name">{shown}</span>
          <span className="web-viewer__host" role="status">
            {status ?? state?.host ?? ''}
          </span>
        </div>
        <IconButton
          icon={<ExternalLink />}
          aria-label={t('webViewer.viewer.external')}
          variant="glass"
          focusKey={`${VIEWER_FOCUS}:external`}
          onPress={() => void api.webViewerAction('external').catch(() => undefined)}
        />
        <IconButton
          icon={<X />}
          aria-label={t('webViewer.viewer.close')}
          variant="glass"
          focusKey={CLOSE_FOCUS}
          onPress={() => onCloseRef.current()}
        />
      </div>
      {state?.held ? (
        <div className="web-viewer__held" role="status">
          <span className="web-viewer__held-text">
            {t('webViewer.viewer.held', { host: state.held.host })}
          </span>
          <Button
            focusKey={`${VIEWER_FOCUS}:held-open`}
            variant="primary"
            icon={<ExternalLink />}
            onPress={() => void api.webViewerAction('open-link').catch(() => undefined)}
          >
            {t('webViewer.viewer.external')}
          </Button>
          <Button
            focusKey={`${VIEWER_FOCUS}:held-dismiss`}
            onPress={() => void api.webViewerAction('dismiss-link').catch(() => undefined)}
          >
            {t('webViewer.viewer.dismiss')}
          </Button>
        </div>
      ) : null}
      <div ref={pageRef} className="web-viewer__page">
        {isMock ? (
          <div className="web-viewer__preview">
            <strong>{t('webViewer.viewer.previewTitle')}</strong>
            <span>{t('webViewer.viewer.preview', { url: state?.url ?? '' })}</span>
          </div>
        ) : null}
      </div>
      {/* The viewer's buttons replace the game page's hints while it is open (detail.css .hints--web-viewer). */}
      <ButtonHints
        className="hints--web-viewer"
        hints={[
          { button: 'b', label: t('webViewer.hints.back') },
          { button: 'lb', label: t('webViewer.hints.previous') },
          { button: 'rb', label: t('webViewer.hints.next') },
          { button: 'dpad', label: t('webViewer.hints.scroll') },
          { button: 'x', label: t('webViewer.hints.reload') },
          { button: 'y', label: t('webViewer.hints.external') }
        ]}
      />
    </Modal>,
    document.body
  )
}

/**
 * Hides the page while anything else of PlayOut's is on top of the viewer (the system bar's Quick panel, a dialog
 * that opened by itself): the page is a native view nothing PlayOut draws can cover. Shown again once the viewer's
 * own layer is the top one.
 */
function ViewerCover(): null {
  const layerId = useLayerId()
  useEffect(() => {
    let sent: boolean | null = null
    const update = (): void => {
      const visible = topLayer() === layerId
      if (visible === sent) return
      sent = visible
      api.setWebViewerVisible(visible).catch((err) => log.warn('setWebViewerVisible failed', err))
    }
    const off = addLayerListener(update)
    update()
    return off
  }, [layerId])
  return null
}

/** The controller's page buttons, on the panel's action layer (registered inside the Modal). */
function ViewerActions(): null {
  const scroll = (deltaY: number): boolean => {
    void api.scrollWebViewer(Math.round(deltaY)).catch(() => undefined)
    return true
  }
  const pageStep = (): number =>
    Math.max(WEB_VIEWER_LINE_STEP, window.innerHeight * WEB_VIEWER_PAGE_SHARE)
  const act = (action: 'back' | 'forward' | 'reload' | 'external'): boolean => {
    void api.webViewerAction(action).catch(() => undefined)
    return true
  }
  useActionHandlers({
    lb: () => act('back'),
    rb: () => act('forward'),
    x: () => act('reload'),
    y: () => act('external'),
    'section-prev': () => scroll(-WEB_VIEWER_LINE_STEP),
    'section-next': () => scroll(WEB_VIEWER_LINE_STEP),
    'rs-up': () => scroll(-pageStep()),
    'rs-down': () => scroll(pageStep())
  })
  return null
}
