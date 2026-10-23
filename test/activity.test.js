import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withMindmapData } from '../src/shared/scene.js'
import { CanvasActivity, narration } from '../src/host/activity.js'
import { Canvas } from '../src/host/canvas.js'
import { revise } from '../src/host/elements.js'
import { prepareWrite } from '../src/host/write.js'

// The canvas lead's Session is "L" and alice ("A") its teammate; "X" is a Session outside the Team.
const lead = { name: 'lead', lead: 'L', sessionId: 'L' }
const alice = { name: 'alice', lead: 'L', sessionId: 'A' }
const outsider = { name: 'lead', lead: 'X', sessionId: 'X' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-activity-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'test' })
  canvas.sessionId = 'L'
  const write = (request, writer = lead) => {
    const prepared = prepareWrite(canvas, writer, request)
    canvas.commit(prepared.changes, { origin: 'test' })
    return prepared.report
  }
  write({ elements: [{ type: 'frame', id: 'box', name: 'Box 1', x: 100, y: 100, width: 300, height: 200 }] })
  canvas.commit([withMindmapData(revise(canvas.get('box')), { owner: alice, lock: alice })], { origin: 'test' })
  const writers = new Map([['L', lead], ['A', alice], ['X', outsider]])
  const activity = new CanvasActivity({
    canvases: { byLead: id => (id === 'L' ? canvas : undefined) },
    team: { writerOf: agent => writers.get(agent.id) },
    agents: { get: id => (writers.has(id) ? { id } : undefined) },
  })
  const published = []
  activity.subscribe(canvas, agents => published.push(agents))
  const event = (sessionId, type, data = {}) => activity.noteEvent({ id: sessionId }, { type, data })
  return { canvas, write, activity, published, event, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('a teammate thinks in its box, says what it does, uses tools and leaves when its turn ends', async () => {
  const { canvas, activity, published, event, cleanup } = await setup()
  try {
    event('A', 'turn/start', { turn: 1 })
    let [state] = activity.snapshot(canvas)
    assert.equal(state.name, 'alice')
    assert.equal(state.phase, 'thinking')
    assert.deepEqual(state.at, { x: 124, y: 124 }, 'it starts inside the box it holds')

    event('A', 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '## Drawing the **wheels** now\nmore' }] } })
    event('A', 'tool/call', { name: 'bash', arguments: '{"command":"ls"}' })
    ;[state] = activity.snapshot(canvas)
    assert.equal(state.text, 'Drawing the wheels now')
    assert.deepEqual(state.action, { kind: 'tool', name: 'bash' })
    assert.equal(state.phase, 'acting')
    assert.equal(state.seq, 2)

    event('A', 'step/start', { turn: 1, step: 2 })
    ;[state] = activity.snapshot(canvas)
    assert.equal(state.phase, 'thinking')
    assert.equal(state.text, 'Drawing the wheels now', 'what it said stays while it thinks')
    event('A', 'assistant/message', { message: { content: [{ type: 'tool-call' }] } })
    ;[state] = activity.snapshot(canvas)
    assert.equal(state.text, null, 'until it speaks again')

    event('A', 'assistant/message', { message: { content: [{ type: 'text', text: 'Asking the lead' }] } })
    event('A', 'tool/call', { name: 'send_message', arguments: '{"target":"lead","message":"**Box 2** is too small?\\nmore"}' })
    ;[state] = activity.snapshot(canvas)
    assert.deepEqual(state.action, { kind: 'message', to: 'lead', text: 'Box 2 is too small?' }, 'a message shows its first line')
    assert.equal(state.text, null, 'in place of what it said with it')

    event('A', 'turn/end', { turn: 1 })
    assert.equal(published.at(-1)[0].phase, 'idle', 'pages see it finish once')
    assert.deepEqual(activity.snapshot(canvas), [])
  } finally {
    await cleanup()
  }
})

test('canvas tools place the cursor and say what was read or drawn', async () => {
  const { canvas, write, activity, event, cleanup } = await setup()
  try {
    event('A', 'turn/start', { turn: 1 })
    activity.noteLook(canvas, alice, 'A', 'view', canvas.get('box'))
    let [state] = activity.snapshot(canvas)
    assert.deepEqual(state.action, { kind: 'view', box: 'Box 1' })

    const request = {
      elements: [
        { type: 'rectangle', id: 'r', x: 120, y: 120, width: 40, height: 40 },
        { type: 'ellipse', id: 'e', x: 200, y: 200, width: 40, height: 40 },
        { id: 'box', lock: true },
      ],
    }
    activity.noteWrite(canvas, alice, 'A', request, write(request, alice))
    ;[state] = activity.snapshot(canvas)
    assert.deepEqual(state.action, { kind: 'write', copied: 0, moved: 0, drew: 2, changed: 0, deleted: 0, locked: ['Box 1'], unlocked: [] })
    assert.deepEqual(state.at, { x: 180, y: 180 }, 'the cursor goes to the middle of what it drew')
    assert.deepEqual(state.ids.sort(), ['box', 'e', 'r'])

    activity.noteLook(canvas, alice, 'A', 'read', canvas.get('box'))
    ;[state] = activity.snapshot(canvas)
    assert.deepEqual(state.at, { x: 180, y: 180 }, 'looking at the box it works in leaves the cursor where it is')
    assert.deepEqual(state.ids.sort(), ['box', 'e', 'r'], 'and what it drew stays outlined')

    const copy = { copy: [{ ids: ['r', 'e'], x: 250, y: 120, prefix: 'c-' }] }
    activity.noteWrite(canvas, alice, 'A', copy, write(copy, alice))
    ;[state] = activity.snapshot(canvas)
    assert.equal(state.action.copied, 1)
    assert.equal(state.action.drew, 0, 'copied elements are not counted as drawn')
  } finally {
    await cleanup()
  }
})

test('Sessions outside the canvas Team show only while they use the canvas tools on it', async () => {
  const { canvas, write, activity, event, cleanup } = await setup()
  try {
    event('X', 'turn/start', { turn: 1 })
    assert.deepEqual(activity.snapshot(canvas), [], 'an unrelated Session is not shown')
    const request = { elements: [{ type: 'text', id: 't', x: 500, y: 500, text: 'note' }] }
    activity.noteWrite(canvas, outsider, 'X', request, write(request, outsider))
    assert.equal(activity.snapshot(canvas).length, 1)
    event('X', 'turn/end', { turn: 1 })
    assert.deepEqual(activity.snapshot(canvas), [])
  } finally {
    await cleanup()
  }
})

test('narration keeps the first line of what the agent wrote, cut to a label', () => {
  assert.equal(narration({ content: [{ type: 'tool-call' }] }), null)
  assert.equal(narration({ content: [{ type: 'text', text: '\n\n  first  line \nsecond' }] }), 'first line')
  assert.equal(narration({ content: [{ type: 'text', text: 'x'.repeat(200) }] }).length, 80)
})
