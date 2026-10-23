// Host-side image export: Excalidraw elements drawn as SVG with the same
// rough.js shapes and fonts as the browser, rasterized to PNG by resvg. It
// needs no browser, so agents can look at a canvas while its page is closed.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { getStroke } from 'perfect-freehand'
import rough from 'roughjs'
import { lineHeightOf, verticalOffset } from '../shared/fonts.js'
import { lineWidth } from './text.js'
import { boxInfo, boxesIntersect, elementBounds, frameBox, isBox, lockHolder, unionBox } from '../shared/scene.js'

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url))
const BUNDLED_FONTS = readdirSync(FONT_DIR).filter(name => name.endsWith('.otf')).map(name => FONT_DIR + name)
const FAMILY_NAMES = {
  1: 'Virgil', 2: 'Liberation Sans', 3: 'Cascadia', 5: 'Excalifont', 6: 'Nunito', 7: 'Lilita One', 8: 'Comic Shanns', 9: 'Liberation Sans',
}
// Excalidraw draws CJK in Excalifont text with Xiaolai, whose subsets a render loads as it
// needs them. Other families fall back to the browser's system fonts; the Host uses an
// installed CJK face for those, and for characters Xiaolai lacks.
const XIAOLAI_DIR = FONT_DIR + 'Xiaolai/'
const XIAOLAI = JSON.parse(readFileSync(XIAOLAI_DIR + 'index.json', 'utf8'))
const XIAOLAI_FILES = new Map()
for (const [first, last, file] of XIAOLAI.ranges) {
  for (let code = first; code <= last; code += 1) XIAOLAI_FILES.set(code, `${XIAOLAI_DIR}${file}.ttf`)
}
export const CJK_FONT_CANDIDATES = [
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
]
const CJK_FAMILIES = 'Hiragino Sans GB, STHeiti, Noto Sans CJK SC, WenQuanYi Micro Hei, Microsoft YaHei'
export const MAX_PIXELS = 1600
const generator = rough.generator()

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = value => Math.round(value * 100) / 100

function isTransparent(color) {
  return !color || color === 'transparent' || /^#[0-9a-f]{6}00$/i.test(color) || /^#[0-9a-f]{3}0$/i.test(color)
}

function adjustRoughness(element) {
  const maxSize = Math.max(element.width, element.height)
  const minSize = Math.min(element.width, element.height)
  const linear = element.type === 'line' || element.type === 'arrow'
  if ((minSize >= 20 && maxSize >= 50) || (minSize >= 15 && element.roundness) || (linear && maxSize >= 50)) return element.roughness
  return Math.min(element.roughness / (maxSize < 10 ? 3 : 2), 2.5)
}

// As Excalidraw's isPathALoop: a line or freedraw whose end comes back to its start is closed and filled.
const LOOP_GAP = 8

function isLoop(points) {
  if (points.length < 3) return false
  const [x0, y0] = points[0]
  const [x1, y1] = points[points.length - 1]
  return Math.hypot(x1 - x0, y1 - y0) <= LOOP_GAP
}

function roughOptions(element, continuousPath = false) {
  const options = {
    seed: element.seed,
    strokeLineDash: element.strokeStyle === 'dashed' ? [8, 8 + element.strokeWidth]
      : element.strokeStyle === 'dotted' ? [1.5, 6 + element.strokeWidth] : undefined,
    disableMultiStroke: element.strokeStyle !== 'solid',
    strokeWidth: element.strokeStyle !== 'solid' ? element.strokeWidth + 0.5 : element.strokeWidth,
    fillWeight: element.strokeWidth / 2,
    hachureGap: element.strokeWidth * 4,
    roughness: adjustRoughness(element),
    stroke: element.strokeColor,
    preserveVertices: continuousPath || element.roughness < 2,
  }
  if (['rectangle', 'diamond', 'ellipse'].includes(element.type) || (['line', 'freedraw'].includes(element.type) && isLoop(element.points))) {
    options.fillStyle = element.fillStyle
    options.fill = isTransparent(element.backgroundColor) ? undefined : element.backgroundColor
    if (element.type === 'ellipse') options.curveFitting = 1
  }
  return options
}

function cornerRadius(size, element) {
  if (element.roundness?.type === 1 || element.roundness?.type === 2) return size * 0.25
  if (element.roundness?.type === 3) {
    const fixed = element.roundness.value ?? 32
    return size <= fixed / 0.25 ? size * 0.25 : fixed
  }
  return 0
}

function shapeDrawables(element) {
  const { width: w, height: h } = element
  switch (element.type) {
    case 'rectangle': {
      if (!element.roundness) return [generator.rectangle(0, 0, w, h, roughOptions(element))]
      const r = cornerRadius(Math.min(w, h), element)
      return [generator.path(`M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`, roughOptions(element, true))]
    }
    case 'diamond': {
      const topX = Math.floor(w / 2) + 1
      const rightY = Math.floor(h / 2) + 1
      return [generator.polygon([[topX, 0], [w, rightY], [topX, h], [0, rightY]], roughOptions(element))]
    }
    case 'ellipse':
      return [generator.ellipse(w / 2, h / 2, w, h, roughOptions(element))]
    case 'line':
    case 'arrow': {
      const options = roughOptions(element)
      const points = element.points.length ? element.points : [[0, 0]]
      if (!element.roundness) return [options.fill ? generator.polygon(points, options) : generator.linearPath(points, options)]
      return [generator.curve(points, options)]
    }
    default:
      return []
  }
}

function drawableToSvg(drawable) {
  const options = drawable.options
  const out = []
  for (const set of drawable.sets) {
    const d = generator.opsToPath(set, 2)
    if (set.type === 'path') {
      const dash = options.strokeLineDash ? ` stroke-dasharray="${options.strokeLineDash.join(' ')}"` : ''
      out.push(`<path d="${d}" stroke="${escape(options.stroke)}" stroke-width="${options.strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"${dash}/>`)
    } else if (set.type === 'fillPath') {
      out.push(`<path d="${d}" stroke="none" fill="${escape(options.fill)}"/>`)
    } else if (set.type === 'fillSketch') {
      out.push(`<path d="${d}" stroke="${escape(options.fill)}" stroke-width="${options.fillWeight}" fill="none"/>`)
    }
  }
  return out.join('')
}

const ARROWHEAD_SIZE = { arrow: 25, diamond: 12, diamond_outline: 12, crowfoot_many: 20, crowfoot_one: 20, crowfoot_one_or_many: 20 }
const ARROWHEAD_ANGLE = { bar: 90, arrow: 20 }

const turn = ([x, y], [cx, cy], angle) => [
  cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle),
  cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle),
]

/**
 * Excalidraw's getArrowheadPoints: the head follows the drawn curve near its end, and is
 * scaled down on a short last segment. `shape` is the arrow's rough drawable.
 */
function arrowheadPoints(element, shape, position, kind) {
  const ops = (shape.sets.find(set => set.type === 'path') ?? shape.sets[0])?.ops ?? []
  const index = position === 'start' ? 1 : ops.length - 1
  if (index < 1 || ops[index]?.data.length !== 6) return null
  const data = ops[index].data
  const [p1, p2, p3] = [[data[0], data[1]], [data[2], data[3]], [data[4], data[5]]]
  const previous = ops[index - 1]
  const p0 = previous.op === 'move' ? previous.data : previous.op === 'bcurveTo' ? previous.data.slice(4) : [0, 0]
  const at = (t, i) => (1 - t) ** 3 * p3[i] + 3 * t * (1 - t) ** 2 * p2[i] + 3 * t ** 2 * (1 - t) * p1[i] + t ** 3 * p0[i]
  const [x2, y2] = position === 'start' ? p0 : p3
  const [x1, y1] = [at(0.3, 0), at(0.3, 1)]
  const distance = Math.hypot(x2 - x1, y2 - y1)
  if (distance === 0) return null
  const [nx, ny] = [(x2 - x1) / distance, (y2 - y1) / distance]
  const points = element.points
  const [cx, cy] = position === 'end' ? points[points.length - 1] : points[0]
  const [px, py] = position === 'end' ? points[points.length - 2] : points[1]
  const size = Math.min(ARROWHEAD_SIZE[kind] ?? 15, Math.hypot(cx - px, cy - py) * (kind.startsWith('diamond') ? 0.25 : 0.5))
  const [xs, ys] = [x2 - nx * size, y2 - ny * size]
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') return [x2, y2, Math.hypot(ys - y2, xs - x2) + element.strokeWidth - 2]
  const angle = (ARROWHEAD_ANGLE[kind] ?? 25) * Math.PI / 180
  if (kind === 'crowfoot_many' || kind === 'crowfoot_one_or_many') {
    return [xs, ys, ...turn([x2, y2], [xs, ys], -angle), ...turn([x2, y2], [xs, ys], angle)]
  }
  const [x3, y3] = turn([xs, ys], [x2, y2], -angle)
  const [x4, y4] = turn([xs, ys], [x2, y2], angle)
  if (kind.startsWith('diamond')) {
    const back = position === 'start' ? turn([x2 + size * 2, y2], [x2, y2], Math.atan2(py - y2, px - x2))
      : turn([x2 - size * 2, y2], [x2, y2], Math.atan2(y2 - py, x2 - px))
    return [x2, y2, x3, y3, ...back, x4, y4]
  }
  return [x2, y2, x3, y3, x4, y4]
}

/** Excalidraw's getArrowheadShapes, drawn with the arrow's own rough options. */
function arrowheadSvg(element, shape, position, kind, background) {
  const head = arrowheadPoints(element, shape, position, kind)
  if (!head) return ''
  const { strokeLineDash, ...options } = shape.options
  const filled = (outline, roughness) => ({ ...options, fill: outline ? background : element.strokeColor, fillStyle: 'solid', roughness: Math.min(roughness, options.roughness || 0) })
  if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
    return drawableToSvg(generator.circle(head[0], head[1], head[2], filled(kind === 'circle_outline', 0.5)))
  }
  if (kind.startsWith('triangle') || kind.startsWith('diamond')) {
    const corners = []
    for (let index = 0; index < head.length; index += 2) corners.push([head[index], head[index + 1]])
    return drawableToSvg(generator.polygon([...corners, corners[0]], filled(kind.endsWith('_outline'), 1)))
  }
  const lineOptions = { ...options, roughness: Math.min(1, options.roughness || 0), ...(element.strokeStyle === 'dotted' ? { strokeLineDash } : {}) }
  const crossbar = points => (points ? drawableToSvg(generator.line(points[2], points[3], points[4], points[5], lineOptions)) : '')
  if (kind === 'crowfoot_one') return crossbar(head)
  const [x2, y2, x3, y3, x4, y4] = head
  return drawableToSvg(generator.line(x3, y3, x2, y2, lineOptions)) + drawableToSvg(generator.line(x4, y4, x2, y2, lineOptions))
    + (kind === 'crowfoot_one_or_many' ? crossbar(arrowheadPoints(element, shape, position, 'crowfoot_one')) : '')
}

function freedrawPath(element) {
  const pressures = element.simulatePressure ? undefined : element.pressures
  const input = element.points.map(([x, y], index) => [x, y, pressures?.[index] ?? 0.5])
  const outline = getStroke(input, {
    simulatePressure: element.simulatePressure,
    size: element.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: t => Math.sin((t * Math.PI) / 2),
    last: true,
  })
  if (outline.length === 0) return ''
  const average = (a, b) => (a + b) / 2
  let d = `M ${num(outline[0][0])} ${num(outline[0][1])} Q`
  for (let index = 0; index < outline.length; index += 1) {
    const [x0, y0] = outline[index]
    const [x1, y1] = outline[(index + 1) % outline.length]
    d += ` ${num(x0)} ${num(y0)} ${num(average(x0, x1))} ${num(average(y0, y1))}`
  }
  return `<path d="${d} Z" fill="${escape(element.strokeColor)}" stroke="none"/>`
}

const CJK = '\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef'
const SCRIPT_RUN = new RegExp(`[${CJK}]+|[^${CJK}]+`, 'gu')
const CJK_START = new RegExp(`^[${CJK}]`, 'u')

const familyOf = element => FAMILY_NAMES[element.fontFamily] ?? 'Excalifont'

/** The Xiaolai subsets holding the characters of the Excalifont texts among `elements`. */
export function xiaolaiFiles(elements) {
  const files = new Set()
  for (const element of elements) {
    if (element.type !== 'text' || familyOf(element) !== 'Excalifont') continue
    for (const char of element.text) {
      const file = XIAOLAI_FILES.get(char.codePointAt(0))
      if (file) files.add(file)
    }
  }
  return [...files]
}

function textSvg(element) {
  const lineHeight = element.lineHeight ?? lineHeightOf(element.fontFamily)
  const lineHeightPx = element.fontSize * lineHeight
  const offset = verticalOffset(element.fontFamily, element.fontSize, lineHeightPx)
  const family = escape(familyOf(element))
  const cjk = family === 'Excalifont' ? `${escape(XIAOLAI.family)}, ${CJK_FAMILIES}` : CJK_FAMILIES
  const x = element.textAlign === 'center' ? element.width / 2 : element.textAlign === 'right' ? element.width : 0
  // resvg shapes a whole line with one face, so each script run is placed as its own text.
  return element.text.split('\n').map((line, index) => {
    const y = num(offset + index * lineHeightPx)
    const total = lineWidth(line, element.fontFamily, element.fontSize)
    let cursor = element.textAlign === 'center' ? x - total / 2 : element.textAlign === 'right' ? x - total : x
    return (line.match(SCRIPT_RUN) ?? []).map(run => {
      const face = CJK_START.test(run) ? cjk : family
      const svg = `<text x="${num(cursor)}" y="${y}" font-family="${face}" font-size="${element.fontSize}" fill="${escape(element.strokeColor)}" xml:space="preserve">${escape(run)}</text>`
      cursor += lineWidth(run, element.fontFamily, element.fontSize)
      return svg
    }).join('')
  }).join('')
}

/**
 * One element as SVG. `scene` gives `files` for images, `byId` to find an arrow's label
 * and the `background` outlined arrowheads are filled with.
 */
function elementSvg(element, { files, byId, background }) {
  const box = elementBounds({ ...element, angle: 0 })
  const cx = (box.x1 + box.x2) / 2
  const cy = (box.y1 + box.y2) / 2
  let body = ''
  switch (element.type) {
    case 'rectangle':
    case 'diamond':
    case 'ellipse':
    case 'line':
    case 'arrow': {
      const shapes = shapeDrawables(element)
      body = shapes.map(drawableToSvg).join('')
      if (element.type === 'arrow' && shapes.length > 0) {
        if (element.startArrowhead) body += arrowheadSvg(element, shapes[0], 'start', element.startArrowhead, background)
        if (element.endArrowhead) body += arrowheadSvg(element, shapes[0], 'end', element.endArrowhead, background)
      }
      break
    }
    case 'freedraw': {
      const options = roughOptions(element)
      if (options.fill) body = drawableToSvg(generator.curve(element.points, { ...options, stroke: 'none' }))
      body += freedrawPath(element)
      break
    }
    case 'text':
      body = textSvg(element)
      break
    case 'image': {
      const file = files?.[element.fileId]
      body = file?.dataURL
        ? `<image href="${escape(file.dataURL)}" width="${num(element.width)}" height="${num(element.height)}" preserveAspectRatio="none"/>`
        : `<rect width="${num(element.width)}" height="${num(element.height)}" fill="#f1f3f5" stroke="#adb5bd"/>`
      break
    }
    default:
      return ''
  }
  const rotation = element.angle ? ` rotate(${num(element.angle * 180 / Math.PI)} ${num(cx - element.x)} ${num(cy - element.y)})` : ''
  // Excalidraw fades every fill and stroke on its own, so a stroke lets the fill under it show through.
  const alpha = element.opacity / 100
  const opacity = element.opacity === 100 ? '' : element.type === 'image' ? ` opacity="${alpha}"` : ` fill-opacity="${alpha}" stroke-opacity="${alpha}"`
  const svg = `<g transform="translate(${num(element.x)} ${num(element.y)})${rotation}"${opacity}>${body}</g>`
  // As in Excalidraw, an arrow is cleared where its label sits.
  const labelId = element.type === 'arrow' ? element.boundElements?.find(bound => bound.type === 'text')?.id : undefined
  const label = labelId ? byId.get(labelId) : undefined
  if (!label || label.isDeleted) return svg
  const mask = `mask-${escape(element.id)}`
  return `<mask id="${mask}" maskUnits="userSpaceOnUse" x="-1e6" y="-1e6" width="2e6" height="2e6"><rect x="-1e6" y="-1e6" width="2e6" height="2e6" fill="white"/>`
    + `<rect x="${num(label.x)}" y="${num(label.y)}" width="${num(label.width)}" height="${num(label.height)}" fill="black"/></mask><g mask="url(#${mask})">${svg}</g>`
}

/** A small padlock with its top-left corner at (x, y), 9×12 units. */
function lockSvg(x, y) {
  return `<g fill="none" stroke="#868e96" stroke-width="1.5"><rect x="${num(x)}" y="${num(y + 5)}" width="9" height="7" rx="1.5"/>`
    + `<path d="M${num(x + 2)} ${num(y + 5)}v-2a2.5 2.5 0 0 1 5 0v2"/></g>`
}

/** A box as the canvas draws it, its label naming the owner, after a padlock when it is locked. */
function frameSvg(frame) {
  const { name, owner } = boxInfo(frame)
  const locked = lockHolder(frame) !== null
  const label = `${name}${owner ? ` · ${owner.name}` : ''}`
  return `<rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.width)}" height="${num(frame.height)}" rx="8" fill="none" stroke="#bbb" stroke-width="1.5"/>`
    + (locked ? lockSvg(frame.x, frame.y - 18) : '')
    + `<text x="${num(frame.x + (locked ? 14 : 0))}" y="${num(frame.y - 6)}" font-family="Liberation Sans, ${CJK_FAMILIES}" font-size="14" fill="#868e96">${escape(label)}</text>`
}

const GRID_STEPS = [25, 50, 100, 200, 500, 1000, 2000, 5000]

/** Faint labelled lines at round canvas coordinates, so a viewer can read positions off the image. */
function gridSvg(view, scale) {
  const span = Math.max(view.x2 - view.x1, view.y2 - view.y1)
  const step = GRID_STEPS.find(candidate => span / candidate <= 16) ?? GRID_STEPS.at(-1)
  const size = num(11 / scale)
  const lines = []
  for (let x = Math.ceil(view.x1 / step) * step; x <= view.x2; x += step) {
    lines.push(`<line x1="${x}" y1="${num(view.y1)}" x2="${x}" y2="${num(view.y2)}"/>`)
    lines.push(`<text x="${num(x + 2 / scale)}" y="${num(view.y1 + 12 / scale)}" stroke="none">${x}</text>`)
  }
  for (let y = Math.ceil(view.y1 / step) * step; y <= view.y2; y += step) {
    lines.push(`<line x1="${num(view.x1)}" y1="${y}" x2="${num(view.x2)}" y2="${y}"/>`)
    lines.push(`<text x="${num(view.x1 + 2 / scale)}" y="${num(y - 2 / scale)}" stroke="none">${y}</text>`)
  }
  return `<g stroke="#4dabf7" stroke-opacity="0.35" stroke-width="${num(1 / scale)}" fill="#1c7ed6" font-family="Liberation Sans" font-size="${size}">${lines.join('')}</g>`
}

/**
 * Render part of a scene.
 * @param scene - `{ elements, files, appState }`, elements in z-order.
 * @param options.region - scene box to show; defaults to everything.
 * @param options.ids - restrict drawing to these elements (and their bound text).
 * @param options.scale - pixels per scene unit; reduced to keep the image within MAX_PIXELS.
 * @param options.grid - overlay labelled canvas coordinates.
 * @param options.fontFiles - extra font files, such as a CJK face for text outside Excalifont.
 * @returns `{ png, width, height, region, scale }`; `region` is the scene box the image shows.
 */
export function renderScene(scene, { region, ids, scale = 1, padding = 24, grid = false, fontFiles = [] } = {}) {
  const live = scene.elements.filter(element => !element.isDeleted)
  let drawn = live
  if (ids) {
    const wanted = new Set(ids)
    drawn = live.filter(element => wanted.has(element.id) || (element.containerId && wanted.has(element.containerId)))
  }
  const box = region ?? unionBox(drawn.map(element => isBox(element) ? frameBox(element) : elementBounds(element)))
    ?? { x1: 0, y1: 0, x2: 400, y2: 300 }
  const view = { x1: box.x1 - padding, y1: box.y1 - padding - 18, x2: box.x2 + padding, y2: box.y2 + padding }
  const width = view.x2 - view.x1
  const height = view.y2 - view.y1
  const effectiveScale = Math.min(scale, MAX_PIXELS / width, MAX_PIXELS / height)
  const visible = drawn.filter(element => boxesIntersect(view, isBox(element) ? frameBox(element) : elementBounds(element)))
  const frames = new Map(live.filter(isBox).map(frame => [frame.id, frame]))
  const background = scene.appState?.viewBackgroundColor ?? '#ffffff'
  const svgBackground = isTransparent(background) ? '#ffffff' : background
  const byId = new Map(live.map(element => [element.id, element]))
  const defs = []
  const body = []
  for (const frame of frames.values()) {
    defs.push(`<clipPath id="clip-${escape(frame.id)}"><rect x="${num(frame.x)}" y="${num(frame.y)}" width="${num(frame.width)}" height="${num(frame.height)}" rx="8"/></clipPath>`)
  }
  for (const element of visible) {
    if (isBox(element)) {
      body.push(frameSvg(element))
      continue
    }
    const svg = elementSvg(element, { files: scene.files, byId, background: svgBackground })
    body.push(element.frameId && frames.has(element.frameId) ? `<g clip-path="url(#clip-${escape(element.frameId)})">${svg}</g>` : svg)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width * effectiveScale)}" height="${num(height * effectiveScale)}" viewBox="${num(view.x1)} ${num(view.y1)} ${num(width)} ${num(height)}">`
    + `<defs>${defs.join('')}</defs><rect x="${num(view.x1)}" y="${num(view.y1)}" width="${num(width)}" height="${num(height)}" fill="${escape(svgBackground)}"/>`
    + `${grid ? gridSvg(view, effectiveScale) : ''}${body.join('')}</svg>`
  const files = [...BUNDLED_FONTS, ...xiaolaiFiles(visible), ...fontFiles.filter(file => existsSync(file))]
  const rendered = new Resvg(svg, {
    font: { fontFiles: files, loadSystemFonts: false, defaultFontFamily: 'Excalifont' },
    fitTo: { mode: 'original' },
  }).render()
  return {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
    region: view,
    scale: effectiveScale,
    svg,
  }
}

export function defaultCjkFonts() {
  return CJK_FONT_CANDIDATES.filter(file => existsSync(file)).slice(0, 1)
}
