import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boxInfo, mindmapData, withMindmapData } from '../src/shared/scene.js'
import { applyClientChanges } from '../src/host/api.js'
import { Canvas } from '../src/host/canvas.js'
import { revise } from '../src/host/elements.js'
import { prepareWrite } from '../src/host/write.js'

const alice = { name: 'alice', lead: 'L', sessionId: 'A' }

async function scene() {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-api-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'page' })
  canvas.sessionId = 'L'
  const { changes } = prepareWrite(canvas, { name: 'lead', lead: 'L', sessionId: 'L' }, {
    elements: [
      { type: 'frame', id: 'in', name: 'In', x: 0, y: 0, width: 300, height: 200 },
      { type: 'frame', id: 'out', name: 'Out', x: 400, y: 0, width: 300, height: 200 },
      { type: 'rectangle', id: 'box', x: 20, y: 20, width: 50, height: 50 },
    ],
  })
  canvas.commit(changes, { origin: 'test' })
  return { canvas, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** The page's next revision of an element. */
const edited = (element, fields = {}) => ({ ...element, ...fields, version: element.version + 1 })

test('a stale page edit is answered with the current copy', async () => {
  const { canvas, cleanup } = await scene()
  const current = canvas.get('box')
  const changes = []
  canvas.on('change', change => changes.push(change))
  applyClientChanges(canvas, [{ ...current, version: current.version - 1, x: 99 }], { clientId: 'c1' })
  assert.equal(canvas.get('box').x, 20)
  assert.equal(changes.at(-1).origin, 'host')
  assert.equal(changes.at(-1).elements[0].x, 20)
  await cleanup()
})

test('page edits in a box an agent holds are refused, yet the user can lift its lock', async () => {
  const { canvas, cleanup } = await scene()
  canvas.commit([withMindmapData(revise(canvas.get('in')), { owner: alice, lock: alice, stamp: 's1' })], { origin: 'test' })
  const box = canvas.get('box')
  const result = applyClientChanges(canvas, [edited(box, { x: 60 })], { clientId: 'c1' })
  assert.deepEqual(result.refused, [{ id: 'box', boxId: 'in' }])
  assert.equal(canvas.get('box').x, 20)
  assert.equal(canvas.get('box').version, box.version + 2, 'the Host copy is re-issued above the page copy')
  const drawn = { ...box, id: 'drawn', x: 250, y: 150, version: 1 }
  assert.equal(applyClientChanges(canvas, [drawn], { clientId: 'c1' }).refused[0].boxId, 'in')
  assert.equal(canvas.elements.get('drawn').isDeleted, true)
  const frame = canvas.get('in')
  assert.equal(applyClientChanges(canvas, [edited(frame, { x: 5 })], { clientId: 'c1' }).refused[0].boxId, 'in')
  // Unlocking and the edit it allows, in one batch, from a page whose Excalidraw filled in empty fields on load.
  assert.equal(canvas.get('in').boundElements, null)
  const unlocked = withMindmapData(edited(canvas.get('in'), { boundElements: [] }), { lock: null })
  assert.deepEqual(applyClientChanges(canvas, [edited(canvas.get('box'), { x: 60 }), unlocked], { clientId: 'c1' }).refused, [])
  assert.equal(boxInfo(canvas.get('in')).lock, null)
  assert.equal(boxInfo(canvas.get('in')).owner.name, 'alice')
  assert.equal(canvas.get('box').x, 60)
  // Undoing the unlock gives the lock back to the box's owner, and only to it.
  const relocked = withMindmapData(edited(canvas.get('in')), { lock: alice })
  applyClientChanges(canvas, [relocked], { clientId: 'c1' })
  assert.deepEqual(boxInfo(canvas.get('in')).lock, alice)
  const unlockedAgain = withMindmapData(edited(canvas.get('in')), { lock: null })
  applyClientChanges(canvas, [unlockedAgain], { clientId: 'c1' })
  applyClientChanges(canvas, [withMindmapData(edited(canvas.get('in')), { lock: { name: 'mallory', lead: 'L' } })], { clientId: 'c1' })
  assert.equal(boxInfo(canvas.get('in')).lock, null)
  await cleanup()
})

test('the page cannot set owners, and a lock change from a page that missed the latest lock is ignored', async () => {
  const { canvas, cleanup } = await scene()
  const frame = canvas.get('out')
  applyClientChanges(canvas, [withMindmapData(edited(frame), { owner: alice, lock: alice })], { clientId: 'c1' })
  assert.deepEqual(boxInfo(canvas.get('out')), { id: 'out', name: 'Out', owner: null, lock: null })
  const seen = canvas.get('out')
  canvas.commit([withMindmapData(revise(seen), { owner: alice, lock: alice, stamp: 's2' })], { origin: 'host' })
  // A page that never saw alice's lock resizes the box: the size applies, the lock stays.
  applyClientChanges(canvas, [{ ...seen, width: 350, version: seen.version + 5 }], { clientId: 'c2' })
  assert.equal(canvas.get('out').width, 300, 'the box is alice\'s, so the resize is refused')
  assert.deepEqual(boxInfo(canvas.get('out')).lock, alice)
  const locked = canvas.get('out')
  applyClientChanges(canvas, [withMindmapData(edited(locked), { lock: 'user' })], { clientId: 'c1' })
  assert.equal(boxInfo(canvas.get('out')).lock, 'user', 'the user may take over a lock')
  assert.notEqual(mindmapData(canvas.get('out')).stamp, 's2')
  const user = canvas.get('out')
  assert.deepEqual(applyClientChanges(canvas, [edited(canvas.get('box'), { x: 450, frameId: 'out' })], { clientId: 'c1' }).refused, [],
    'the user writes in boxes the user locked')
  applyClientChanges(canvas, [{ ...user, width: 380, version: user.version + 1, customData: undefined }], { clientId: 'c1' })
  assert.equal(canvas.get('out').width, 380)
  assert.equal(boxInfo(canvas.get('out')).lock, 'user', 'a page copy without box data keeps the lock it never saw change')
  await cleanup()
})
