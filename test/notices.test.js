import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Canvas } from '../src/host/canvas.js'
import { UserEdits } from '../src/host/notices.js'
import { prepareWrite } from '../src/host/write.js'

const lead = { name: 'lead', lead: 'L', sessionId: 'L' }
const pelican = { name: 'pelican', lead: 'L', sessionId: 'S-pelican' }

/** Box "Pelican" held by teammate pelican with a beak in it, watched for the user's changes. */
async function scene() {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-edits-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'zoo' })
  canvas.setSession('L')
  const edits = new UserEdits()
  edits.watch(canvas)
  const write = (writer, args) => canvas.commit(prepareWrite(canvas, writer, args).changes, { origin: `agent:${writer.sessionId}` })
  write(lead, { elements: [{ type: 'frame', id: 'b1', name: 'Pelican', x: 0, y: 0, width: 300, height: 200 }] })
  write(pelican, { elements: [{ id: 'b1', lock: true }, { type: 'rectangle', id: 'beak', x: 40, y: 40, width: 60, height: 40 }] })
  // What the user draws arrives from a canvas page, already in full Excalidraw form.
  const draw = (id, x, y, text) => {
    const { changes } = prepareWrite(canvas, lead, { elements: [{ type: 'text', id, x, y, text }] })
    canvas.commit(changes, { origin: 'client:page' })
  }
  return { canvas, edits, write, draw, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("an agent hears of the user's note beside its box at its next canvas call, once", async () => {
  const { canvas, edits, draw, cleanup } = await scene()
  assert.equal(edits.since(canvas, pelican), null, 'the first call only marks where it starts')
  draw('hint', 20, 260, 'the beak is orange')
  const line = edits.since(canvas, pelican)
  assert.match(line, /beside your box "Pelican": note "hint"/)
  assert.match(line, /keep it, and follow it only if it is meant for you/)
  assert.doesNotMatch(line, /orange/, 'it says where to look, not what the note says')
  assert.equal(edits.since(canvas, pelican), null)
  await cleanup()
})

test("the user's drafting away from an agent's boxes, a new box beside it, and agents' writes are not reported", async () => {
  const { canvas, edits, write, draw, cleanup } = await scene()
  edits.since(canvas, pelican)
  edits.since(canvas, lead)
  draw('draft', 900, 600, 'region B: harbour?')
  const { changes } = prepareWrite(canvas, lead, { elements: [{ type: 'frame', id: 'b2', name: 'Heron', x: 360, y: 0, width: 300, height: 200 }] })
  canvas.commit(changes, { origin: 'client:page' })
  write(pelican, { elements: [{ type: 'ellipse', id: 'eye', x: 150, y: 50, width: 20, height: 20 }] })
  assert.equal(edits.since(canvas, pelican), null)
  assert.equal(edits.since(canvas, lead), null, 'the lead owns no box here, so nothing is its to hear')
  await cleanup()
})

test('a change the user makes inside the box, such as removing an element, is reported as removed', async () => {
  const { canvas, edits, cleanup } = await scene()
  edits.since(canvas, pelican)
  const beak = canvas.get('beak')
  canvas.commit([{ ...beak, isDeleted: true, version: beak.version + 1 }], { origin: 'client:page' })
  assert.match(edits.since(canvas, pelican), /removed rectangle "beak"/)
  await cleanup()
})
