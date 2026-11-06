import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Canvas } from '../src/host/canvas.js'
import { createFromInput } from '../src/host/elements.js'
import { renderScene, xiaolaiFiles } from '../src/host/render.js'
import { prepareWrite } from '../src/host/write.js'

const fills = svg => [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map(match => match[1])

test('closed lines and freedraw are filled with their backgroundColor, as Excalidraw draws them', async () => {
  const element = input => createFromInput(input, () => undefined)[0]
  const triangle = [[0, 0], [40, 0], [20, 30], [0, 0]]
  const draw = async input => fills((await renderScene({ elements: [element({ x: 0, y: 0, backgroundColor: '#ff0000', fillStyle: 'solid', ...input })] })).svg)
  assert.ok((await draw({ type: 'line', points: triangle })).includes('#ff0000'))
  assert.ok((await draw({ type: 'line', points: triangle, roundness: { type: 2 } })).includes('#ff0000'), 'curved too')
  assert.ok((await draw({ type: 'freedraw', points: triangle })).includes('#ff0000'))
  assert.ok(!(await draw({ type: 'line', points: [[0, 0], [40, 0], [20, 30]] })).includes('#ff0000'), 'an open line is not filled')
})

test('opacity fades each fill and stroke on its own, as Excalidraw draws them', async () => {
  const [element] = createFromInput({ type: 'rectangle', x: 0, y: 0, width: 40, height: 30, opacity: 40, backgroundColor: '#ff0000', fillStyle: 'solid' }, () => undefined)
  const { svg } = await renderScene({ elements: [element] })
  assert.match(svg, /fill-opacity="0\.4" stroke-opacity="0\.4"/)
  assert.doesNotMatch(svg, / opacity="0\.4"/)
})

test('CJK in Excalifont text is drawn with the Xiaolai subsets holding it, as in Excalidraw', async () => {
  const text = (fontFamily, value) => createFromInput({ type: 'text', x: 0, y: 0, text: value, fontFamily }, () => undefined)[0]
  const files = xiaolaiFiles([text(5, '中文标签 mixed')])
  assert.ok(files.length > 0 && files.every(file => existsSync(file)))
  assert.deepEqual(xiaolaiFiles([text(5, 'latin only')]), [])
  assert.deepEqual(xiaolaiFiles([text(6, '中文标签')]), [], 'other families use a system CJK face, as in the browser')
  assert.match((await renderScene({ elements: [text(5, '中文')] })).svg, /font-family="Xiaolai SC, /)
})

test('arrows draw every arrowhead and leave a gap where their label sits, as Excalidraw does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-render-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'render' })
  const heads = ['arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']
  const { changes } = prepareWrite(canvas, { name: 'lead', lead: 'L', sessionId: 'L' }, {
    elements: heads.map((head, index) => ({ type: 'arrow', x: 0, y: index * 30, points: [[0, 0], [100, 0]], startArrowhead: head, endArrowhead: head, ...(index === 0 ? { label: 'go' } : {}) })),
  })
  canvas.commit(changes, { origin: 'test' })
  const { svg } = await renderScene({ elements: canvas.ordered() })
  assert.equal((svg.match(/<mask /g) ?? []).length, 1, 'only the labelled arrow is masked')
  const label = canvas.ordered().find(element => element.type === 'text')
  assert.ok(svg.includes(`<rect x="${label.x}" y="${label.y}"`), 'the gap is the label box')
  await rm(dir, { recursive: true, force: true })
})

test('rendering leaves the Host free to serve others', async () => {
  const [text] = createFromInput({ type: 'text', x: 0, y: 0, text: 'free', fontFamily: 6 }, () => undefined)
  let served = false
  setImmediate(() => { served = true })
  const { png } = await renderScene({ elements: [text] })
  assert.ok(served, 'the event loop ran during the render')
  assert.ok(png.length > 0)
})
