// What the agents of each canvas are doing right now, for the canvas page to
// show them as collaborators: thinking between steps, what they read, looked
// at or drew and where, or another tool by name. Built from the session events
// as they are committed and from the canvas tools themselves; nothing is
// stored, so after a restart everyone starts idle.
import { boxInfo, elementBounds, frameBox, isBox, unionBox } from '../shared/scene.js'

const TEXT_LIMIT = 80
const MAX_IDS = 200
// Where a cursor sits in a box it reads or looks at: just inside the top-left corner.
const BOX_INSET = 24

const keyOf = writer => `${writer.lead}/${writer.name}`

/** The first line of `text` without Markdown marks, cut to fit a cursor label; null when it has none. */
function firstLine(text) {
  const line = text.split('\n').map(item => item.replace(/[#*`>_]+/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean)
  if (!line) return null
  return line.length > TEXT_LIMIT ? `${line.slice(0, TEXT_LIMIT - 1)}…` : line
}

/** The first line an agent wrote with its tool calls, cut to fit a cursor label; null when it wrote none. */
export function narration(message) {
  return firstLine((message?.content ?? [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join(' '))
}

/** How a tool other than the canvas tools shows. */
export function toolAction(name, args) {
  switch (name) {
    case 'send_message': return { kind: 'message', to: String(args?.target ?? ''), text: firstLine(String(args?.message ?? '')) }
    case 'wait_agent': return { kind: 'wait' }
    case 'spawn_teammate': return { kind: 'spawn', name: String(args?.name ?? '') }
    case 'ask_user_question': return { kind: 'ask' }
    case 'todo_write': return { kind: 'plan' }
    case 'list_agents':
    case 'team_task_list':
    case 'team_task_get':
    case 'team_task_create':
    case 'team_task_update': return { kind: 'team' }
    default: return { kind: 'tool', name }
  }
}

/** A canvas_write as it shows: groups copied and moved, elements drawn, changed and removed, boxes locked and unlocked. */
export function writeAction(canvas, args, report) {
  const copiedElements = report.copies.reduce((sum, copy) => sum + copy.count, 0)
  const locked = []
  const unlocked = []
  let changed = 0
  for (const input of args.elements ?? []) {
    const existing = input && typeof input.id === 'string' ? canvas.get(input.id) : undefined
    if (!existing || input.type !== undefined) continue
    if (isBox(existing) && typeof input.lock === 'boolean') (input.lock ? locked : unlocked).push(boxInfo(existing).name)
    if (Object.keys(input).some(key => key !== 'id' && key !== 'lock')) changed += 1
  }
  return {
    kind: 'write',
    copied: args.copy?.length ?? 0,
    moved: args.move?.length ?? 0,
    drew: Math.max(0, report.created.length - copiedElements),
    changed,
    deleted: report.deleted.length,
    locked,
    unlocked,
  }
}

/** The middle of what `ids` cover now, or null. */
function centreOf(canvas, ids) {
  const box = unionBox(ids.map(id => canvas.get(id)).filter(element => element && !element.isDeleted)
    .map(element => isBox(element) ? frameBox(element) : elementBounds(element)))
  return box && { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 }
}

const within = (point, box) => point.x >= box.x1 && point.x <= box.x2 && point.y >= box.y1 && point.y <= box.y2

const insideBox = frame => ({ x: frame.x + Math.min(BOX_INSET, frame.width / 2), y: frame.y + Math.min(BOX_INSET, frame.height / 2) })

export class CanvasActivity {
  /** @param deps - `{ canvases, team, agents }`: loaded canvases by lead, Team identities, and live agents by Session id. */
  constructor({ canvases, team, agents }) {
    this.canvases = canvases
    this.team = team
    this.agents = agents
    // Session id → `{ canvas, key, name }` or null, settled again at each turn start.
    this.sessions = new Map()
    this.states = new Map()
    this.places = new Map()
    this.listeners = new Map()
  }

  /** Call `listener(agents)` with the whole activity of `canvas` on every change; returns the unsubscriber. */
  subscribe(canvas, listener) {
    const set = this.listeners.get(canvas) ?? new Set()
    set.add(listener)
    this.listeners.set(canvas, set)
    return () => set.delete(listener)
  }

  /** The agents at work on `canvas`: `[{ key, name, phase, action, text, seq, at, ids }]`. */
  snapshot(canvas) {
    return [...(this.states.get(canvas)?.values() ?? [])]
  }

  /** A committed session event, from DSH's `session/event` feed. */
  noteEvent(session, event) {
    if (event.type === 'turn/start' || !this.sessions.has(session.id)) this.sessions.set(session.id, this.locate(session.id))
    const where = this.sessions.get(session.id)
    if (!where) return
    const { canvas, key, name } = where
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        return this.update(canvas, key, name, { phase: 'thinking', action: null, text: null })
      case 'step/start':
        return this.update(canvas, key, name, { phase: 'thinking' })
      case 'assistant/message':
        // What it says comes with the tool calls it makes, and stays until it says something else.
        return this.update(canvas, key, name, { text: narration(data.message) })
      case 'tool/call': {
        if (typeof data.name !== 'string' || data.name.startsWith('canvas_')) return
        let args = {}
        try {
          args = JSON.parse(data.arguments ?? '{}')
        } catch {}
        const action = toolAction(data.name, args)
        // A message it sends is what it says now.
        return this.update(canvas, key, name, { phase: 'acting', action, ...(action.kind === 'message' ? { text: null } : {}) })
      }
      case 'turn/end':
        return this.finish(canvas, key)
    }
  }

  /** The Session left DSH; what it routes to is settled again if it comes back. */
  forget(sessionId) {
    this.sessions.delete(sessionId)
  }

  /** `writer` read or looked at `canvas`, all of it or one box; the cursor goes to the box unless it is in it already. */
  noteLook(canvas, writer, sessionId, kind, box) {
    this.claim(canvas, writer, sessionId)
    const place = this.places.get(canvas)?.get(keyOf(writer))
    const stays = !box || (place && within(place, frameBox(box)))
    this.update(canvas, keyOf(writer), writer.name, {
      phase: 'acting',
      action: { kind, box: box ? boxInfo(box).name : null },
      ...(stays ? {} : { at: insideBox(box) }),
    })
  }

  /** `writer` changed `canvas` with canvas_write `args`, as `report` from prepareWrite says. */
  noteWrite(canvas, writer, sessionId, args, report) {
    this.claim(canvas, writer, sessionId)
    const ids = [...report.created, ...report.updated].filter(id => !canvas.get(id)?.containerId)
    // The cursor goes to what was drawn, or to the boxes when only boxes changed.
    const drawn = ids.filter(id => !isBox(canvas.get(id)))
    const at = centreOf(canvas, drawn.length > 0 ? drawn : ids)
    this.update(canvas, keyOf(writer), writer.name, {
      phase: 'acting',
      action: writeAction(canvas, args, report),
      ...(at ? { at, ids: ids.slice(0, MAX_IDS) } : {}),
    })
  }

  /** The canvas and Team name a Session works as, or null when it leads no loaded canvas's Team. */
  locate(sessionId) {
    const agent = this.agents.get(sessionId)
    if (!agent) return null
    const writer = this.team.writerOf(agent)
    const canvas = this.canvases.byLead(writer.lead)
    return canvas ? { canvas, key: keyOf(writer), name: writer.name } : null
  }

  /** Route the rest of this turn to `canvas`, also for an agent outside its Team that uses the canvas tools on it. */
  claim(canvas, writer, sessionId) {
    this.sessions.set(sessionId, { canvas, key: keyOf(writer), name: writer.name })
  }

  update(canvas, key, name, patch) {
    const agents = this.states.get(canvas) ?? new Map()
    this.states.set(canvas, agents)
    const places = this.places.get(canvas) ?? new Map()
    this.places.set(canvas, places)
    const before = agents.get(key) ?? {
      key, name, phase: 'thinking', action: null, text: null, seq: 0, at: places.get(key) ?? this.home(canvas, key), ids: [],
    }
    const next = { ...before, ...patch }
    if (patch.action || patch.text) next.seq = before.seq + 1
    if (patch.at) places.set(key, patch.at)
    agents.set(key, next)
    this.publish(canvas)
  }

  /** The turn ended: shown once as idle, then gone until the agent works again. */
  finish(canvas, key) {
    const agents = this.states.get(canvas)
    const state = agents?.get(key)
    if (!state) return
    agents.set(key, { ...state, phase: 'idle', ids: [] })
    this.publish(canvas)
    agents.delete(key)
  }

  /** Where an agent starts before it has touched anything: inside a box it holds or owns. */
  home(canvas, key) {
    const frame = canvas.boxes().find(item => {
      const { owner, lock } = boxInfo(item)
      return [lock, owner].some(agent => agent && agent !== 'user' && keyOf(agent) === key)
    })
    return frame ? insideBox(frame) : null
  }

  publish(canvas) {
    const agents = this.snapshot(canvas)
    for (const listener of this.listeners.get(canvas) ?? []) listener(agents)
  }
}
