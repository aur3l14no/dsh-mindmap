// Excalidraw element normalization for programmatic writes, and the compact
// projection agents read. Field names and defaults follow Excalidraw 0.18;
// `label`, `start` and `end` are the conveniences of Excalidraw's own
// `convertToExcalidrawElements` skeleton API.
import { randomBytes, randomInt } from 'node:crypto'
import {
  BOUND_TEXT_PADDING, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, FONT_FAMILY, lineHeightOf,
} from '../shared/fonts.js'
import { MINDMAP_KEY, centerOf, edgePoint, elementBounds, round } from '../shared/scene.js'
import { measureText, wrapText } from './text.js'

export const DEFAULTS = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  roundness: null,
  link: null,
  locked: false,
}

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
const LINEAR = new Set(['line', 'arrow'])
export const WRITABLE_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'line', 'arrow', 'freedraw', 'frame', 'image']
const CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'arrow'])

const COMMON_FIELDS = ['x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth',
  'strokeStyle', 'roughness', 'opacity', 'roundness', 'groupIds', 'link', 'locked', 'customData', 'above', 'below']
const TYPE_FIELDS = {
  rectangle: ['label'],
  ellipse: ['label'],
  diamond: ['label'],
  text: ['text', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'lineHeight', 'autoResize'],
  line: ['points', 'startArrowhead', 'endArrowhead'],
  arrow: ['points', 'startArrowhead', 'endArrowhead', 'start', 'end', 'label', 'startBinding', 'endBinding'],
  freedraw: ['points', 'pressures', 'simulatePressure'],
  frame: ['name', 'lock'],
  image: ['fileId', 'status', 'scale', 'crop'],
}
// Inputs translated rather than copied: labels become bound text, ends become bindings,
// `above`/`below` become a drawing order and a frame's `lock` its box lock.
const CONVENIENCE_FIELDS = new Set(['label', 'start', 'end', 'startBinding', 'endBinding', 'above', 'below', 'lock'])
// Fields the Host owns. They may appear when an agent echoes a read back; they are ignored.
const MANAGED_FIELDS = new Set(['id', 'type', 'version', 'versionNonce', 'seed', 'index', 'updated', 'isDeleted',
  'boundElements', 'frameId', 'containerId', 'originalText', 'lastCommittedPoint', 'elbowed', 'baseline'])

const STROKE_STYLES = ['solid', 'dashed', 'dotted']
const FILL_STYLES = ['hachure', 'cross-hatch', 'solid', 'zigzag']
const ARROWHEADS = [null, 'arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline',
  'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']

export class ElementInputError extends Error {}

export function randomId() {
  return randomBytes(15).toString('base64url').slice(0, 20)
}

export function randomSeed() {
  return randomInt(1, 2 ** 31 - 1)
}

/** Return a new revision of `element` carrying `changes`. */
export function revise(element, changes = {}) {
  return {
    ...element,
    ...changes,
    version: (element.version ?? 0) + 1,
    versionNonce: randomSeed(),
    updated: Date.now(),
  }
}

function check(condition, message) {
  if (!condition) throw new ElementInputError(message)
}

function finite(value, name) {
  check(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number`)
  return value
}

function validateFields(input, type) {
  const allowed = new Set([...COMMON_FIELDS, ...(TYPE_FIELDS[type] ?? [])])
  const unknown = Object.keys(input).filter(key => !allowed.has(key) && !MANAGED_FIELDS.has(key))
  if (unknown.length > 0) {
    throw new ElementInputError(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map(key => `"${key}"`).join(', ')} for type "${type}"; accepted fields: ${[...allowed].join(', ')}`)
  }
}

function validateStyle(element) {
  for (const key of ['x', 'y', 'width', 'height', 'angle', 'strokeWidth', 'opacity', 'roughness']) {
    if (element[key] !== undefined) finite(element[key], key)
  }
  check(STROKE_STYLES.includes(element.strokeStyle), `strokeStyle must be one of ${STROKE_STYLES.join(', ')}`)
  check(FILL_STYLES.includes(element.fillStyle), `fillStyle must be one of ${FILL_STYLES.join(', ')}`)
  check(typeof element.strokeColor === 'string' && typeof element.backgroundColor === 'string',
    'strokeColor and backgroundColor are CSS color strings such as "#1e1e1e" or "transparent"')
  check(element.opacity >= 0 && element.opacity <= 100, 'opacity is 0-100')
  check(element.roundness === null || (typeof element.roundness === 'object' && [1, 2, 3].includes(element.roundness.type)),
    'roundness is null (sharp), {"type": 3} (rounded rectangle corners) or {"type": 2} (smooth line/arrow curves)')
  check(Array.isArray(element.groupIds) && element.groupIds.every(id => typeof id === 'string'), 'groupIds is an array of strings')
  if (element.customData !== undefined) {
    check(element.customData === null || (typeof element.customData === 'object' && !Array.isArray(element.customData)), 'customData must be an object')
  }
}

function normalizePoints(points, name = 'points') {
  check(Array.isArray(points) && points.length >= 2, `${name} needs at least two [x, y] pairs relative to the element's x/y`)
  return points.map((point, index) => {
    check(Array.isArray(point) && point.length === 2, `${name}[${index}] must be an [x, y] pair`)
    return [finite(point[0], `${name}[${index}][0]`), finite(point[1], `${name}[${index}][1]`)]
  })
}

/** A line, arrow or freedraw as agents see it: x/y its top-left corner and points relative to that. */
function cornerForm(element) {
  if (element.points.length === 0) return { x: element.x, y: element.y, points: [] }
  const left = Math.min(...element.points.map(point => point[0]))
  const top = Math.min(...element.points.map(point => point[1]))
  return { x: element.x + left, y: element.y + top, points: element.points.map(([px, py]) => [px - left, py - top]) }
}

/** Shift a linear element so its first point is [0, 0], as Excalidraw keeps it, and its size matches its points. */
function settlePoints(element) {
  const [ox, oy] = element.points[0]
  const points = element.points.map(([px, py]) => [round(px - ox), round(py - oy)])
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  return {
    ...element,
    x: round(element.x + ox),
    y: round(element.y + oy),
    points,
    width: round(Math.max(...xs) - Math.min(...xs)),
    height: round(Math.max(...ys) - Math.min(...ys)),
  }
}

function baseElement(type, input) {
  return {
    id: input.id ?? randomId(),
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    ...DEFAULTS,
    groupIds: [],
    frameId: null,
    index: null,
    seed: randomSeed(),
    version: 1,
    versionNonce: randomSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
  }
}

function assignFields(element, input, type) {
  const allowed = [...COMMON_FIELDS, ...(TYPE_FIELDS[type] ?? [])]
  const next = { ...element }
  for (const key of allowed) {
    if (input[key] === undefined || CONVENIENCE_FIELDS.has(key)) continue
    next[key] = input[key]
  }
  if (input.customData !== undefined) {
    // The mindmap namespace holds box owners and locks, which change only through "lock" and the canvas UI.
    const kept = element.customData?.[MINDMAP_KEY]
    const customData = { ...(input.customData ?? {}) }
    delete customData[MINDMAP_KEY]
    if (kept !== undefined) customData[MINDMAP_KEY] = kept
    next.customData = Object.keys(customData).length > 0 ? customData : undefined
  }
  return next
}

/** Lay out a text element: measure it, or wrap it inside its container. */
export function layoutText(text, container) {
  const lineHeight = text.lineHeight ?? lineHeightOf(text.fontFamily)
  let next = { ...text, lineHeight }
  if (container) {
    const maxWidth = boundTextMaxWidth(container)
    const wrapped = wrapText(next.originalText ?? next.text, next.fontFamily, next.fontSize, maxWidth)
    const metrics = measureText(wrapped, next.fontFamily, next.fontSize, lineHeight)
    next = { ...next, text: wrapped, width: metrics.width, height: metrics.height, angle: container.angle ?? 0 }
  } else if (next.autoResize === false) {
    const wrapped = wrapText(next.originalText ?? next.text, next.fontFamily, next.fontSize, next.width)
    next = { ...next, text: wrapped, height: measureText(wrapped, next.fontFamily, next.fontSize, lineHeight).height }
  } else {
    const metrics = measureText(next.text, next.fontFamily, next.fontSize, lineHeight)
    next = { ...next, width: metrics.width, height: metrics.height, originalText: next.text }
  }
  return next
}

function boundTextMaxWidth(container) {
  if (container.type === 'arrow') return Math.max(0.7 * Math.max(container.width, 1), 20 * 4.5)
  if (container.type === 'ellipse') return Math.round(container.width / 2 * Math.SQRT2) - BOUND_TEXT_PADDING * 2
  if (container.type === 'diamond') return Math.round(container.width / 2) - BOUND_TEXT_PADDING * 2
  return container.width - BOUND_TEXT_PADDING * 2
}

function boundTextMaxHeight(container) {
  if (container.type === 'ellipse') return Math.round(container.height / 2 * Math.SQRT2) - BOUND_TEXT_PADDING * 2
  if (container.type === 'diamond') return Math.round(container.height / 2) - BOUND_TEXT_PADDING * 2
  return container.height - BOUND_TEXT_PADDING * 2
}

function containerDimensionFor(dimension, type) {
  const padding = BOUND_TEXT_PADDING * 2
  dimension = Math.ceil(dimension)
  if (type === 'ellipse') return Math.round((dimension + padding) / Math.SQRT2 * 2)
  if (type === 'diamond') return 2 * (dimension + padding)
  return dimension + padding
}

/**
 * Fit a container around its bound text and center the text in it, as
 * Excalidraw's `redrawTextBoundingBox` does. Returns [container, text].
 */
export function fitBoundText(container, text) {
  let laidOut = layoutText(text, container)
  let box = container
  if (container.type !== 'arrow') {
    if (laidOut.height > boundTextMaxHeight(box)) box = { ...box, height: containerDimensionFor(laidOut.height, box.type) }
    if (laidOut.width > boundTextMaxWidth(box)) {
      box = { ...box, width: containerDimensionFor(laidOut.width, box.type) }
      laidOut = layoutText(text, box)
    }
    let offsetX = BOUND_TEXT_PADDING
    let offsetY = BOUND_TEXT_PADDING
    if (box.type === 'ellipse') {
      offsetX += box.width / 2 * (1 - Math.SQRT2 / 2)
      offsetY += box.height / 2 * (1 - Math.SQRT2 / 2)
    }
    if (box.type === 'diamond') {
      offsetX += box.width / 4
      offsetY += box.height / 4
    }
    const maxWidth = boundTextMaxWidth(box)
    const maxHeight = boundTextMaxHeight(box)
    const x = laidOut.textAlign === 'left' ? box.x + offsetX
      : laidOut.textAlign === 'right' ? box.x + offsetX + maxWidth - laidOut.width
        : box.x + offsetX + maxWidth / 2 - laidOut.width / 2
    const y = laidOut.verticalAlign === 'top' ? box.y + offsetY
      : laidOut.verticalAlign === 'bottom' ? box.y + offsetY + maxHeight - laidOut.height
        : box.y + offsetY + maxHeight / 2 - laidOut.height / 2
    laidOut = { ...laidOut, x: round(x), y: round(y) }
  } else {
    const middle = linearMidpoint(box)
    laidOut = { ...laidOut, x: round(middle[0] - laidOut.width / 2), y: round(middle[1] - laidOut.height / 2) }
  }
  return [box, laidOut]
}

function linearMidpoint(element) {
  const points = element.points
  if (points.length % 2 === 1) {
    const [px, py] = points[(points.length - 1) / 2]
    return [element.x + px, element.y + py]
  }
  const a = points[points.length / 2 - 1]
  const b = points[points.length / 2]
  return [element.x + (a[0] + b[0]) / 2, element.y + (a[1] + b[1]) / 2]
}

function textElementFrom(input, base) {
  check(typeof input.text === 'string', 'text elements need a "text" string')
  const fontFamily = input.fontFamily ?? base?.fontFamily ?? DEFAULT_FONT_FAMILY
  check(Object.values(FONT_FAMILY).includes(fontFamily), `fontFamily must be one of ${Object.entries(FONT_FAMILY).map(([name, id]) => `${id} (${name})`).join(', ')}`)
  const fontSize = finite(input.fontSize ?? base?.fontSize ?? DEFAULT_FONT_SIZE, 'fontSize')
  check(fontSize > 0, 'fontSize must be positive')
  const textAlign = input.textAlign ?? base?.textAlign ?? 'left'
  const verticalAlign = input.verticalAlign ?? base?.verticalAlign ?? 'top'
  check(['left', 'center', 'right'].includes(textAlign), 'textAlign is left, center or right')
  check(['top', 'middle', 'bottom'].includes(verticalAlign), 'verticalAlign is top, middle or bottom')
  return { text: input.text.replace(/\r\n?/g, '\n'), fontFamily, fontSize, textAlign, verticalAlign }
}

/**
 * Build new elements from one agent input. Returns the element followed by any
 * generated label text. `lookup(id)` resolves elements already in the scene or
 * created earlier in the same batch, for arrow bindings.
 */
export function createFromInput(input, lookup) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'each element must be an object')
  const type = input.type
  check(WRITABLE_TYPES.includes(type), `"type" must be one of ${WRITABLE_TYPES.join(', ')}`)
  validateFields(input, type)
  if (input.id !== undefined) check(typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.id), 'id must be 1-64 characters of A-Z a-z 0-9 _ -')
  let element = assignFields(baseElement(type, input), input, type)
  finite(element.x, 'x')
  finite(element.y, 'y')
  if (SHAPES.has(type) || type === 'frame' || type === 'image') {
    element.width = finite(input.width ?? 100, 'width')
    element.height = finite(input.height ?? 100, 'height')
    check(element.width > 0 && element.height > 0, 'width and height must be positive')
  }
  if (type === 'frame') {
    element = { ...element, name: typeof input.name === 'string' ? input.name : null, strokeColor: '#bbb', backgroundColor: 'transparent', roughness: 0, roundness: null }
  }
  if (type === 'image') {
    check(typeof input.fileId === 'string', 'image elements need the "fileId" of an image already in the canvas files')
    element = { ...element, status: 'saved', scale: input.scale ?? [1, 1], crop: input.crop ?? null }
  }
  if (type === 'text') {
    element = { ...element, ...textElementFrom(input), containerId: null, autoResize: input.autoResize ?? true }
    if (element.autoResize === false) element.width = finite(input.width ?? 200, 'width')
    element = layoutText({ ...element, originalText: element.text })
  }
  if (type === 'freedraw') {
    element = { ...element, points: normalizePoints(input.points), pressures: Array.isArray(input.pressures) ? input.pressures : [], simulatePressure: input.simulatePressure ?? true, lastCommittedPoint: null }
    element = settlePoints(element)
  }
  if (LINEAR.has(type)) {
    const points = input.points === undefined ? undefined : normalizePoints(input.points)
    element = {
      ...element,
      points: points ?? [[0, 0], [finite(input.width ?? 100, 'width'), finite(input.height ?? 0, 'height')]],
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: input.startArrowhead ?? null,
      endArrowhead: input.endArrowhead === undefined ? (type === 'arrow' ? 'arrow' : null) : input.endArrowhead,
    }
    if (type === 'arrow') element.elbowed = false
    check(ARROWHEADS.includes(element.startArrowhead) && ARROWHEADS.includes(element.endArrowhead),
      `arrowheads are one of ${ARROWHEADS.map(String).join(', ')}`)
    element = settlePoints(element)
    const { start, end } = arrowEnds(input)
    if (type === 'arrow' && (start !== undefined || end !== undefined)) {
      element = bindArrowEnds(element, start, end, lookup, points === undefined)
    }
  }
  validateStyle(element)
  const created = [element]
  if (input.label !== undefined) {
    check(CONTAINERS.has(type), `"label" is supported on ${[...CONTAINERS].join(', ')}`)
    const [container, text] = labelFor(element, input.label, null)
    created[0] = container
    created.push(text)
  }
  return created
}

/** Binding targets named by `start`/`end`, or by echoed `startBinding`/`endBinding`. */
export function arrowEnds(input) {
  return {
    start: input.start !== undefined ? input.start : input.startBinding === undefined ? undefined : input.startBinding && { id: input.startBinding.elementId },
    end: input.end !== undefined ? input.end : input.endBinding === undefined ? undefined : input.endBinding && { id: input.endBinding.elementId },
  }
}

function labelInput(label) {
  if (typeof label === 'string') return { text: label }
  check(label && typeof label === 'object' && typeof label.text === 'string', '"label" is a string or {"text", "fontSize"?, "fontFamily"?, "strokeColor"?, "textAlign"?, "verticalAlign"?}')
  return label
}

/** Create or replace the bound text of a container. Returns [container, text]. */
export function labelFor(container, label, existingText) {
  const input = labelInput(label)
  const props = textElementFrom({
    textAlign: 'center',
    verticalAlign: container.type === 'arrow' ? 'middle' : 'middle',
    ...input,
  }, existingText)
  const text = existingText
    ? { ...existingText, ...props, originalText: props.text, strokeColor: input.strokeColor ?? existingText.strokeColor }
    : {
        ...baseElement('text', {}),
        ...props,
        originalText: props.text,
        strokeColor: input.strokeColor ?? container.strokeColor,
        containerId: container.id,
        autoResize: true,
        lineHeight: lineHeightOf(props.fontFamily),
        frameId: container.frameId,
        groupIds: container.groupIds,
      }
  const bound = existingText
    ? container
    : { ...container, boundElements: [...(container.boundElements ?? []), { type: 'text', id: text.id }] }
  return fitBoundText(bound, text)
}

/** Attach arrow endpoints to elements, pointing along the line between their centers. */
export function bindArrowEnds(arrow, start, end, lookup, placePoints) {
  const targetOf = (ref, side) => {
    if (ref === undefined || ref === null) return null
    const id = typeof ref === 'string' ? ref : ref.id
    check(typeof id === 'string', `"${side}" is {"id": "<element id>"} naming the element this arrow ${side === 'start' ? 'leaves' : 'enters'}`)
    const target = lookup(id)
    check(target && !target.isDeleted, `"${side}" names element "${id}", which does not exist`)
    check(['rectangle', 'ellipse', 'diamond', 'text', 'image', 'frame'].includes(target.type) && !target.containerId,
      `"${side}" must name a rectangle, ellipse, diamond, frame, image or free text; "${id}" is a ${target.type}`)
    return target
  }
  const from = targetOf(start, 'start')
  const to = targetOf(end, 'end')
  let next = { ...arrow }
  const absolute = next.points.map(([px, py]) => [next.x + px, next.y + py])
  if (placePoints && (from || to)) {
    const fromCenter = from ? centerOf(from) : absolute[0]
    const toCenter = to ? centerOf(to) : absolute[absolute.length - 1]
    absolute[0] = from ? edgePoint(from, toCenter, 6) : fromCenter
    absolute[absolute.length - 1] = to ? edgePoint(to, fromCenter, 6) : toCenter
    if (absolute.length > 2) absolute.splice(1, absolute.length - 2)
  }
  next = settlePoints({ ...next, x: absolute[0][0], y: absolute[0][1], points: absolute.map(([px, py]) => [px - absolute[0][0], py - absolute[0][1]]) })
  if (from) next.startBinding = { elementId: from.id, focus: 0, gap: Math.max(1, gapTo(from, absolute[0])) }
  if (to) next.endBinding = { elementId: to.id, focus: 0, gap: Math.max(1, gapTo(to, absolute[absolute.length - 1])) }
  return next
}

function gapTo(element, point) {
  const box = elementBounds(element)
  const dx = Math.max(box.x1 - point[0], 0, point[0] - box.x2)
  const dy = Math.max(box.y1 - point[1], 0, point[1] - box.y2)
  return round(Math.hypot(dx, dy))
}

/**
 * Apply an agent patch to an existing element. Returns the patched element and
 * the label change to apply, if any. Managed fields and `type` stay unchanged.
 */
export function patchFromInput(existing, input) {
  check(input.type === undefined || input.type === existing.type, `element "${existing.id}" is a ${existing.type}; type cannot change (delete it and create a new element instead)`)
  validateFields(input, existing.type)
  let next = assignFields(existing, input, existing.type)
  if (existing.type === 'text') {
    const props = textElementFrom({ ...existing, ...input }, existing)
    next = { ...next, ...props }
    if (input.text !== undefined) next.originalText = props.text
    if (!existing.containerId) next = layoutText(next)
  }
  if ((LINEAR.has(existing.type) || existing.type === 'freedraw') && ['x', 'y', 'points'].some(key => input[key] !== undefined)) {
    // x/y and points mean what canvas_read shows: the top-left corner and offsets from it.
    const corner = cornerForm(existing)
    next = settlePoints({
      ...next,
      x: input.x === undefined ? corner.x : next.x,
      y: input.y === undefined ? corner.y : next.y,
      points: input.points === undefined ? corner.points : normalizePoints(input.points),
    })
  }
  if (existing.type === 'frame' && input.name !== undefined) next.name = input.name
  validateStyle(next)
  if (input.label !== undefined) check(CONTAINERS.has(existing.type), `"label" is supported on ${[...CONTAINERS].join(', ')}`)
  return { element: next, label: input.label }
}

const ROUND_KEYS = ['x', 'y', 'width', 'height']

/**
 * Compact projection of one element for agents: defaults and Host-managed
 * fields are omitted, bound text is folded into its container's `label`, and
 * arrow bindings appear as `start`/`end`. The result is valid canvas_write input.
 */
export function compactElement(element, elementsById) {
  const out = { id: element.id, type: element.type }
  for (const key of ROUND_KEYS) out[key] = round(element[key] ?? 0)
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (element[key] === undefined) continue
    if (JSON.stringify(element[key]) !== JSON.stringify(value)) out[key] = element[key]
  }
  if (element.groupIds?.length) out.groupIds = element.groupIds
  if (element.type === 'frame') {
    out.name = element.name ?? null
    delete out.strokeColor
    delete out.roughness
  }
  if (element.type === 'text') {
    out.text = element.originalText ?? element.text
    if (element.fontSize !== DEFAULT_FONT_SIZE) out.fontSize = element.fontSize
    if (element.fontFamily !== DEFAULT_FONT_FAMILY) out.fontFamily = element.fontFamily
    if (element.textAlign !== 'left') out.textAlign = element.textAlign
    if (element.verticalAlign !== 'top') out.verticalAlign = element.verticalAlign
    if (element.autoResize === false) out.autoResize = false
  }
  if (Array.isArray(element.points) && (LINEAR.has(element.type) || element.type === 'freedraw')) {
    const corner = cornerForm(element)
    out.x = round(corner.x)
    out.y = round(corner.y)
    out.points = corner.points.map(([px, py]) => [round(px), round(py)])
    delete out.width
    delete out.height
  }
  if (LINEAR.has(element.type)) {
    const defaultEnd = element.type === 'arrow' ? 'arrow' : null
    if ((element.startArrowhead ?? null) !== null) out.startArrowhead = element.startArrowhead
    if ((element.endArrowhead ?? null) !== defaultEnd) out.endArrowhead = element.endArrowhead ?? null
    if (element.startBinding?.elementId) out.start = { id: element.startBinding.elementId }
    if (element.endBinding?.elementId) out.end = { id: element.endBinding.elementId }
  }
  if (element.type === 'image') {
    out.fileId = element.fileId
    if (element.scale && (element.scale[0] !== 1 || element.scale[1] !== 1)) out.scale = element.scale
  }
  const textId = element.boundElements?.find(bound => bound.type === 'text')?.id
  const text = textId ? elementsById.get(textId) : undefined
  if (text && !text.isDeleted) {
    const label = { text: text.originalText ?? text.text }
    if (text.fontSize !== DEFAULT_FONT_SIZE) label.fontSize = text.fontSize
    if (text.fontFamily !== DEFAULT_FONT_FAMILY) label.fontFamily = text.fontFamily
    if (text.strokeColor !== element.strokeColor) label.strokeColor = text.strokeColor
    if (text.textAlign !== 'center') label.textAlign = text.textAlign
    if (text.verticalAlign !== 'middle') label.verticalAlign = text.verticalAlign
    out.label = label
  }
  const customData = { ...(element.customData ?? {}) }
  delete customData[MINDMAP_KEY]
  if (Object.keys(customData).length > 0) out.customData = customData
  if (element.link) out.link = element.link
  return out
}
