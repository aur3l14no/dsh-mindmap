// What agents read and see of a canvas: a compact JSON projection and a PNG
// rendering of the whole canvas, one box or chosen elements.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boxInfo, boxToRect, elementBounds, frameBox, isBox, lockHolder, unionBox } from '../shared/scene.js'
import { MindmapError } from './canvases.js'
import { compactElement } from './elements.js'
import { describeAgent } from './locks.js'
import { renderScene } from './render.js'

const MAX_READ_CHARS = 60_000
const MAX_SCALE = 8

/**
 * Resolve what a read or view covers.
 * @param scope - `undefined`/`"canvas"`, or a box id or name.
 * @param ids - explicit element ids; wins over `scope`.
 * @returns `{ label, box?, ids? }`; `ids` is undefined for the whole canvas.
 */
export function resolveScope(canvas, { scope, ids } = {}) {
  if (Array.isArray(ids) && ids.length > 0) {
    const missing = ids.filter(id => !canvas.get(id))
    if (missing.length > 0) throw new MindmapError(`no element${missing.length > 1 ? 's' : ''} ${missing.map(id => `"${id}"`).join(', ')} on canvas "${canvas.name}"`)
    return { label: `${ids.length} element${ids.length > 1 ? 's' : ''}`, ids }
  }
  if (scope === undefined || scope === null || scope === '' || scope === 'canvas') return { label: 'whole canvas' }
  const frames = canvas.boxes()
  const box = frames.find(frame => frame.id === scope) ?? frames.find(frame => boxInfo(frame).name === scope)
  if (!box) {
    throw new MindmapError(`no box "${scope}" on canvas "${canvas.name}"; boxes: ${frames.map(frame => `"${boxInfo(frame).name}" (${frame.id})`).join(', ') || 'none'}`)
  }
  return { label: `box "${boxInfo(box).name}"`, box, ids: [box.id, ...canvas.ordered().filter(element => element.frameId === box.id).map(element => element.id)] }
}

function boxSummary(canvas, frame, viewer) {
  const { name, owner } = boxInfo(frame)
  const out = { id: frame.id, name, ...boxToRect(frameBox(frame)) }
  if (owner) out.owner = describeAgent(canvas, owner, viewer)
  const holder = lockHolder(frame)
  if (holder) out.lockedBy = describeAgent(canvas, holder, viewer)
  return out
}

/**
 * The JSON an agent reads: boxes with their owner and lock, and elements in
 * compact Excalidraw form grouped by box. Elements of the scope are listed in z-order.
 * @param viewer - the reading agent, so owners and locks read as "you" where they are its own.
 */
export function readCanvas(canvas, viewer, target) {
  const wanted = target.ids ? new Set(target.ids) : null
  const elements = canvas.ordered().filter(element => !element.containerId)
  const byFrame = new Map()
  const free = []
  for (const element of elements) {
    if (isBox(element) || (wanted && !wanted.has(element.id))) continue
    const compact = compactElement(element, canvas.elements)
    if (element.frameId && canvas.get(element.frameId)) {
      if (!byFrame.has(element.frameId)) byFrame.set(element.frameId, [])
      byFrame.get(element.frameId).push(compact)
    } else {
      free.push(compact)
    }
  }
  const boxes = canvas.boxes().map(frame => {
    const summary = boxSummary(canvas, frame, viewer)
    const members = canvas.ordered().filter(element => element.frameId === frame.id && !element.containerId).length
    if (byFrame.has(frame.id)) summary.elements = byFrame.get(frame.id)
    else summary.elementCount = members
    return summary
  })
  const result = { canvas: canvas.name, scope: target.label, boxes }
  if (free.length > 0) result.elements = free
  return boundRead(result)
}

/** Drop elements from the end until the JSON fits, and say how to read the rest. */
function boundRead(result) {
  let size = JSON.stringify(result).length
  if (size <= MAX_READ_CHARS) return result
  const lists = [...result.boxes, result].map(owner => owner.elements).filter(list => list?.length > 0)
  let dropped = 0
  for (const list of lists.reverse()) {
    while (list.length > 0 && size > MAX_READ_CHARS) {
      size -= JSON.stringify(list.pop()).length + 1
      dropped += 1
    }
  }
  result.truncated = `${dropped} elements were left out to bound this result; read one box with "scope" or exact elements with "ids" to see them`
  return result
}

/**
 * Render a scope to PNG and save it under the canvas's `exports/` folder.
 * @returns `{ png, file, width, height, region, scale, label }`; `region` is in canvas units.
 */
export async function viewCanvas(canvas, target, { region, scale = 1, grid = false, fontFiles = [] } = {}) {
  let box = null
  if (region) {
    for (const key of ['x', 'y', 'width', 'height']) {
      if (typeof region[key] !== 'number' || !Number.isFinite(region[key])) throw new MindmapError('region is {"x", "y", "width", "height"} in canvas units')
    }
    if (region.width <= 0 || region.height <= 0) throw new MindmapError('region width and height must be positive')
    box = { x1: region.x, y1: region.y, x2: region.x + region.width, y2: region.y + region.height }
  } else if (target.box) {
    box = frameBox(target.box)
  } else if (target.ids) {
    box = unionBox(target.ids.map(id => canvas.get(id)).map(element => isBox(element) ? frameBox(element) : elementBounds(element)))
  }
  if (typeof scale !== 'number' || !(scale > 0) || scale > MAX_SCALE) throw new MindmapError(`scale is a number of pixels per canvas unit, above 0 and at most ${MAX_SCALE}`)
  const rendered = renderScene(canvas.snapshot(), {
    region: box ?? undefined,
    ids: region || target.box ? undefined : target.ids,
    scale,
    grid,
    fontFiles,
  })
  const dir = join(canvas.dir, 'exports')
  await mkdir(dir, { recursive: true })
  const slug = target.box ? `box-${boxInfo(target.box).name}` : target.ids ? 'elements' : 'canvas'
  const file = join(dir, `${slug.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.png`)
  await writeFile(file, rendered.png)
  return { ...rendered, file, label: target.label }
}

/** One line telling the viewer how image pixels map to canvas coordinates. */
export function describeView(view) {
  const x = Math.round(view.region.x1 * 100) / 100
  const y = Math.round(view.region.y1 * 100) / 100
  const scale = Math.round(view.scale * 1000) / 1000
  return `${view.width}×${view.height} px image of the ${view.label}; pixel (px, py) is canvas (${x} + px / ${scale}, ${y} + py / ${scale}). Saved as ${view.file}.`
}
