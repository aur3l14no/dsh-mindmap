import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boxInfo, withMindmapData } from '../src/shared/scene.js'
import { Canvas } from '../src/host/canvas.js'
import { compactElement, revise } from '../src/host/elements.js'
import { WriteRejected, prepareWrite } from '../src/host/write.js'

// The canvas lead's Session is "L"; alice and bob are its teammates; "X" leads another Team.
const lead = { name: 'lead', lead: 'L', sessionId: 'L' }
const alice = { name: 'alice', lead: 'L', sessionId: 'A' }
const bob = { name: 'bob', lead: 'L', sessionId: 'B' }
const outsider = { name: 'lead', lead: 'X', sessionId: 'X' }

async function scene(build) {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-write-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'test' })
  canvas.sessionId = 'L'
  const write = (request, writer = lead) => {
    const { changes, report } = prepareWrite(canvas, writer, request)
    canvas.commit(changes, { origin: 'test' })
    return report
  }
  write({ elements: build })
  const lockTo = (id, holder) => canvas.commit([withMindmapData(revise(canvas.get(id)), holder === 'user'
    ? { lock: 'user' } : { owner: holder, lock: holder })], { origin: 'test' })
  return { canvas, write, lockTo, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const frames = [
  { type: 'frame', id: 'in', name: 'Input', x: 0, y: 0, width: 300, height: 200 },
  { type: 'frame', id: 'out', name: 'Output', x: 400, y: 0, width: 300, height: 200 },
  { type: 'frame', id: 'far', name: 'Far', x: 760, y: 0, width: 200, height: 200 },
]
const rejected = pattern => error => error instanceof WriteRejected && pattern.test(`${error.message}\n${error.hint ?? ''}`)

test('creates labelled shapes and bound arrows with Excalidraw structure', async () => {
  const { canvas, write, cleanup } = await scene(frames)
  const report = write({
    elements: [
      { type: 'arrow', id: 'link', x: 0, y: 0, start: { id: 'a' }, end: { id: 'b' } },
      { type: 'rectangle', id: 'a', x: 20, y: 20, width: 100, height: 60, label: 'Wheel' },
      { type: 'ellipse', id: 'b', x: 160, y: 40, width: 80, height: 80 },
    ],
  })
  assert.deepEqual(report.created.sort(), ['a', 'b', 'link', report.created.find(id => !['a', 'b', 'link'].includes(id))].sort())
  const rect = canvas.get('a')
  const text = canvas.get(rect.boundElements.find(bound => bound.type === 'text').id)
  assert.equal(text.containerId, 'a')
  assert.equal(text.frameId, 'in')
  assert.equal(rect.frameId, 'in')
  assert.ok(rect.boundElements.some(bound => bound.id === 'link'))
  const arrow = canvas.get('link')
  assert.equal(arrow.startBinding.elementId, 'a')
  assert.equal(arrow.endBinding.elementId, 'b')
  assert.ok(arrow.x >= 120, 'arrow starts at the right edge of the rectangle')
  const compact = compactElement(rect, canvas.elements)
  assert.deepEqual(compact.label, { text: 'Wheel' })
  await cleanup()
})

test('a box locked to a teammate keeps others out of everything lying in it', async () => {
  const { canvas, write, lockTo, cleanup } = await scene([...frames, { type: 'rectangle', id: 'inside', x: 410, y: 10, width: 20, height: 20 }])
  lockTo('out', alice)
  assert.throws(() => write({ elements: [{ id: 'inside', x: 430 }] }, bob), rejected(/locked by teammate "alice"; ask alice or the lead with send_message/))
  assert.throws(() => write({ elements: [{ type: 'rectangle', x: 380, y: 20, width: 40, height: 40 }] }, bob), rejected(/would lie in box "Output"/))
  assert.throws(() => write({ elements: [{ type: 'arrow', x: 200, y: 100, points: [[0, 0], [300, 0]] }] }, bob), rejected(/box "Output"/))
  assert.throws(() => write({ delete: ['inside'] }, bob), rejected(/locked by teammate "alice"/))
  assert.throws(() => write({ elements: [{ id: 'out', name: 'Mine' }] }, bob), rejected(/locked by teammate "alice"/))
  write({ elements: [{ type: 'arrow', x: 200, y: 260, points: [[0, 0], [300, 0]] }] }, bob)
  write({ elements: [{ id: 'inside', x: 430 }] }, alice)
  assert.equal(canvas.get('inside').x, 430)
  await cleanup()
})

test('a teammate locking a box the lead drew becomes its owner', async () => {
  const { canvas, write, cleanup } = await scene(frames)
  write({ elements: [{ type: 'frame', id: 'slot', name: 'Slot', x: 0, y: 300, width: 200, height: 100, lock: true }] })
  assert.equal(boxInfo(canvas.get('slot')).owner.name, 'lead')
  write({ elements: [{ id: 'slot', lock: false }] })
  write({ elements: [{ id: 'slot', lock: true }] }, alice)
  assert.deepEqual(boxInfo(canvas.get('slot')).owner, alice)
  assert.deepEqual(boxInfo(canvas.get('slot')).lock, alice)
  await cleanup()
})

test('locking a box without an owner makes the writer its owner; the lead may lift a teammate lock, never the user lock', async () => {
  const { canvas, write, lockTo, cleanup } = await scene(frames)
  write({ elements: [{ id: 'in', lock: true }] }, bob)
  assert.deepEqual(boxInfo(canvas.get('in')).owner, { name: 'bob', lead: 'L', sessionId: 'B' })
  assert.deepEqual(boxInfo(canvas.get('in')).lock, boxInfo(canvas.get('in')).owner)
  assert.throws(() => write({ elements: [{ id: 'in', lock: false }] }, alice), rejected(/locked by teammate "bob"/))
  assert.throws(() => write({ elements: [{ id: 'in', lock: false, name: 'Taken' }] }, lead), rejected(/as the canvas lead|unlock the box/))
  write({ elements: [{ id: 'in', lock: false }] }, lead)
  assert.equal(boxInfo(canvas.get('in')).lock, null)
  assert.equal(boxInfo(canvas.get('in')).owner.name, 'bob', 'the box still belongs to bob')
  const report = write({ elements: [{ id: 'in', lock: true }] }, lead)
  assert.equal(boxInfo(canvas.get('in')).lock.name, 'bob', 'the lead locking it again gives it back to bob')
  assert.match(report.warnings.join(), /box "Input" \(in\) is locked to its owner, teammate "bob", again/)
  write({ elements: [{ id: 'in', lock: false }] }, lead)
  write({ elements: [{ id: 'in', lock: true }] }, alice)
  assert.equal(boxInfo(canvas.get('in')).lock.name, 'alice', 'a teammate locking it holds it')
  assert.equal(boxInfo(canvas.get('in')).owner.name, 'bob', 'locking a box someone owns leaves the owner')
  lockTo('out', 'user')
  assert.throws(() => write({ elements: [{ id: 'out', lock: false }] }, lead), rejected(/locked by the user; only the user can unlock it/))
  assert.throws(() => write({ elements: [{ type: 'text', text: 'hi', x: 450, y: 50 }] }, lead), rejected(/locked by the user/))
  write({ elements: [{ type: 'frame', id: 'new', name: 'New', x: 0, y: 300, width: 200, height: 100, lock: true }] }, outsider)
  assert.throws(() => write({ elements: [{ type: 'text', text: 'hi', x: 20, y: 320 }] }, alice), rejected(/locked by session X/))
  await cleanup()
})

test('what lies where locked boxes overlap is locked to both holders', async () => {
  const { canvas, write, lockTo, cleanup } = await scene(frames.slice(0, 2))
  lockTo('in', alice)
  lockTo('out', bob)
  const report = write({ elements: [{ id: 'out', x: 250, width: 450 }] }, bob)
  assert.match(report.warnings.join(), /overlaps box "Input" \(in\), locked by teammate "alice"/)
  assert.throws(() => write({ elements: [{ type: 'rectangle', x: 260, y: 20, width: 30, height: 30 }] }, bob), rejected(/box "Input"/))
  write({ elements: [{ type: 'rectangle', id: 'own', x: 320, y: 20, width: 30, height: 30 }] }, bob)
  assert.equal(canvas.get('own').frameId, 'out')
  await cleanup()
})

test('a refusal near your box tells how far it can grow before a box locked by someone else', async () => {
  const { write, lockTo, cleanup } = await scene(frames)
  lockTo('out', alice)
  lockTo('far', bob)
  assert.throws(() => write({ elements: [{ type: 'rectangle', x: 710, y: 20, width: 100, height: 50 }] }, alice),
    rejected(/box "Far" .*your box "Output" \(x 400, y 0, 300×200\) can grow left unlimited, right 50px/s))
  await cleanup()
})

test('moving a box carries its members, resizing it does not, and content past your box is flagged', async () => {
  const { canvas, write, lockTo, cleanup } = await scene(frames.slice(0, 2))
  lockTo('out', alice)
  write({ elements: [{ type: 'rectangle', id: 'm', x: 420, y: 20, width: 40, height: 40 }] }, alice)
  write({ elements: [{ id: 'out', y: 300 }] }, alice)
  assert.equal(canvas.get('m').y, 320)
  write({ elements: [{ id: 'out', y: 200, height: 300 }] }, alice)
  assert.equal(canvas.get('m').y, 320, 'growing the box upward leaves its members in place')
  assert.equal(canvas.get('m').frameId, 'out')
  const report = write({ elements: [{ type: 'rectangle', id: 'wide', x: 650, y: 320, width: 100, height: 40 }] }, alice)
  assert.match(report.warnings.join(), /"wide" sticks out of your box "Output"/)
  await cleanup()
})

test('elements can be stacked above or below another, labels moving with their shape', async () => {
  const { canvas, write, cleanup } = await scene([
    { type: 'rectangle', id: 'back', x: 0, y: 0, width: 80, height: 80, label: 'Back' },
    { type: 'ellipse', id: 'front', x: 20, y: 20, width: 40, height: 40 },
  ])
  const order = () => canvas.ordered().filter(element => !element.containerId).map(element => element.id)
  assert.deepEqual(order(), ['back', 'front'])
  write({ elements: [{ type: 'rectangle', id: 'shadow', x: 4, y: 4, width: 80, height: 80, below: 'back' }, { id: 'front', below: 'back' }] })
  assert.deepEqual(order(), ['shadow', 'front', 'back'])
  const all = canvas.ordered().map(element => element.id)
  const label = canvas.get('back').boundElements.find(bound => bound.type === 'text').id
  assert.equal(all.indexOf(label), all.indexOf('back') + 1, 'the label stays right above its shape')
  write({ elements: [{ id: 'shadow', above: 'back' }] })
  assert.deepEqual(order(), ['front', 'back', 'shadow'])
  assert.throws(() => write({ elements: [{ id: 'front', above: 'nothing' }] }), /"above" names element "nothing", which does not exist/)
  await cleanup()
})

test('copies keep their layout, labels and arrows, scaled as a group', async () => {
  const { canvas, write, lockTo, cleanup } = await scene([
    ...frames,
    { type: 'rectangle', id: 'seat', x: 20, y: 20, width: 100, height: 40, label: 'Seat' },
    { type: 'ellipse', id: 'wheel', x: 20, y: 100, width: 60, height: 60 },
    { type: 'arrow', id: 'link', x: 0, y: 0, start: { id: 'seat' }, end: { id: 'wheel' } },
  ])
  lockTo('in', alice)
  const report = write({ copy: [{ ids: ['seat', 'wheel', 'link'], x: 420, y: 20, scale: 0.5 }] }, bob)
  assert.deepEqual(report.copies, [{ prefix: 'c1-', count: 3 }])
  const seat = canvas.get('c1-seat')
  assert.deepEqual([seat.x, seat.y, seat.width, seat.frameId], [420, 20, 50, 'out'])
  const label = canvas.get(seat.boundElements.find(bound => bound.type === 'text').id)
  assert.equal(label.text, 'Seat')
  assert.equal(label.fontSize, 10)
  assert.deepEqual([canvas.get('c1-wheel').x, canvas.get('c1-wheel').y], [420, 60])
  const link = canvas.get('c1-link')
  assert.equal(link.startBinding.elementId, 'c1-seat')
  assert.equal(link.endBinding.elementId, 'c1-wheel')
  assert.equal(canvas.get('seat').x, 20, 'the original stays')
  assert.equal(write({ copy: [{ ids: ['wheel'], x: 600, y: 100 }] }, bob).copies[0].prefix, 'c2-')
  assert.throws(() => write({ copy: [{ ids: ['wheel'], x: 30, y: 30 }] }, bob), rejected(/would lie in box "Input"/))
  assert.throws(() => write({ copy: [{ ids: ['in'], x: 600, y: 300 }] }, bob), rejected(/is a box; copy the elements in it/))
  await cleanup()
})

test('moves place, scale and turn a group in place, within the locks', async () => {
  const { canvas, write, lockTo, cleanup } = await scene([
    ...frames,
    { type: 'rectangle', id: 'a', x: 20, y: 20, width: 100, height: 40, label: 'A' },
    { type: 'rectangle', id: 'b', x: 20, y: 120, width: 100, height: 40 },
    { type: 'arrow', id: 'ab', x: 0, y: 0, start: { id: 'a' }, end: { id: 'b' } },
    { type: 'ellipse', id: 'loose', x: 200, y: 20, width: 40, height: 40 },
    { type: 'arrow', id: 'tie', x: 0, y: 0, start: { id: 'a' }, end: { id: 'loose' } },
  ])
  lockTo('in', alice)
  const at = id => [canvas.get(id).x, canvas.get(id).y]
  write({ move: [{ ids: ['a', 'b', 'ab'], x: 60 }] }, alice)
  assert.deepEqual([at('a'), at('b')], [[60, 20], [60, 120]], 'y stays where it was')
  const label = canvas.get(canvas.get('a').boundElements.find(bound => bound.type === 'text').id)
  assert.ok(label.x > 60 && label.x < 160, 'the label moves with its shape')
  assert.equal(canvas.get('ab').x, at('a')[0] + 50, 'an arrow inside the group moves with it')
  assert.equal(canvas.get('ab').startBinding.elementId, 'a')

  // A quarter turn about the group's centre (110, 90): the column of boxes becomes a row.
  write({ move: [{ ids: ['a', 'b'], angle: Math.PI / 2 }] }, alice)
  const centre = id => [canvas.get(id).x + canvas.get(id).width / 2, canvas.get(id).y + canvas.get(id).height / 2]
  assert.deepEqual([centre('a'), centre('b')], [[160, 90], [60, 90]])
  assert.equal(canvas.get('a').angle, 1.5708)
  write({ move: [{ ids: ['loose', 'tie'], scale: 2 }] }, alice)
  assert.deepEqual([canvas.get('loose').width, canvas.get('tie').startBinding], [80, null], 'an arrow end outside the group comes loose')

  assert.throws(() => write({ move: [{ ids: ['a'], x: 420 }] }, bob), rejected(/move "a": "a" lies in box "Input"/))
  assert.throws(() => write({ move: [{ ids: ['a'] }, { ids: ['a', 'b'] }] }, alice), rejected(/"a" is already in an earlier move/))
  assert.throws(() => write({ move: [{ ids: ['in'], x: 10 }] }, alice), rejected(/move a box by changing its x and y/))
  await cleanup()
})

test('a line reads and changes by its top-left corner, whatever its first point', async () => {
  const roof = [[295, 0], [590, 128], [0, 128], [295, 0]]
  const { canvas, write, cleanup } = await scene([{ type: 'line', id: 'roof', x: 415, y: 172, points: roof }])
  const read = () => compactElement(canvas.get('roof'), canvas.elements)
  assert.deepEqual([read().x, read().y, read().points], [415, 172, roof], 'canvas_read gives what was written')
  assert.equal(canvas.get('roof').points[0].join(), '0,0', 'stored with its first point at the origin, as Excalidraw keeps lines')
  write({ elements: [{ id: 'roof', points: roof }] })
  write({ elements: [{ id: 'roof', points: roof }] })
  assert.deepEqual([read().x, read().y], [415, 172], 'giving points alone keeps the line in place')
  write({ elements: [{ id: 'roof', x: 500 }] })
  assert.deepEqual([read().x, read().y, read().points], [500, 172, roof])
  await cleanup()
})

test('a refusal says where the locked box is, and when a new element reuses an id someone else drew', async () => {
  const { write, lockTo, cleanup } = await scene(frames.slice(0, 2))
  lockTo('in', alice)
  write({ elements: [{ type: 'line', id: 'ground', x: 10, y: 150, points: [[0, 0], [200, 0]] }] }, alice)
  assert.throws(() => write({ elements: [{ type: 'line', id: 'ground', x: 420, y: 150, points: [[0, 0], [200, 0]] }] }, bob),
    rejected(/"ground" lies in box "Input" \(in\) at x 0, y 0, 300×200, which is locked by teammate "alice".*the id "ground" is taken by an existing line; give a new element another id/s))
  await cleanup()
})
