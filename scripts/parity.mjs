// Draw one scene with Excalidraw's own export and with the Host renderer, and lay
// the two out side by side, case by case. Run it after upgrading Excalidraw, roughjs
// or perfect-freehand, or after changing src/host/render.js:
//
//   npm run parity [-- --out <dir>]    writes <dir>/parity.png (default: the OS temp dir)
//
// It drives Google Chrome headless; set CHROME to its binary when it is elsewhere.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { Canvas } from '../src/host/canvas.js'
import { defaultCjkFonts, renderScene } from '../src/host/render.js'
import { prepareWrite } from '../src/host/write.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CELL_WIDTH = 240
const CELL_HEIGHT = 180
const COLUMNS = 6
const SCALE = 2

// Each case: a name and its elements, placed relative to the top-left of its cell.
const CASES = [
  ['rect solid', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, backgroundColor: '#a5d8ff', fillStyle: 'solid' }]],
  ['rect round hachure', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, backgroundColor: '#ffc9c9', roundness: { type: 3 } }]],
  ['ellipse cross-hatch', [{ type: 'ellipse', x: 30, y: 40, width: 180, height: 100, backgroundColor: '#b2f2bb', fillStyle: 'cross-hatch' }]],
  ['diamond zigzag', [{ type: 'diamond', x: 30, y: 30, width: 180, height: 120, backgroundColor: '#ffec99', fillStyle: 'zigzag' }]],
  ['dashed, width 4', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, strokeStyle: 'dashed', strokeWidth: 4, strokeColor: '#1971c2' }]],
  ['dotted, roughness 0', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, strokeStyle: 'dotted', roughness: 0, strokeColor: '#e03131' }]],
  ['roughness 2', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, roughness: 2, backgroundColor: '#d0bfff', fillStyle: 'solid' }]],
  ['opacity 40', [{ type: 'rectangle', x: 30, y: 40, width: 180, height: 100, opacity: 40, backgroundColor: '#e8590c', fillStyle: 'solid' }]],
  ['angle + label', [{ type: 'rectangle', x: 40, y: 50, width: 160, height: 80, angle: 0.5, label: 'Rotated' }]],
  ['CJK label', [{ type: 'ellipse', x: 30, y: 40, width: 180, height: 100, label: '中文标签 mixed' }]],
  ['line open', [{ type: 'line', x: 30, y: 140, points: [[0, 0], [60, -100], [120, -20], [180, -90]], strokeWidth: 2 }]],
  ['line closed, filled', [{ type: 'line', x: 120, y: 30, points: [[0, 0], [90, 120], [-90, 120], [0, 0]], backgroundColor: '#ff8787', fillStyle: 'solid' }]],
  ['curve open', [{ type: 'line', x: 30, y: 140, points: [[0, 0], [60, -100], [120, -20], [180, -90]], roundness: { type: 2 } }]],
  ['curve closed, filled', [{ type: 'line', x: 120, y: 30, points: [[0, 0], [90, 120], [-90, 120], [0, 0]], roundness: { type: 2 }, backgroundColor: '#74c0fc', fillStyle: 'solid' }]],
  ['arrow', [{ type: 'arrow', x: 30, y: 90, points: [[0, 0], [180, 0]] }]],
  ['arrow curved', [{ type: 'arrow', x: 30, y: 140, points: [[0, 0], [90, -100], [180, 0]], roundness: { type: 2 } }]],
  ['heads dot, triangle', [{ type: 'arrow', x: 30, y: 90, points: [[0, 0], [180, 0]], startArrowhead: 'dot', endArrowhead: 'triangle', strokeWidth: 2 }]],
  ['heads bar, circle, diamond, crowfoot', [
    { type: 'arrow', x: 30, y: 60, points: [[0, 0], [180, 0]], startArrowhead: 'bar', endArrowhead: 'circle' },
    { type: 'arrow', x: 30, y: 120, points: [[0, 0], [180, 0]], startArrowhead: 'diamond', endArrowhead: 'crowfoot_many' },
  ]],
  ['bound arrow + label', [
    { type: 'rectangle', id: 'bound-a', x: 15, y: 60, width: 60, height: 60 },
    { type: 'ellipse', id: 'bound-b', x: 165, y: 60, width: 60, height: 60 },
    { type: 'arrow', start: { id: 'bound-a' }, end: { id: 'bound-b' }, label: 'go' },
  ]],
  ['Excalifont', [{ type: 'text', x: 20, y: 60, text: 'Hello 世界 Ag', fontSize: 28 }]],
  ['Nunito', [{ type: 'text', x: 20, y: 60, text: 'Hello 世界 Ag', fontSize: 28, fontFamily: 6 }]],
  ['Comic Shanns', [{ type: 'text', x: 20, y: 60, text: 'Hello 世界 Ag', fontSize: 28, fontFamily: 8 }]],
  ['Helvetica', [{ type: 'text', x: 20, y: 60, text: 'Hello 世界 Ag', fontSize: 28, fontFamily: 2 }]],
  ['Cascadia', [{ type: 'text', x: 20, y: 60, text: 'Hello 世界 Ag', fontSize: 28, fontFamily: 3 }]],
  ['multi-line, centered', [{ type: 'text', x: 40, y: 40, text: 'one\nlonger line\nthree', fontSize: 24, textAlign: 'center' }]],
  ['text angle', [{ type: 'text', x: 40, y: 70, text: 'tilted text', fontSize: 28, angle: 0.3 }]],
  ['freedraw open', [{ type: 'freedraw', x: 30, y: 100, points: Array.from({ length: 40 }, (_, i) => [i * 4.5, Math.sin(i / 4) * 40]) }]],
  ['freedraw closed, filled', [{
    type: 'freedraw', x: 120, y: 40, backgroundColor: '#ffd43b', fillStyle: 'solid',
    points: [...Array.from({ length: 36 }, (_, i) => [Math.sin(i / 36 * 2 * Math.PI) * 70, 50 - Math.cos(i / 36 * 2 * Math.PI) * 50]), [0, 0]],
  }]],
  ['frame clip', [
    { type: 'frame', id: 'frame', name: 'Frame name', x: 30, y: 40, width: 150, height: 110 },
    { type: 'rectangle', x: 120, y: 70, width: 100, height: 50, backgroundColor: '#ffa8a8', fillStyle: 'solid' },
  ]],
  ['colors + widths', [
    { type: 'ellipse', x: 30, y: 40, width: 80, height: 80, strokeColor: '#2f9e44', strokeWidth: 1, backgroundColor: '#ebfbee', fillStyle: 'solid' },
    { type: 'ellipse', x: 130, y: 40, width: 80, height: 80, strokeColor: '#c2255c', strokeWidth: 4, backgroundColor: '#fff0f6', fillStyle: 'solid' },
  ]],
]

/** The cases laid out on a grid through the agents' write path, so both sides draw what agents make. */
async function buildScene(dir) {
  const canvas = new Canvas({ workspaceId: 'parity', workspacePath: dir, name: 'parity' })
  canvas.sessionId = 'parity'
  const width = COLUMNS * CELL_WIDTH
  const height = Math.ceil(CASES.length / COLUMNS) * CELL_HEIGHT
  // Two dots pin Excalidraw's export bounds to the grid, so its image starts at (0, 0).
  const elements = [
    { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, strokeColor: 'transparent' },
    { type: 'rectangle', x: width - 1, y: height - 1, width: 1, height: 1, strokeColor: 'transparent' },
  ]
  const cells = CASES.map(([name, items], index) => {
    const x = (index % COLUMNS) * CELL_WIDTH
    const y = Math.floor(index / COLUMNS) * CELL_HEIGHT
    for (const item of items) {
      elements.push({ ...item, ...(item.x === undefined ? {} : { x: item.x + x }), ...(item.y === undefined ? {} : { y: item.y + y }) })
    }
    return { name, x, y }
  })
  const { changes } = prepareWrite(canvas, { name: 'lead', lead: 'parity', sessionId: 'parity' }, { elements })
  canvas.commit(changes, { origin: 'parity' })
  await canvas.flush()
  return { elements: canvas.ordered().filter(element => !element.isDeleted), cells }
}

/** Each cell drawn by the Host renderer, with the rows it leaves above the cell for box titles. */
function renderCells(elements, cells) {
  const fontFiles = defaultCjkFonts()
  return cells.map(cell => {
    const out = renderScene({ elements }, {
      region: { x1: cell.x, y1: cell.y, x2: cell.x + CELL_WIDTH, y2: cell.y + CELL_HEIGHT }, padding: 0, scale: SCALE, fontFiles,
    })
    return { ...cell, host: `data:image/png;base64,${out.png.toString('base64')}`, top: (cell.y - out.region.y1) * SCALE }
  })
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2' }

/** Serve `dir`, and the plugin's assets under /assets/, on a free local port. */
function serve(dir) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    try {
      const body = await readFile(path.startsWith('/assets/') ? join(root, path) : join(dir, path))
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function until(probe, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** A minimal DevTools Protocol client for one page. */
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map()
  let nextId = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++nextId, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id: nextId, method, params }))
  })
  return { send, close: () => socket.close() }
}

/** Open the page in a fresh headless Chrome and return the sheet it composes. */
async function composeInChrome(url, profile) {
  const chrome = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  const exited = new Promise(resolve => chrome.once('exit', resolve))
  try {
    const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0], 'Chrome')
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.type === 'page')
    const cdp = await connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.navigate', { url })
    const result = await until(async () => (await cdp.send('Runtime.evaluate', { expression: 'window.__result', returnByValue: true })).result.value, 'the Excalidraw export')
    cdp.close()
    if (result.error) throw new Error(result.error)
    return Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64')
  } finally {
    chrome.kill()
    await exited
  }
}

const { values: options } = parseArgs({ options: { out: { type: 'string', default: join(tmpdir(), 'mindmap-parity') } } })
const work = await mkdtemp(join(tmpdir(), 'mindmap-parity-work-'))
try {
  const { elements, cells } = await buildScene(work)
  const scene = { elements, cells: renderCells(elements, cells), scale: SCALE, cellWidth: CELL_WIDTH, cellHeight: CELL_HEIGHT }
  await writeFile(join(work, 'scene.json'), JSON.stringify(scene))
  await writeFile(join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="page.js"></script>\n')
  await build({
    entryPoints: [join(root, 'scripts/parity-page.js')],
    outfile: join(work, 'page.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    conditions: ['production'],
    target: ['es2022'],
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logLevel: 'warning',
  })
  const server = await serve(work)
  try {
    const sheet = await composeInChrome(`http://127.0.0.1:${server.address().port}/index.html`, join(work, 'chrome'))
    await mkdir(options.out, { recursive: true })
    await writeFile(join(options.out, 'parity.png'), sheet)
    console.log(`${CASES.length} cases: ${join(options.out, 'parity.png')} (left of each pair Excalidraw, right the Host renderer)`)
  } finally {
    server.close()
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
