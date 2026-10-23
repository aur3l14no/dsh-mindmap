// Agents at work, drawn as Excalidraw collaborators: a cursor where each one
// last read, looked or drew, named after it and saying what it does, with
// what it just changed outlined in its colour (Excalidraw picks it from the
// agent's id). While it thinks between steps the label shows dots.

const TICK_MS = 400
// What an agent just did or said stays on its label this long before the dots take over.
const RECENT_MS = 4000
// What an agent just changed stays outlined this long.
const OUTLINE_MS = 8000
// A finished agent says so this long before it leaves.
const DONE_MS = 3000
const MAX_LABEL = 64

const socketOf = key => `agent:${key}`

/** What an action from the Host reads as, or null. */
export function actionLabel(t, action) {
  switch (action?.kind) {
    case 'read': return action.box ? t('agentReading', { box: action.box }) : t('agentReadingCanvas')
    case 'view': return action.box ? t('agentLooking', { box: action.box }) : t('agentLookingCanvas')
    case 'write': return [
      action.copied && t('agentCopied', { n: action.copied }),
      action.moved && t('agentMoved', { n: action.moved }),
      action.drew && t('agentDrew', { n: action.drew }),
      action.changed && t('agentChanged', { n: action.changed }),
      action.deleted && t('agentDeleted', { n: action.deleted }),
      ...action.locked.map(box => t('agentLocked', { box })),
      ...action.unlocked.map(box => t('agentUnlocked', { box })),
    ].filter(Boolean).slice(0, 2).join(', ') || null
    case 'message': return action.text ? t('agentSays', { to: action.to, text: action.text }) : t('agentMessage', { to: action.to })
    case 'wait': return t('agentWaiting')
    case 'spawn': return t('agentSpawning', { name: action.name })
    case 'team': return t('agentTeam')
    case 'ask': return t('agentAsking')
    case 'plan': return t('agentPlanning')
    case 'tool': return t('agentTool', { name: action.name })
    default: return null
  }
}

const clip = text => (text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text)

export class AgentPresence {
  constructor(t) {
    this.t = t
    this.api = null
    // key → { state, changedAt, drawnAt, doneAt }: the Host's view of each agent, when its label and its outline last changed.
    this.entries = new Map()
    this.timer = null
    this.shown = ''
  }

  attach(api) {
    this.api = api
    this.render()
  }

  /** The whole activity of the canvas, as the Host sent it. */
  update(agents) {
    const now = Date.now()
    const current = new Set()
    for (const state of agents) {
      current.add(state.key)
      const before = this.entries.get(state.key)
      const same = before && before.doneAt === null
      this.entries.set(state.key, {
        state,
        changedAt: same && before.state.seq === state.seq ? before.changedAt : now,
        drawnAt: same && before.state.ids.join() === state.ids.join() ? before.drawnAt : now,
        doneAt: state.phase === 'idle' ? (before?.doneAt ?? now) : null,
      })
    }
    // An agent the Host no longer lists finished without the page hearing it, e.g. across a restart.
    for (const [key, entry] of this.entries) if (!current.has(key) && entry.doneAt === null) entry.doneAt = now
    if (!this.timer && this.entries.size > 0) this.timer = setInterval(() => this.render(), TICK_MS)
    this.render()
  }

  label(entry, now) {
    const { state, changedAt, doneAt } = entry
    if (doneAt !== null) return clip(`${state.name} · ${this.t('agentDone')}`)
    if (state.phase === 'acting' || now - changedAt < RECENT_MS) {
      const what = state.text ?? actionLabel(this.t, state.action)
      if (what) return clip(`${state.name} · ${what}`)
    }
    return `${state.name} ${'·'.repeat(1 + (Math.floor(now / TICK_MS) % 3))}`
  }

  render() {
    const now = Date.now()
    for (const [key, entry] of this.entries) if (entry.doneAt !== null && now - entry.doneAt > DONE_MS) this.entries.delete(key)
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.api) return
    const collaborators = new Map()
    for (const entry of this.entries.values()) {
      const { state, drawnAt, doneAt } = entry
      const outlined = doneAt === null && now - drawnAt < OUTLINE_MS ? state.ids : []
      collaborators.set(socketOf(state.key), {
        id: state.key,
        socketId: socketOf(state.key),
        username: this.label(entry, now),
        ...(state.at ? { pointer: { x: state.at.x, y: state.at.y, tool: 'pointer' } } : {}),
        selectedElementIds: Object.fromEntries(outlined.map(id => [id, true])),
      })
    }
    const shown = JSON.stringify([...collaborators.values()])
    if (shown === this.shown) return
    this.shown = shown
    this.api.updateScene({ collaborators })
  }

  /** Bring the agent behind a collaborator avatar into view; following is not kept, as agents send no viewport. */
  goTo(socketId) {
    const entry = [...this.entries.values()].find(item => socketOf(item.state.key) === socketId)
    const state = this.api?.getAppState()
    if (!state) return
    const at = entry?.state.at
    const zoom = state.zoom.value
    this.api.updateScene({
      appState: {
        userToFollow: null,
        ...(at ? { scrollX: state.width / 2 / zoom - at.x, scrollY: state.height / 2 / zoom - at.y } : {}),
      },
    })
  }

  dispose() {
    clearInterval(this.timer)
    this.timer = null
    this.api = null
  }
}
