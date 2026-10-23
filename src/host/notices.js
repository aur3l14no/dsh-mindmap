// What the user changed near an agent's work. The user steers agents in the
// chat; what the user draws is theirs. So nobody is woken or interrupted for it:
// an agent hears of the user's changes in or beside its own boxes the next time
// it uses a canvas tool, so that it keeps them and can judge whether they are meant for it.
import { boxInfo, elementBounds, frameBox, isBox, lockHolder, sameAgent, touchesBox } from '../shared/scene.js'

// Something this close to a box, or an arrow ending this close to it, is beside it (scene units).
const NEAR = 120
const MAX_LOG = 500
const MAX_LISTED = 12

const keyOf = writer => `${writer.lead}/${writer.name}`

const gap = (a, b) => Math.hypot(Math.max(0, a.x1 - b.x2, b.x1 - a.x2), Math.max(0, a.y1 - b.y2, b.y1 - a.y2))

/** Where an element marks: an arrow or line by its two ends, anything else by its bounds. */
function marks(element) {
  if (!['arrow', 'line'].includes(element.type) || !Array.isArray(element.points) || element.points.length === 0) return [elementBounds(element)]
  return [element.points[0], element.points.at(-1)].map(([px, py]) => ({ x1: element.x + px, y1: element.y + py, x2: element.x + px, y2: element.y + py }))
}

function kindOf(element) {
  if (isBox(element) || element.type === 'frame') return 'box'
  if (element.type === 'text') return element.containerId ? 'label' : 'note'
  if (element.type === 'freedraw') return 'drawing'
  return element.type
}

/** Whether `element` lies in, crosses or sits beside `frame`. */
function besideBox(element, frame) {
  if (element.id === frame.id || touchesBox(element, frame)) return true
  const box = frameBox(frame)
  return marks(element).some(mark => gap(mark, box) <= NEAR)
}

/**
 * The line telling `writer` what the user changed in or beside its boxes among `ids`, or null.
 * Its boxes are those locked to it or owned by it.
 */
export function describeUserEdits(canvas, writer, ids) {
  const own = canvas.boxes().filter(frame => sameAgent(lockHolder(frame), writer) || sameAgent(boxInfo(frame).owner, writer))
  if (own.length === 0) return null
  const changed = []
  const removed = []
  const near = new Set()
  for (const id of ids) {
    const element = canvas.elements.get(id)
    if (!element) continue
    // A box the user draws or changes beside yours is another agent's work, and that agent hears of it.
    if (element.type === 'frame' && !own.some(frame => frame.id === id)) continue
    const frames = own.filter(frame => besideBox(element, frame))
    if (frames.length === 0) continue
    for (const frame of frames) near.add(boxInfo(frame).name)
    const label = element.id === frames[0].id ? `the box "${boxInfo(frames[0]).name}" itself` : `${kindOf(element)} "${id}"`
    ;(element.isDeleted ? removed : changed).push(label)
  }
  if (changed.length + removed.length === 0) return null
  const list = items => items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more` : items.join(', ')
  const parts = [changed.length > 0 ? list(changed) : null, removed.length > 0 ? `removed ${list(removed)}` : null].filter(Boolean)
  const boxes = [...near].map(name => `"${name}"`).join(', ')
  return `Since you last looked, the user changed what lies in or beside your box ${boxes}: ${parts.join('; ')}. `
    + 'It is theirs: keep it, and follow it only if it is meant for you.'
}

export class UserEdits {
  constructor() {
    // Canvas → `[{ rev, ids }]` of changes the canvas UI sent, oldest first.
    this.logs = new WeakMap()
    // Canvas → Team key → the canvas revision the agent last saw.
    this.seen = new WeakMap()
  }

  /** Record the user's changes on `canvas`. */
  watch(canvas) {
    canvas.on('change', ({ elements, origin, rev }) => {
      if (!String(origin).startsWith('client:') || elements.length === 0) return
      const log = this.logs.get(canvas) ?? []
      log.push({ rev, ids: elements.map(element => element.id) })
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
      this.logs.set(canvas, log)
    })
  }

  /**
   * What the user changed in or beside `writer`'s boxes since its last canvas tool call, or null;
   * the first call only marks where the agent starts.
   */
  since(canvas, writer) {
    const seen = this.seen.get(canvas) ?? new Map()
    this.seen.set(canvas, seen)
    const key = keyOf(writer)
    const last = seen.get(key)
    seen.set(key, canvas.rev)
    if (last === undefined) return null
    const ids = new Set((this.logs.get(canvas) ?? []).filter(entry => entry.rev > last).flatMap(entry => entry.ids))
    return ids.size > 0 ? describeUserEdits(canvas, writer, [...ids]) : null
  }
}
