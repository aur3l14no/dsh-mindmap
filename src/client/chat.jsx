// The conversation under the canvas: the canvas lead's Session, or the
// teammate of a box. It is DSH's own conversation view, so prompting, queueing
// and approvals work as in any session.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BotIcon } from './icons.jsx'

const HEIGHT_KEY = 'dsh-mindmap:chat-height'
const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 160
// Excalidraw switches to its phone layout below this editor height (on screens under 1000 px wide),
// so until the user sizes the chat, it leaves the canvas this much when it can.
const CANVAS_DESKTOP_HEIGHT = 500
// Room the canvas keeps above the chat while it is resized.
const CANVAS_MIN_HEIGHT = 200

/** A teammate is addressed through its Team Lead, as DSH opens teammates. */
function targetOf(leadId, member) {
  return member?.sessionId ? { parentSessionId: leadId, childSessionId: member.sessionId, mode: 'continuable' } : leadId
}

/** Height the canvas and the chat share: the chat's section and the board above it. */
const sharedHeight = section => section.getBoundingClientRect().height + section.previousElementSibling.getBoundingClientRect().height

/**
 * DSH's composer takes the keyboard whenever a conversation opens in it, which
 * under the canvas would swallow Excalidraw's shortcuts. The chat keeps the
 * keyboard only once the user turned to it: pressed in the dock or on a box's
 * agent chip (`data-mm-chat`), or tabbed in. Otherwise focus goes back to the
 * field the user was typing in, or to the canvas.
 */
function useCanvasKeyboard(dock, focusCanvas) {
  useEffect(() => {
    let turned = false
    const onPointer = event => {
      turned = event.target instanceof Element && event.target.closest('.mm-dock, [data-mm-chat]') !== null
    }
    const onKey = event => {
      if (event.key === 'Tab') turned = true
    }
    const onFocus = event => {
      const section = dock.current
      if (turned || !section?.contains(event.target) || section.contains(event.relatedTarget)) return
      const field = event.relatedTarget
      if (field?.isConnected && (field.isContentEditable || field.matches('input, textarea, select'))) field.focus({ preventScroll: true })
      else focusCanvas()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
    }
  }, [])
}

/** Hold a reference to the target Session while it is shown. */
function useReference(sessions, target) {
  const key = typeof target === 'string' ? target : `${target.parentSessionId}/${target.childSessionId}`
  const [held, setHeld] = useState(null)
  useEffect(() => {
    const reference = sessions.retain(target, { source: 'mindmap' })
    setHeld({ key, reference })
    return () => {
      setHeld(null)
      reference.release()
    }
  }, [key])
  return held?.key === key ? held : null
}

/**
 * @param chat - `{ sessions, SessionProvider, render }` from the page's slot.
 * @param members - box teammates `{ name, sessionId, boxes }`.
 * @param member - the teammate talked to, or null for the lead.
 * @param onMember - `(member | null)`.
 * @param focusCanvas - give the keyboard to the canvas.
 */
export function ChatDock({ t, chat, leadId, members, member, onMember, openSession, focusCanvas }) {
  const [open, setOpen] = useState(true)
  const [height, setHeight] = useState(() => Number(localStorage.getItem(HEIGHT_KEY)) || null)
  const dock = useRef(null)
  useCanvasKeyboard(dock, focusCanvas)
  useLayoutEffect(() => {
    if (height !== null) return
    const room = sharedHeight(dock.current) - CANVAS_DESKTOP_HEIGHT
    setHeight(Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, Math.floor(room))))
  }, [])
  const target = targetOf(leadId, member)
  const held = useReference(chat.sessions, target)
  const Provider = chat.SessionProvider
  const resize = event => {
    event.preventDefault()
    const startY = event.clientY
    const max = Math.max(MIN_HEIGHT, sharedHeight(event.currentTarget.parentElement) - CANVAS_MIN_HEIGHT)
    let next = height
    const move = moved => {
      next = Math.round(Math.min(max, Math.max(MIN_HEIGHT, height - (moved.clientY - startY))))
      setHeight(next)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      localStorage.setItem(HEIGHT_KEY, String(next))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }
  return (
    <section ref={dock} className={`mm-dock${open ? '' : ' mm-collapsed'}`} style={open ? { height: height ?? DEFAULT_HEIGHT } : undefined} aria-label={t('chat')}>
      {open && <div className="mm-dock-resize" role="separator" aria-orientation="horizontal" aria-label={t('chatResize')} onPointerDown={resize} />}
      <div className="mm-dock-bar" role="tablist">
        <button type="button" role="tab" aria-selected={!member} className={`mm-tab${member ? '' : ' mm-active'}`} onClick={() => onMember(null)}>
          {t('chatLead')}
        </button>
        {members.map(item => (
          <button key={item.name} type="button" role="tab" aria-selected={member?.name === item.name}
            className={`mm-tab${member?.name === item.name ? ' mm-active' : ''}`} title={t('chatMemberBoxes', { boxes: item.boxes.join(', ') })}
            disabled={!item.sessionId} onClick={() => onMember(item)}>
            <BotIcon size={14} /> {item.name}
          </button>
        ))}
        <span className="mm-spacer" />
        <span className="mm-caption mm-hint">{t('boxHint')}</span>
        <button type="button" className="mm-button mm-ghost" title={t('openSession')} aria-label={t('openSession')} onClick={() => openSession(target)}>↗</button>
        <button type="button" className="mm-button mm-ghost" aria-label={open ? t('chatCollapse') : t('chatExpand')} onClick={() => setOpen(!open)}>{open ? '▾' : '▴'}</button>
      </div>
      {open && held && (
        <div className="mm-dock-body">
          <Provider key={held.key} session={held.reference}>{chat.render()}</Provider>
        </div>
      )}
    </section>
  )
}
