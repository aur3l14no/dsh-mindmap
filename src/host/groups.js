// Group requests of canvas_write: "copy" draws copies of existing elements and
// "move" rearranges elements in place. Either way a group is placed, scaled
// and turned as a whole, so an agent can reuse or assemble parts by their ids
// without working out each element's geometry.
import { elementBounds, isBox, unionBox } from '../shared/scene.js'
import { DEFAULT_FONT_SIZE } from '../shared/fonts.js'
import { ElementInputError, compactElement } from './elements.js'

const ID = /^[A-Za-z0-9_-]{1,64}$/
const PREFIX = /^[A-Za-z0-9_-]{0,32}$/
const MAX_SCALE = 10
const TURN = 2 * Math.PI

const round2 = value => Math.round(value * 100) / 100
const finite = value => typeof value === 'number' && Number.isFinite(value)

function turnAbout([px, py], [cx, cy], angle) {
  if (!angle) return [px, py]
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]
}

/** Scale a label's text size; a plain label becomes the object form. */
function scaleLabel(label, factor) {
  const object = typeof label === 'string' ? { text: label } : { ...label }
  object.fontSize = round2((object.fontSize ?? DEFAULT_FONT_SIZE) * factor)
  return object
}

/**
 * The elements of one request and where they go: scaled from the top-left of
 * their bounding box, which lands at x/y, then turned about the box's centre.
 * @param verb - "copy" or "move", for messages.
 */
function readGroup(canvas, request, where, verb) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.ids) || request.ids.length === 0) {
    throw new ElementInputError(`${where}: give "ids", the elements to ${verb}${verb === 'copy' ? ', with "x" and "y" where the copy goes' : ''}`)
  }
  for (const key of ['x', 'y']) {
    if (verb === 'move' && request[key] === undefined) continue
    if (!finite(request[key])) throw new ElementInputError(`${where}: "${key}" must be a number, the ${key === 'x' ? 'left' : 'top'} of the group`)
  }
  const factor = request.scale ?? 1
  if (!finite(factor) || !(factor > 0) || factor > MAX_SCALE) throw new ElementInputError(`${where}: "scale" is above 0 and at most ${MAX_SCALE}`)
  const turn = request.angle ?? 0
  if (!finite(turn)) throw new ElementInputError(`${where}: "angle" is a number of radians`)
  const wanted = new Set(request.ids)
  const sources = canvas.ordered().filter(element => wanted.has(element.id))
  const missing = [...wanted].filter(id => !sources.some(element => element.id === id))
  if (missing.length > 0) throw new ElementInputError(`${where}: no element ${missing.map(id => `"${id}"`).join(', ')} on this canvas`)
  for (const element of sources) {
    if (isBox(element)) {
      throw new ElementInputError(`${where}: "${element.id}" is a box; ${verb === 'copy' ? 'copy the elements in it instead' : 'move a box by changing its x and y in "elements", and what lies in it comes along'}`)
    }
    if (element.containerId) throw new ElementInputError(`${where}: "${element.id}" is the label of "${element.containerId}"; ${verb} its container, which brings the label along`)
  }
  const box = unionBox(sources.map(elementBounds))
  const left = request.x ?? box.x1
  const top = request.y ?? box.y1
  const centre = [left + (box.x2 - box.x1) * factor / 2, top + (box.y2 - box.y1) * factor / 2]
  const place = ([px, py]) => turnAbout([left + (px - box.x1) * factor, top + (py - box.y1) * factor], centre, turn)
  return { wanted, sources, factor, turn, place }
}

/** The geometry of `element` once its group is placed, as creation or patch fields. */
function placed(element, compact, { factor, turn, place }) {
  const out = {}
  if (compact.points) {
    // Every point is placed on its own, so lines, arrows and freehand strokes come out unturned.
    const xs = element.points.map(point => point[0])
    const ys = element.points.map(point => point[1])
    const centre = [element.x + (Math.min(...xs) + Math.max(...xs)) / 2, element.y + (Math.min(...ys) + Math.max(...ys)) / 2]
    const points = element.points.map(([px, py]) => place(turnAbout([element.x + px, element.y + py], centre, element.angle ?? 0)))
    const [ox, oy] = points[0]
    out.x = round2(ox)
    out.y = round2(oy)
    out.points = points.map(([px, py]) => [round2(px - ox), round2(py - oy)])
    if (element.angle) out.angle = 0
  } else {
    const [cx, cy] = place([element.x + element.width / 2, element.y + element.height / 2])
    out.x = round2(cx - element.width * factor / 2)
    out.y = round2(cy - element.height * factor / 2)
    if (element.type !== 'text' && factor !== 1) {
      out.width = round2(element.width * factor)
      out.height = round2(element.height * factor)
    }
    if (turn) out.angle = Math.round((((element.angle ?? 0) + turn) % TURN + TURN) % TURN * 10_000) / 10_000
  }
  if (factor !== 1 && element.type === 'text') {
    out.fontSize = round2((element.fontSize ?? DEFAULT_FONT_SIZE) * factor)
    if (element.autoResize === false) out.width = round2(element.width * factor)
  }
  if (factor !== 1 && compact.label !== undefined) out.label = scaleLabel(compact.label, factor)
  return out
}

/**
 * Creation inputs for each copy request.
 * @param copies - `[{ ids, x, y, scale?, angle?, prefix? }]` as given to canvas_write.
 * @param taken - ids already used by this batch.
 * @returns `{ inputs, copies }`: inputs in drawing order, and per request the prefix used and the copied count.
 * @throws ElementInputError naming the request at fault.
 */
export function copyInputs(canvas, copies, taken) {
  const inputs = []
  const done = []
  const used = id => taken.has(id) || canvas.get(id) !== undefined || inputs.some(input => input.id === id)
  copies.forEach((request, index) => {
    const where = `copy[${index}]`
    const group = readGroup(canvas, request, where, 'copy')
    let prefix = request.prefix
    if (prefix === undefined) {
      for (let n = 1; ; n += 1) {
        prefix = `c${n}-`
        if (!group.sources.some(element => used(prefix + element.id))) break
      }
    } else if (typeof prefix !== 'string' || !PREFIX.test(prefix)) {
      throw new ElementInputError(`${where}: "prefix" is up to 32 letters, digits, _ or -`)
    }
    for (const element of group.sources) {
      const input = compactElement(element, canvas.elements)
      input.id = prefix + element.id
      if (!ID.test(input.id)) throw new ElementInputError(`${where}: the copy of "${element.id}" would get id "${input.id}", longer than 64 characters; use a shorter "prefix"`)
      if (used(input.id)) throw new ElementInputError(`${where}: id "${input.id}" is taken; give another "prefix"`)
      Object.assign(input, placed(element, input, group))
      // Arrows stay attached to copied ends; an end outside the copy keeps only its geometry.
      for (const side of ['start', 'end']) {
        if (input[side] === undefined) continue
        if (group.wanted.has(input[side].id)) input[side] = { id: prefix + input[side].id }
        else delete input[side]
      }
      if (input.groupIds) input.groupIds = input.groupIds.map(id => prefix + id)
      inputs.push(input)
    }
    done.push({ prefix, count: group.sources.length })
  })
  return { inputs, copies: done }
}

/**
 * Patches that rearrange each group in place.
 * @param moves - `[{ ids, x?, y?, scale?, angle? }]` as given to canvas_write; x/y default to where the group is.
 * @returns patch inputs, lines and arrows last so they take the geometry given here, not that of the shapes they are attached to.
 * @throws ElementInputError naming the request at fault.
 */
export function movePatches(canvas, moves) {
  const patches = []
  const moved = new Set()
  moves.forEach((request, index) => {
    const where = `move[${index}]`
    const group = readGroup(canvas, request, where, 'move')
    for (const element of group.sources) {
      if (moved.has(element.id)) throw new ElementInputError(`${where}: "${element.id}" is already in an earlier move`)
      moved.add(element.id)
      const patch = { id: element.id, ...placed(element, compactElement(element, canvas.elements), group) }
      // An arrow end attached outside the group comes loose rather than stretching back to it.
      if (element.startBinding && !group.wanted.has(element.startBinding.elementId)) patch.start = null
      if (element.endBinding && !group.wanted.has(element.endBinding.elementId)) patch.end = null
      patches.push(patch)
    }
  })
  return [...patches.filter(patch => !patch.points), ...patches.filter(patch => patch.points)]
}
