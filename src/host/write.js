// Programmatic writes: one atomic batch of element creations, patches,
// restacking and deletions by one agent, checked against box locks before
// anything is stored. A box locked by someone else keeps the writer out of the
// box and out of everything lying in it; "lock" on a frame claims or lifts a
// lock. Nothing is applied when any check fails.
import {
  boxContains, boxInfo, boxesIntersect, boxToRect, containingFrame, elementBounds, frameBox, isBox, lockHolder,
  lockedAgainst, sameAgent,
} from '../shared/scene.js'
import {
  ElementInputError, arrowEnds, bindArrowEnds, createFromInput, fitBoundText, labelFor, patchFromInput,
} from './elements.js'
import { generateNKeysBetween } from 'fractional-indexing'
import { copyInputs, movePatches } from './groups.js'
import { boxLabel, describeAgent, lockData, lockRefusal, lockedBoxOf, mayUnlock } from './locks.js'

export class WriteRejected extends Error {
  constructor(problems, hint) {
    super(problems.join('\n'))
    this.problems = problems
    this.hint = hint
  }
}

const rectText = box => {
  const rect = boxToRect(box)
  return `x ${rect.x}, y ${rect.y}, ${rect.width}×${rect.height}`
}

/** Free room around `box` before it would touch an obstacle, per direction. */
export function roomAround(box, obstacles, gap = 10) {
  const room = { left: Infinity, right: Infinity, up: Infinity, down: Infinity }
  for (const obstacle of obstacles) {
    const overlapsRows = obstacle.y1 < box.y2 && box.y1 < obstacle.y2
    const overlapsColumns = obstacle.x1 < box.x2 && box.x1 < obstacle.x2
    if (overlapsRows && obstacle.x1 >= box.x2) room.right = Math.min(room.right, obstacle.x1 - box.x2 - gap)
    if (overlapsRows && obstacle.x2 <= box.x1) room.left = Math.min(room.left, box.x1 - obstacle.x2 - gap)
    if (overlapsColumns && obstacle.y1 >= box.y2) room.down = Math.min(room.down, obstacle.y1 - box.y2 - gap)
    if (overlapsColumns && obstacle.y2 <= box.y1) room.up = Math.min(room.up, box.y1 - obstacle.y2 - gap)
  }
  return room
}

function roomText(room) {
  return Object.entries(room)
    .map(([side, value]) => `${side} ${value === Infinity ? 'unlimited' : `${Math.max(0, Math.floor(value))}px`}`)
    .join(', ')
}

/** How far each box `writer` holds can grow before it meets a box locked against the writer. */
export function describeRoom(frames, writer) {
  const locked = frames.filter(frame => lockedAgainst(frame, writer)).map(frameBox)
  return frames.filter(frame => sameAgent(lockHolder(frame), writer))
    .map(frame => `your box "${boxInfo(frame).name}" (${rectText(frameBox(frame))}) can grow ${roomText(roomAround(frameBox(frame), locked))}`)
}

/**
 * Validate and prepare one batch.
 * @param canvas - target canvas.
 * @param writer - the agent writing: `{ name, lead, sessionId }`, named within the Agent Team led by `lead`.
 * @param request - `{ elements, move, copy, delete }` as received from the tool.
 * @returns `{ changes, report }`; `changes` are complete element states to commit.
 * @throws WriteRejected listing every problem.
 */
export function prepareWrite(canvas, writer, request) {
  const inputs = request.elements ?? []
  const deletions = request.delete ?? []
  const problems = []
  const working = new Map()
  const deletedIds = new Set()
  const createdIds = []
  const updatedIds = new Set()
  const warnings = []
  const absorbed = []

  const get = id => {
    if (working.has(id)) return working.get(id)
    return canvas.get(id)
  }
  const label = (element, index) => `elements[${index}]${element?.id ? ` (id "${element.id}")` : ''}`
  const boxesNow = () => [...new Set([...canvas.boxes().map(frame => frame.id), ...working.keys()])].map(get).filter(isBox)

  // Whether this writer may change an existing element as it stands.
  const refuseTouch = element => {
    if (isBox(element)) return lockedAgainst(element, writer) ? lockRefusal(canvas, element, writer) : undefined
    const frame = lockedBoxOf(element, boxesNow(), writer)
    return frame ? lockRefusal(canvas, frame, writer, `"${element.id}" lies in ${boxLabel(frame)} at ${rectText(frameBox(frame))}, which`) : undefined
  }

  const moveWith = (element, dx, dy) => {
    const moved = { ...element, x: element.x + dx, y: element.y + dy }
    working.set(moved.id, moved)
    updatedIds.add(moved.id)
    return moved
  }

  // Keep bound text and arrow ends attached when a shape moves or resizes.
  const settleAttachments = (before, after) => {
    const textId = after.boundElements?.find(bound => bound.type === 'text')?.id
    const text = textId ? get(textId) : undefined
    if (text && !deletedIds.has(text.id)) {
      const [container, fitted] = fitBoundText(after, text)
      working.set(container.id, container)
      working.set(fitted.id, fitted)
      updatedIds.add(fitted.id)
      after = container
    }
    if (after.type === 'arrow' || after.type === 'line') return after
    const dx = after.x + after.width / 2 - (before.x + before.width / 2)
    const dy = after.y + after.height / 2 - (before.y + before.height / 2)
    if (dx === 0 && dy === 0) return after
    for (const bound of after.boundElements ?? []) {
      if (bound.type !== 'arrow' || deletedIds.has(bound.id)) continue
      const arrow = get(bound.id)
      if (!arrow || refuseTouch(arrow)) continue
      const points = arrow.points.map(point => [...point])
      let { x, y } = arrow
      if (arrow.startBinding?.elementId === after.id) {
        x += dx
        y += dy
        for (let index = 1; index < points.length; index += 1) {
          points[index][0] -= dx
          points[index][1] -= dy
        }
      }
      if (arrow.endBinding?.elementId === after.id) {
        points[points.length - 1][0] += dx
        points[points.length - 1][1] += dy
      }
      working.set(arrow.id, { ...arrow, x, y, points })
      updatedIds.add(arrow.id)
    }
    return after
  }

  const linkArrow = (arrow, previous) => {
    for (const side of ['startBinding', 'endBinding']) {
      const before = previous?.[side]?.elementId
      const after = arrow[side]?.elementId
      if (before === after) continue
      if (before) {
        const target = get(before)
        if (target) working.set(target.id, { ...target, boundElements: (target.boundElements ?? []).filter(bound => bound.id !== arrow.id) })
      }
      if (after) {
        const target = get(after)
        const refusal = refuseTouch(target)
        if (refusal) throw new ElementInputError(`cannot attach to "${target.id}": ${refusal}`)
        const others = (target.boundElements ?? []).filter(bound => bound.id !== arrow.id)
        working.set(target.id, { ...target, boundElements: [...others, { type: 'arrow', id: arrow.id }] })
        updatedIds.add(target.id)
      }
    }
  }

  // A frame's "lock": claim it for the writer (or give it back to its owner), or lift it.
  const applyLock = (frame, lock, before) => {
    if (lock === undefined) return frame
    if (typeof lock !== 'boolean') throw new ElementInputError('"lock" is true to lock the box to you or false to unlock it')
    if (!lock && before && !mayUnlock(canvas, before, writer)) throw new ElementInputError(lockRefusal(canvas, before, writer))
    const data = lockData(canvas, frame, lock, writer)
    if (data.lock && !sameAgent(data.lock, writer)) warnings.push(`${boxLabel(frame)} is locked to its owner, ${describeAgent(canvas, data.lock, writer)}, again`)
    const customData = { ...(frame.customData ?? {}) }
    customData.mindmap = { ...(customData.mindmap ?? {}), ...data }
    return { ...frame, customData }
  }

  // 1. Deletions, with the bound text of a deleted container and the members of a deleted box.
  for (const id of deletions) {
    const element = canvas.get(id)
    if (!element) {
      problems.push(`delete: no element "${id}" on this canvas`)
      continue
    }
    const doomed = [element]
    if (isBox(element)) doomed.push(...canvas.ordered().filter(member => member.frameId === id))
    for (const target of [...doomed]) {
      const textId = target.boundElements?.find(bound => bound.type === 'text')?.id
      if (textId && canvas.get(textId)) doomed.push(canvas.get(textId))
    }
    const refusal = doomed.map(refuseTouch).find(Boolean)
    if (refusal) {
      problems.push(`delete "${id}": ${refusal}`)
      continue
    }
    for (const target of doomed) {
      deletedIds.add(target.id)
      working.set(target.id, { ...target, isDeleted: true })
    }
    if (element.containerId) {
      const container = get(element.containerId)
      if (container) working.set(container.id, { ...container, boundElements: (container.boundElements ?? []).filter(bound => bound.id !== id) })
    }
  }

  // 2. Patches to existing elements, then creations (frames, shapes, then arrows that may bind to them).
  // Moves are patches and copies are creations, each named after its request.
  const seen = new Set()
  const creations = []
  const stacking = []
  const entries = inputs.map((input, index) => ({ input, index, name: label(input, index) }))
  let copies = []
  const group = (key, shape, expand) => {
    if (request[key] === undefined) return
    try {
      if (!Array.isArray(request[key])) throw new ElementInputError(`"${key}" is a list of ${shape}`)
      expand(request[key])
    } catch (error) {
      if (!(error instanceof ElementInputError)) throw error
      problems.push(error.message)
    }
  }
  group('move', '{"ids", "x", "y", "scale", "angle"}', moves => {
    for (const input of movePatches(canvas, moves)) entries.push({ input, index: inputs.length, name: `move "${input.id}"` })
  })
  group('copy', '{"ids", "x", "y"}', requested => {
    const copied = copyInputs(canvas, requested, new Set(inputs.map(input => input?.id).filter(id => typeof id === 'string')))
    copies = copied.copies
    for (const input of copied.inputs) creations.push({ input, index: inputs.length, name: `copy "${input.id}"` })
  })
  for (const { input, index, name } of entries) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      problems.push(`${name}: each element must be an object`)
      continue
    }
    if (input.id !== undefined && seen.has(input.id)) {
      problems.push(`${name}: "${input.id}" is written more than once in this batch`)
      continue
    }
    if (input.id !== undefined) seen.add(input.id)
    const existing = input.id === undefined ? undefined : get(input.id)
    if (!existing || existing.isDeleted) {
      creations.push({ input, index, name })
      continue
    }
    if (deletedIds.has(existing.id)) {
      problems.push(`${name}: also listed in "delete"`)
      continue
    }
    // The lead may lift a teammate's lock: a patch of just {"id", "lock": false}.
    const unlocking = isBox(existing) && input.lock === false
      && Object.keys(input).every(key => ['id', 'type', 'lock'].includes(key)) && mayUnlock(canvas, existing, writer)
    const refusal = unlocking ? undefined : refuseTouch(existing)
    if (refusal) {
      // Ids are shared by the whole canvas, so a new element may name one that someone else drew.
      const taken = input.type === undefined ? '' : ` (the id "${existing.id}" is taken by an existing ${existing.type}; give a new element another id)`
      problems.push(`${name}: ${refusal}${taken}`)
      continue
    }
    try {
      if (input.lock !== undefined && existing.type !== 'frame') throw new ElementInputError('"lock" is a field of boxes (frames)')
      const { element, label: newLabel } = patchFromInput(existing, input)
      let next = isBox(existing) ? applyLock(element, input.lock, existing) : element
      // As in Excalidraw, dragging a box carries what it holds, and resizing one leaves it in place.
      const resized = next.width !== existing.width || next.height !== existing.height
      if (isBox(existing) && !resized && (next.x !== existing.x || next.y !== existing.y)) {
        for (const member of canvas.ordered().filter(item => item.frameId === existing.id)) {
          moveWith(get(member.id), next.x - existing.x, next.y - existing.y)
        }
      }
      if (newLabel !== undefined) {
        const textId = next.boundElements?.find(bound => bound.type === 'text')?.id
        const [container, text] = labelFor(next, newLabel, textId ? get(textId) : null)
        next = container
        working.set(text.id, text)
        if (!textId) createdIds.push(text.id)
        else updatedIds.add(text.id)
      }
      if (existing.type === 'arrow') {
        const { start, end } = arrowEnds(input)
        if (start !== undefined || end !== undefined) {
          next = bindArrowEnds(next, start === undefined ? (next.startBinding ? { id: next.startBinding.elementId } : null) : start,
            end === undefined ? (next.endBinding ? { id: next.endBinding.elementId } : null) : end, get, input.points === undefined)
          if (start === null) next.startBinding = null
          if (end === null) next.endBinding = null
        }
        linkArrow(next, existing)
      }
      if (existing.type === 'text' && existing.containerId && get(existing.containerId)) {
        const [container, text] = fitBoundText(get(existing.containerId), next)
        working.set(container.id, container)
        next = text
      }
      working.set(next.id, next)
      updatedIds.add(next.id)
      if (existing.type !== 'text') settleAttachments(existing, next)
      if (input.above !== undefined || input.below !== undefined) stacking.push({ id: next.id, input, index, name })
    } catch (error) {
      if (!(error instanceof ElementInputError)) throw error
      problems.push(`${name}: ${error.message}`)
    }
  }
  const rank = ({ input }) => input.type === 'frame' ? 0 : input.type === 'arrow' ? 2 : 1
  creations.sort((a, b) => rank(a) - rank(b) || a.index - b.index)
  for (const { input, index, name } of creations) {
    try {
      if (input.lock !== undefined && input.type !== 'frame') throw new ElementInputError('"lock" is a field of boxes (frames)')
      const made = createFromInput(input, get)
      if (made[0].type === 'frame') made[0] = applyLock(made[0], input.lock)
      const tombstone = canvas.elements.get(made[0].id)
      if (tombstone) made[0] = { ...made[0], version: tombstone.version + 1 }
      for (const element of made) {
        working.set(element.id, element)
        createdIds.push(element.id)
      }
      if (made[0].type === 'arrow') linkArrow(made[0], null)
      if (input.above !== undefined || input.below !== undefined) stacking.push({ id: made[0].id, input, index, name })
    } catch (error) {
      if (!(error instanceof ElementInputError)) throw error
      problems.push(`${name}: ${error.message}`)
    }
  }
  for (const request of stacking) {
    const problem = stackingProblem(get, request)
    if (problem) problems.push(`${request.name}: ${problem}`)
  }
  if (problems.length > 0) throw new WriteRejected(problems)

  // 3. Box membership of everything touched.
  const frames = boxesNow()
  for (const element of working.values()) {
    if (element.isDeleted || isBox(element)) continue
    let frameId = element.frameId
    if (element.containerId) {
      frameId = get(element.containerId)?.frameId ?? null
    } else {
      const box = elementBounds(element)
      const inside = containingFrame(frames, box)
      if (inside) frameId = inside.id
      else if (frameId && !boxesIntersect(frameBox(get(frameId) ?? { x: 0, y: 0, width: 0, height: 0 }), box)) frameId = null
    }
    if (frameId !== element.frameId) working.set(element.id, { ...element, frameId })
  }
  for (const element of working.values()) {
    if (element.containerId && !element.isDeleted) {
      const container = get(element.containerId)
      if (container && container.frameId !== element.frameId) working.set(element.id, { ...element, frameId: container.frameId })
    }
  }

  // Free elements a written box now fully covers join it, as when a frame is drawn around them.
  for (const frame of [...working.values()].filter(isBox)) {
    const box = frameBox(frame)
    for (const element of canvas.ordered()) {
      if (element.frameId || isBox(element) || working.has(element.id) || element.containerId) continue
      if (boxContains(box, elementBounds(element))) {
        if (lockedBoxOf(element, frames, writer)) continue
        working.set(element.id, { ...element, frameId: frame.id })
        absorbed.push(element.id)
        const textId = element.boundElements?.find(bound => bound.type === 'text')?.id
        if (textId && canvas.get(textId)) working.set(textId, { ...canvas.get(textId), frameId: frame.id })
      } else if (boxesIntersect(box, elementBounds(element))) {
        warnings.push(`free element "${element.id}" partly overlaps ${boxLabel(frame)} and is not part of it`)
      }
    }
  }

  // 4. Nothing written may lie in a box locked against the writer.
  for (const element of working.values()) {
    if (element.isDeleted || isBox(element)) continue
    const frame = lockedBoxOf(element, frames, writer)
    if (frame) problems.push(lockRefusal(canvas, frame, writer, `"${element.id}" at ${rectText(elementBounds(element))} would lie in ${boxLabel(frame)} at ${rectText(frameBox(frame))}, which`))
  }
  if (problems.length > 0) {
    const room = describeRoom(frames, writer)
    throw new WriteRejected(problems, `Place the content clear of locked boxes.${room.length > 0 ? ` Before meeting a box locked by someone else, ${room.join('; ')}.` : ''}`)
  }
  for (const element of working.values()) {
    if (element.isDeleted || isBox(element) || element.containerId || deletedIds.has(element.id)) continue
    const held = frames.find(frame => sameAgent(lockHolder(frame), writer) && element.frameId !== frame.id
      && boxesIntersect(frameBox(frame), elementBounds(element)))
    if (held) warnings.push(`"${element.id}" sticks out of your ${boxLabel(held)} and is not part of it, so the lock does not cover it; move it inside or resize the box`)
  }
  for (const frame of [...working.values()].filter(element => isBox(element) && sameAgent(lockHolder(element), writer))) {
    for (const other of frames.filter(item => item.id !== frame.id && lockHolder(item) && !sameAgent(lockHolder(item), writer))) {
      if (!boxesIntersect(frameBox(frame), frameBox(other))) continue
      warnings.push(`your ${boxLabel(frame)} overlaps ${boxLabel(other)}, locked by ${describeAgent(canvas, lockHolder(other), writer)}; what lies in the overlap stays locked to both of you, so agree who gives way`)
    }
  }

  // 5. Drawing order: new elements go on top unless stacked above or below another element.
  const createdSet = new Set(createdIds)
  for (const [id, index] of drawingKeys(canvas, get, createdIds, stacking)) {
    const element = get(id)
    working.set(id, { ...element, index })
    if (!createdSet.has(id) && !element.containerId) updatedIds.add(id)
  }

  // 6. Final element revisions.
  const changes = []
  for (const element of working.values()) {
    const before = canvas.elements.get(element.id)
    if (createdSet.has(element.id)) {
      changes.push({ ...element, version: Math.max(element.version ?? 1, (before?.version ?? 0) + 1), updated: Date.now() })
      continue
    }
    if (!before || JSON.stringify(before) === JSON.stringify(element)) continue
    changes.push({ ...element, version: before.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() })
  }
  return {
    changes,
    report: {
      created: createdIds,
      updated: [...updatedIds].filter(id => !createdSet.has(id) && !deletedIds.has(id)),
      deleted: [...deletedIds],
      absorbed,
      copies,
      warnings,
    },
  }
}

/** Why an `above`/`below` request cannot be honoured, if it cannot. */
function stackingProblem(get, { id, input }) {
  if (input.above !== undefined && input.below !== undefined) return 'give "above" or "below", not both'
  const where = input.above !== undefined ? 'above' : 'below'
  const element = get(id)
  const target = typeof input[where] === 'string' ? get(input[where]) : undefined
  if (!target || target.isDeleted) return `"${where}" names element ${JSON.stringify(input[where])}, which does not exist`
  if (target.id === id || target.containerId === id) return `an element cannot be stacked ${where} itself`
  if (isBox(element) || isBox(target)) return 'boxes (frames) stay behind their elements and are not stacked'
  if (element.containerId) return 'a label is drawn with its container; stack the container instead'
  return undefined
}

/**
 * Fractional `index` keys for created elements (on top, in creation order) and
 * for elements stacked above or below another; a container's label moves with it.
 * @returns Map from element id to its new key.
 */
function drawingKeys(canvas, get, createdIds, stacking) {
  const created = new Set(createdIds)
  const withLabel = id => {
    const textId = get(id)?.boundElements?.find(bound => bound.type === 'text')?.id
    return textId && get(textId) ? [id, textId] : [id]
  }
  // Deleted elements keep their keys, so new keys are placed among them too.
  let order = [...canvas.ordered(true).map(element => element.id).filter(id => !created.has(id)), ...createdIds]
  const moved = new Set(createdIds)
  // Requests apply in the order the batch lists them.
  for (const { id, input } of [...stacking].sort((a, b) => a.index - b.index)) {
    const group = withLabel(id)
    order = order.filter(item => !group.includes(item))
    const targetId = get(input.above ?? input.below).containerId ?? (input.above ?? input.below)
    const at = input.above !== undefined ? order.indexOf(withLabel(targetId).at(-1)) + 1 : order.indexOf(targetId)
    order.splice(at, 0, ...group)
    for (const item of group) moved.add(item)
  }
  const keys = new Map()
  for (let start = 0; start < order.length;) {
    if (!moved.has(order[start])) {
      start += 1
      continue
    }
    let end = start
    while (end < order.length && moved.has(order[end])) end += 1
    const before = start > 0 ? canvas.elements.get(order[start - 1]).index : null
    const after = end < order.length ? canvas.elements.get(order[end]).index : null
    generateNKeysBetween(before, after, end - start).forEach((key, offset) => keys.set(order[start + offset], key))
    start = end
  }
  return keys
}
