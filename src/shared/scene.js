// Scene vocabulary shared by the Host and the browser. Smart boxes are Excalidraw
// frames; `customData.mindmap` records the agent a box belongs to and who holds
// its lock, the user or one agent. A lock protects every element lying in the
// box, by membership or by geometry, since boxes may overlap.

export const MINDMAP_KEY = 'mindmap'

export function mindmapData(element) {
  return element?.customData?.[MINDMAP_KEY]
}

export function isBox(element) {
  return element?.type === 'frame' && !element.isDeleted
}

/**
 * @returns `{ id, name, owner, lock }`: `owner` is the agent the box belongs to;
 *   `lock` is `'user'`, the agent holding it, or null. An agent is
 *   `{ name, lead, sessionId? }`, named within the Agent Team led by Session `lead`.
 */
export function boxInfo(frame) {
  const data = mindmapData(frame) ?? {}
  return { id: frame.id, name: frame.name || 'Box', owner: isAgent(data.owner) ? data.owner : null, lock: data.lock === 'user' || isAgent(data.lock) ? data.lock : null }
}

function isAgent(value) {
  return typeof value?.name === 'string' && typeof value?.lead === 'string'
}

/** Who holds a box's lock: `'user'`, an agent, or null. */
export function lockHolder(frame) {
  return boxInfo(frame).lock
}

export function sameAgent(a, b) {
  return Boolean(a && b && a !== 'user' && b !== 'user' && a.lead === b.lead && a.name === b.name)
}

/**
 * Whether a box's lock keeps `writer` out.
 * @param writer - `'user'` for the canvas UI, or an agent `{ name, lead }`.
 */
export function lockedAgainst(frame, writer) {
  const holder = lockHolder(frame)
  if (!holder) return false
  if (holder === 'user') return writer !== 'user'
  return !sameAgent(holder, writer)
}

/** Return a copy of `element` with its mindmap customData merged with `patch`. */
export function withMindmapData(element, patch) {
  const customData = { ...(element.customData ?? {}) }
  customData[MINDMAP_KEY] = { ...(customData[MINDMAP_KEY] ?? {}), ...patch }
  return { ...element, customData }
}

/** Axis-aligned bounds of one element in scene coordinates, rotation included. */
export function elementBounds(element) {
  let x1, y1, x2, y2
  if (Array.isArray(element.points) && element.points.length > 0) {
    x1 = Infinity; y1 = Infinity; x2 = -Infinity; y2 = -Infinity
    for (const [px, py] of element.points) {
      x1 = Math.min(x1, px); y1 = Math.min(y1, py)
      x2 = Math.max(x2, px); y2 = Math.max(y2, py)
    }
    x1 += element.x; x2 += element.x; y1 += element.y; y2 += element.y
  } else {
    x1 = element.x; y1 = element.y
    x2 = element.x + (element.width ?? 0); y2 = element.y + (element.height ?? 0)
  }
  const angle = element.angle ?? 0
  if (!angle) return { x1, y1, x2, y2 }
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([px, py]) => [
    cx + (px - cx) * cos - (py - cy) * sin,
    cy + (px - cx) * sin + (py - cy) * cos,
  ])
  return {
    x1: Math.min(...corners.map(c => c[0])),
    y1: Math.min(...corners.map(c => c[1])),
    x2: Math.max(...corners.map(c => c[0])),
    y2: Math.max(...corners.map(c => c[1])),
  }
}

export function frameBox(frame) {
  return { x1: frame.x, y1: frame.y, x2: frame.x + frame.width, y2: frame.y + frame.height }
}

export function unionBox(boxes) {
  let box = null
  for (const next of boxes) {
    if (!next) continue
    box = box === null ? { ...next } : {
      x1: Math.min(box.x1, next.x1), y1: Math.min(box.y1, next.y1),
      x2: Math.max(box.x2, next.x2), y2: Math.max(box.y2, next.y2),
    }
  }
  return box
}

export function boxContains(outer, inner, tolerance = 0.5) {
  return inner.x1 >= outer.x1 - tolerance && inner.y1 >= outer.y1 - tolerance
    && inner.x2 <= outer.x2 + tolerance && inner.y2 <= outer.y2 + tolerance
}

export function boxesIntersect(a, b) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2
}

export function boxToRect(box) {
  return { x: round(box.x1), y: round(box.y1), width: round(box.x2 - box.x1), height: round(box.y2 - box.y1) }
}

export function round(value) {
  return Math.round(value * 100) / 100
}

/**
 * The frame an element dropped at `box` joins under Excalidraw's rule: the
 * topmost frame fully containing it.
 */
export function containingFrame(frames, box) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (boxContains(frameBox(frames[index]), box)) return frames[index]
  }
  return null
}

export function centerOf(element) {
  const box = elementBounds(element)
  return [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2]
}

/** Point just outside `element`'s bounding box on the ray from its center toward `toward`. */
export function edgePoint(element, toward, gap) {
  const box = elementBounds(element)
  const [cx, cy] = [(box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2]
  const dx = toward[0] - cx
  const dy = toward[1] - cy
  if (dx === 0 && dy === 0) return [cx, box.y1 - gap]
  const halfW = (box.x2 - box.x1) / 2 + gap
  const halfH = (box.y2 - box.y1) / 2 + gap
  const scale = Math.min(dx === 0 ? Infinity : halfW / Math.abs(dx), dy === 0 ? Infinity : halfH / Math.abs(dy))
  return [round(cx + dx * scale), round(cy + dy * scale)]
}

/** Whether segment a-b crosses or lies inside `box`. */
function segmentTouches(box, [ax, ay], [bx, by]) {
  // Liang-Barsky clipping of the segment against the box.
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  for (const [p, q] of [[-dx, ax - box.x1], [dx, box.x2 - ax], [-dy, ay - box.y1], [dy, box.y2 - ay]]) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/**
 * Whether an element lies, even partly, in a box: it is a member of the box's
 * frame, or its shape overlaps the box (a line or arrow by its segments).
 * @param frameIdOf - the frame an element counts toward; a label counts toward its container's.
 */
export function touchesBox(element, frame, frameIdOf = item => item.frameId) {
  if (element.id === frame.id) return false
  if (frameIdOf(element) === frame.id) return true
  const box = frameBox(frame)
  if (!boxesIntersect(box, elementBounds(element))) return false
  if (!['line', 'arrow'].includes(element.type) || element.angle || !Array.isArray(element.points) || element.points.length < 2) return true
  const points = element.points.map(([px, py]) => [element.x + px, element.y + py])
  return points.slice(1).some((point, index) => segmentTouches(box, points[index], point))
}
