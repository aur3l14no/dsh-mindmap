// Routes of the canvas UI. Authenticated owner routes carry workspaces, scenes,
// box teammates and a live event stream; one public prefix serves Excalidraw's fonts.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBox } from '../shared/scene.js'
import { supersedes } from './canvas.js'
import { MindmapError } from './canvases.js'
import { randomSeed } from './elements.js'
import { settleUserBox, userChangeBlockedBy } from './locks.js'

export const API = '/api/mindmap'
export const ASSET_PREFIX = '/dsh-mindmap-assets'
const ASSET_DIR = fileURLToPath(new URL('../../assets/excalidraw/', import.meta.url))
// The event stream pings this often, so the canvas UI notices a stream that went quiet.
const PING_MS = 20_000
const CONTENT_TYPES = { '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

/**
 * Apply element changes sent by a canvas page. Changes Excalidraw would not
 * accept as newer are answered with the current copy; changes inside boxes an
 * agent holds are refused and the current copy is re-issued above them; box
 * owners and locks the page may not set are corrected. Every correction goes
 * to all pages, the sender included.
 * @returns `{ rev, refused }`; each refusal names the element and the box that refused it.
 */
export function applyClientChanges(canvas, elements, { clientId, files } = {}) {
  const accepted = []
  const corrections = []
  const refused = []
  const frames = new Map(canvas.boxes().map(frame => [frame.id, frame]))
  // Boxes first, so a lock lifted in this batch frees the edits that follow it.
  const ordered = [...elements].sort((a, b) => Number(b?.type === 'frame') - Number(a?.type === 'frame'))
  for (const element of ordered) {
    if (!element || typeof element.id !== 'string' || typeof element.type !== 'string' || typeof element.version !== 'number') {
      throw new MindmapError('each element needs a string "id" and "type" and a numeric "version"')
    }
    const current = canvas.elements.get(element.id)
    if (current && !supersedes(element, current)) {
      corrections.push(current)
      continue
    }
    const before = current && !current.isDeleted ? current : undefined
    const boxId = userChangeBlockedBy([...frames.values()], before, element)
    if (boxId) {
      refused.push({ id: element.id, boxId })
      corrections.push(canvas.reassert(element.id, element.version, element))
      continue
    }
    let kept = element.type === 'frame' ? settleUserBox(before, element) : element
    if (kept !== element) kept = { ...kept, version: element.version + 1, versionNonce: randomSeed() }
    if (kept.type === 'frame') {
      if (isBox(kept)) frames.set(kept.id, kept)
      else frames.delete(kept.id)
    }
    if (kept === element) accepted.push(element)
    else corrections.push(kept)
  }
  const usedFiles = files && Object.fromEntries(Object.entries(files).filter(([id, file]) => typeof file?.dataURL === 'string' && file.id === id))
  if (accepted.length > 0 || (usedFiles && Object.keys(usedFiles).length > 0)) {
    canvas.commit(accepted, { origin: `client:${clientId ?? 'unknown'}`, files: usedFiles })
  }
  if (corrections.length > 0) canvas.commit(corrections, { origin: 'host' })
  return { rev: canvas.rev, refused }
}

/** Register the routes; `mindmap` holds `canvases`, `team`, `activity` and `workspaces`. */
export function registerRoutes(ctx, mindmap) {
  const { canvases, team } = mindmap

  const route = (path, methods, handle) => ctx.connection.fetch.register({
    path: `${API}${path}`,
    methods,
    requestBody: 'buffered',
    async fetch(request) {
      try {
        return await handle(request, new URL(request.url))
      } catch (error) {
        if (error instanceof MindmapError) return json(error.status, { error: error.message })
        ctx.logger.warn(`mindmap: ${request.method} ${path} failed: ${error.stack ?? error}`)
        return json(500, { error: error.message })
      }
    },
  })
  const body = async request => {
    try {
      return await request.json()
    } catch {
      throw new MindmapError('the request body must be JSON')
    }
  }
  const canvasOf = params => canvases.open(String(params.workspaceId ?? ''), String(params.name ?? ''))
  const query = url => Object.fromEntries(url.searchParams)

  route('/workspaces', ['GET'], async () => {
    const workspaces = await Promise.all(mindmap.workspaces.list().map(async workspace => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      canvases: await canvases.names(workspace.id).catch(() => []),
    })))
    return json(200, { workspaces })
  })

  route('/canvases', ['POST'], async request => {
    const { workspaceId, name } = await body(request)
    const canvas = await canvases.create(String(workspaceId ?? ''), typeof name === 'string' ? name.trim() : name)
    await team.ensureLead(canvas)
    return json(200, { name: canvas.name })
  })

  route('/scene', ['GET', 'POST'], async (request, url) => {
    if (request.method === 'GET') {
      const canvas = await canvasOf(query(url))
      const sessionId = await team.ensureLead(canvas)
      return json(200, { ...canvas.snapshot(), sessionId, teams: team.teams !== undefined, activity: mindmap.activity.snapshot(canvas) })
    }
    const params = await body(request)
    const canvas = await canvasOf(params)
    if (!Array.isArray(params.elements)) throw new MindmapError('"elements" must be an array')
    return json(200, applyClientChanges(canvas, params.elements, { clientId: params.clientId, files: params.files }))
  })

  route('/member', ['POST'], async request => {
    const params = await body(request)
    const canvas = await canvasOf(params)
    const member = await team.spawnMember(canvas, String(params.boxId ?? ''), params.instruction)
    return json(200, { member })
  })

  ctx.connection.fetch.register({
    path: `${API}/events`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const params = query(new URL(request.url))
      let canvas
      try {
        canvas = await canvasOf(params)
      } catch (error) {
        return json(error.status ?? 500, { error: error.message })
      }
      const encoder = new TextEncoder()
      let cleanup = () => {}
      const stream = new ReadableStream({
        start(controller) {
          const send = (event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          const onChange = change => {
            if (change.origin === `client:${params.clientId}`) return send('rev', { rev: change.rev })
            send('change', { elements: change.elements, files: change.files ?? null, rev: change.rev, origin: change.origin })
          }
          canvas.on('change', onChange)
          const stopActivity = mindmap.activity.subscribe(canvas, agents => send('activity', { agents }))
          const ping = setInterval(() => send('ping', {}), PING_MS)
          cleanup = () => {
            cleanup = () => {}
            clearInterval(ping)
            canvas.off('change', onChange)
            stopActivity()
            try {
              controller.close()
            } catch {}
          }
          request.signal.addEventListener('abort', () => cleanup(), { once: true })
          send('ready', { rev: canvas.rev })
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler(req, res) {
      const relative = decodeURIComponent(new URL(req.url, 'http://local').pathname.slice(ASSET_PREFIX.length + 1))
      const file = normalize(join(ASSET_DIR, relative))
      if (!file.startsWith(ASSET_DIR) || file.includes(`${sep}..`) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=604800, immutable',
        'access-control-allow-origin': '*',
      })
      createReadStream(file).pipe(res)
    },
  }), 'mindmap: Excalidraw fonts')
}
