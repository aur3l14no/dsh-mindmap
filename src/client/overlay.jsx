// In-canvas controls drawn over Excalidraw: chips on each box naming the agent
// it belongs to and who holds its lock, and the popover that asks a new agent
// to work in a box.
import { useState } from 'react'
import { boxInfo, sameAgent } from '../shared/scene.js'
import { BotIcon, LockIcon } from './icons.jsx'

const POPOVER_WIDTH = 320
const POPOVER_HEIGHT = 190
const MARGIN = 8

export function toView(view, x, y) {
  return { left: (x + view.scrollX) * view.zoom, top: (y + view.scrollY) * view.zoom }
}

/**
 * @param view - `{ scrollX, scrollY, zoom, width, height }` of the canvas.
 * @param frames - live boxes.
 * @param selectedId - the one selected box, offered a lock and, without an owner, an agent.
 * @param chatWith - the agent the chat under the canvas talks to, or null for the lead.
 * @param members - whether boxes can get their own agent.
 * @param onChat - `(owner)`: talk to a box's agent; `onLock(frame, lock)`; `onAsk(frameId)`.
 */
export function BoxBadges({ t, view, frames, selectedId, chatWith, members, onChat, onLock, onAsk }) {
  return (
    <div className="mm-overlay">
      {frames.map(frame => {
        const { owner, lock: holder } = boxInfo(frame)
        const selected = frame.id === selectedId
        if (!owner && !holder && !selected) return null
        const lockedBy = holder === 'user' ? t('you') : holder?.name
        const lockHint = holder === 'user' ? t('lockedByYou') : t('lockedByHint', { holder: lockedBy })
        return (
          <div key={frame.id} className="mm-badges" style={toView(view, frame.x + frame.width, frame.y)}>
            {owner && (
              <button type="button" className={`mm-badge mm-agent${chatWith === owner.name ? ' mm-active' : ''}`} data-mm-chat=""
                title={t('chatWith', { name: owner.name })} onClick={() => onChat(owner)}>
                <BotIcon size={14} /> {owner.name}
              </button>
            )}
            {!owner && selected && members && (
              <button type="button" className="mm-badge mm-agent" onClick={() => onAsk(frame.id)}>
                <BotIcon size={14} /> {t('askAgent')}
              </button>
            )}
            {holder && (
              <button type="button" className="mm-badge mm-locked" title={lockHint} aria-label={lockHint}
                onClick={() => onLock(frame, false)}>
                <LockIcon />{sameAgent(holder, owner) ? null : ` ${lockedBy}`}
              </button>
            )}
            {!holder && selected && (
              <button type="button" className="mm-badge" onClick={() => onLock(frame, true)}>
                <LockIcon open /> {t('lock')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Below the box, or above it when there is no room below, kept inside the canvas. */
function popoverPosition(frame, view) {
  const { left, top } = toView(view, frame.x, frame.y + frame.height)
  const below = top + MARGIN
  const above = toView(view, frame.x, frame.y).top - POPOVER_HEIGHT - 28
  return {
    left: Math.max(MARGIN, Math.min(left, view.width - POPOVER_WIDTH - MARGIN)),
    top: Math.max(56, below + POPOVER_HEIGHT <= view.height - MARGIN ? below : Math.max(above, MARGIN)),
  }
}

/**
 * Ask a new agent to work in a box.
 * @param onSubmit - `(instruction)`, resolves once the agent started, rejects with the Host's reason.
 */
export function AskPopover({ t, frame, view, autoFocus, onSubmit, onClose }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const name = boxInfo(frame).name
  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text.trim())
    } catch (reason) {
      setError(reason.message)
      setBusy(false)
    }
  }
  return (
    <div className="mm-popover" style={popoverPosition(frame, view)} role="dialog" aria-label={t('askTitle', { box: name })}
      onKeyDown={event => { if (event.key === 'Escape') onClose() }}>
      <div className="mm-popover-head">
        <BotIcon size={22} />
        <span className="mm-popover-title">{t('askTitle', { box: name })}</span>
        <button type="button" className="mm-button mm-ghost" onClick={onClose} aria-label={t('close')}>✕</button>
      </div>
      <textarea className="mm-textarea" autoFocus={autoFocus} value={text} placeholder={t('askPlaceholder')} disabled={busy}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }} />
      {error && <div className="mm-error">{error}</div>}
      <div className="mm-actions">
        <span className="mm-caption">{t('askHint')}</span>
        <span className="mm-spacer" />
        <button type="button" className="mm-button mm-primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? t('askStarting') : t('askStart')}</button>
      </div>
    </div>
  )
}
