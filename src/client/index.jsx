// Browser entry: the Mindmap page in the main area and its sidebar item, and
// the conversation slot the page embeds under the canvas. The canvas, with
// Excalidraw, loads as a separate chunk on first visit.
import { lazy, Suspense, useSyncExternalStore } from 'react'
import en from '../../locale/en.json'
import zh from '../../locale/zh.json'
import { ASSET_PATH } from './api.js'
import { MindmapIcon } from './icons.jsx'

const NS = 'mindmap'
const PANEL_ID = 'mindmap'
const CONVERSATION_SLOT = 'mindmap.conversation'

const CanvasPage = lazy(async () => {
  // Excalidraw fetches its fonts from here; the Host serves them.
  window.EXCALIDRAW_ASSET_PATH = ASSET_PATH
  return { default: (await require.async('./client.canvas.js')).CanvasPage }
})

function systemScheme() {
  return {
    subscribe(listener) {
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      query.addEventListener('change', listener)
      return () => query.removeEventListener('change', listener)
    },
    getSnapshot: () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  }
}

function MindmapPage({ t, openSession, sessions, scheme, locale, SessionProvider, renderSlot }) {
  const colorScheme = useSyncExternalStore(scheme.subscribe, scheme.getSnapshot)
  const language = useSyncExternalStore(locale.subscribe, locale.getSnapshot)
  const chat = { sessions, SessionProvider, render: () => renderSlot(CONVERSATION_SLOT, {}) }
  return (
    <Suspense fallback={<div style={{ padding: 24, color: 'var(--dsw-alias-label-tertiary)' }}>{t('loading')}</div>}>
      <CanvasPage t={t} openSession={openSession} chat={chat} colorScheme={colorScheme} language={language} />
    </Suspense>
  )
}

/** The chat view of the Session the page provides, as DSH embeds a conversation elsewhere. */
function ConversationPanel({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession(value => value)
  const active = useConversation(value => value).activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const parentPending = session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
  const blank = !active && !session.promptAttempted
  const settling = (blank && session.openState === 'loading' && summaryBlank !== true) || parentPending
  const hero = blank && (session.openState === 'open' || summaryBlank === true)
  return renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase: settling ? 'settling' : hero ? 'hero' : 'active',
    hero,
  }, { slots: { views: ChatView } })
}

function ChatView({ renderSlot }) {
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

export const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mindmap: dictionaries')
  const t = ctx.locale.bind(NS)
  const theme = ctx.get('theme')
  const scheme = theme
    ? { subscribe: listener => ctx.on('theme/change', listener), getSnapshot: () => theme.getTheme().active.colorScheme }
    : systemScheme()
  const locale = { subscribe: listener => ctx.locale.subscribe(listener), getSnapshot: () => ctx.locale.getSnapshot().active }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    children: { [CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } },
    inject: () => ({ openSession: target => ctx.uiWorkspace.openSession(target), sessions: ctx.sessions, scheme, locale }),
  }, MindmapPage))
  ctx.slots.inject(CONVERSATION_SLOT, () => ctx.slots.register({ name: CONVERSATION_SLOT }, ConversationPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('panel'),
  }, MindmapIcon))
}
