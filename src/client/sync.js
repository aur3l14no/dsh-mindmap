// Keeps one Excalidraw scene in step with the Host's copy of a canvas. Local
// edits go to the Host as Excalidraw element revisions and may be refused
// (boxes an agent holds); Host changes arrive as server-sent events and merge
// through Excalidraw's own reconciliation, outside the local undo history.
import { CaptureUpdateAction, reconcileElements } from '@excalidraw/excalidraw'
import { isBox, lockedAgainst, touchesBox } from '../shared/scene.js'
import { api, eventsUrl } from './api.js'

const SEND_DELAY_MS = 120
// The Host pings every 20 s; a stream silent for longer is reopened and the scene re-read.
const QUIET_MS = 60_000
const WATCH_MS = 15_000

function supersedes(incoming, current) {
  if (!current) return true
  if (incoming.version !== current.version) return incoming.version > current.version
  return incoming.versionNonce < current.versionNonce
}

/** Boxes an agent holds, which the user cannot change until they lift the lock. */
export function agentLockedBoxes(elements) {
  return elements.filter(element => isBox(element) && lockedAgainst(element, 'user'))
}

const sameBoxes = (a, b) => a.length === b.length
  && a.every((frame, index) => frame.id === b[index].id && frame.version === b[index].version)

export class SceneSync {
  /**
   * @param handlers - `onRefused(refusals)`, each `{ id, boxId }`, `onConnection(online)` and
   *   `onActivity(agents)`, what the agents at work are doing.
   */
  constructor(workspaceId, name, handlers) {
    this.workspaceId = workspaceId
    this.name = name
    this.handlers = handlers
    this.clientId = crypto.randomUUID()
    this.host = new Map()
    this.knownFiles = new Set()
    this.pending = new Map()
    this.pendingFiles = new Map()
    this.locked = []
    this.excalidraw = null
    this.timer = null
    this.sending = null
    this.events = null
    this.heard = 0
    this.watch = null
    this.disposed = false
  }

  /** Fetch the scene; returns Excalidraw initial data plus the canvas lead Session and the agents at work. */
  async load() {
    const scene = await api('scene', { query: { workspaceId: this.workspaceId, name: this.name } })
    for (const element of scene.elements) this.host.set(element.id, element)
    for (const id of Object.keys(scene.files ?? {})) this.knownFiles.add(id)
    this.locked = agentLockedBoxes(scene.elements)
    return {
      elements: scene.elements.map(element => this.display(element)),
      files: scene.files,
      appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor ?? '#ffffff' },
      sessionId: scene.sessionId,
      teams: scene.teams,
      activity: scene.activity ?? [],
    }
  }

  attach(excalidraw) {
    this.excalidraw = excalidraw
    this.connect(false)
    this.watch = setInterval(() => {
      if (this.events.readyState !== EventSource.CONNECTING && Date.now() - this.heard > QUIET_MS) {
        this.events.close()
        this.connect(true)
      }
    }, WATCH_MS)
  }

  /** Open the event stream; `resync` re-reads the scene once connected, for changes missed meanwhile. */
  connect(resync) {
    const source = new EventSource(eventsUrl({ workspaceId: this.workspaceId, name: this.name, clientId: this.clientId }))
    this.events = source
    this.heard = Date.now()
    const heard = () => { this.heard = Date.now() }
    source.addEventListener('ready', () => {
      heard()
      this.handlers.onConnection(true)
      if (resync) this.resync().catch(() => {})
      resync = true
    })
    source.addEventListener('ping', heard)
    source.addEventListener('activity', event => {
      heard()
      this.handlers.onActivity(JSON.parse(event.data).agents)
    })
    source.addEventListener('rev', heard)
    source.addEventListener('change', event => {
      heard()
      const change = JSON.parse(event.data)
      if (change.files) this.addFiles(change.files)
      this.applyRemote(change.elements)
    })
    source.onerror = () => this.handlers.onConnection(false)
  }

  dispose() {
    this.disposed = true
    clearInterval(this.watch)
    this.events?.close()
    clearTimeout(this.timer)
    if (this.pending.size > 0) this.send().catch(() => {})
  }

  /**
   * The element as the canvas shows it: boxes an agent holds, and what lies in them, are locked.
   * Always a copy, since Excalidraw mutates its elements in place and `host` must keep the Host's revision.
   */
  display(element) {
    return this.isProtected(element) && !element.locked ? { ...element, locked: true } : { ...element }
  }

  isProtected(element) {
    if (element.isDeleted) return false
    if (element.type === 'frame') return this.locked.some(frame => frame.id === element.id)
    return this.locked.some(frame => touchesBox(element, frame))
  }

  /** Called from Excalidraw's onChange with every element, deleted ones included. */
  noteLocalChange(elements, files) {
    for (const element of elements) {
      const known = this.host.get(element.id)
      if (known && element.version <= known.version) continue
      this.pending.set(element.id, element)
    }
    for (const file of Object.values(files ?? {})) {
      if (!this.knownFiles.has(file.id) && file.dataURL) this.pendingFiles.set(file.id, file)
    }
    if ((this.pending.size > 0 || this.pendingFiles.size > 0) && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.send().catch(() => {})
      }, SEND_DELAY_MS)
    }
    const next = agentLockedBoxes(elements)
    if (!sameBoxes(next, this.locked)) {
      this.locked = next
      this.refreshDisplay()
    }
  }

  /** Send pending edits now; resolves once the Host has answered. */
  async flush() {
    clearTimeout(this.timer)
    this.timer = null
    await this.send()
  }

  async send() {
    if (this.sending) {
      await this.sending
      if (this.pending.size === 0 && this.pendingFiles.size === 0) return
    }
    if (this.pending.size === 0 && this.pendingFiles.size === 0) return
    // Snapshots, as Excalidraw keeps mutating its own elements. The Host keeps its own `locked`
    // for elements the canvas shows locked only because an agent holds their box.
    const elements = [...this.pending.values()].map(element => this.isProtected(element)
      ? { ...element, locked: this.host.get(element.id)?.locked ?? false } : { ...element })
    const files = Object.fromEntries(this.pendingFiles)
    this.pending.clear()
    this.pendingFiles.clear()
    for (const element of elements) this.host.set(element.id, element)
    for (const id of Object.keys(files)) this.knownFiles.add(id)
    this.sending = api('scene', {
      method: 'POST',
      body: { workspaceId: this.workspaceId, name: this.name, clientId: this.clientId, elements, files },
    }).then(result => {
      if (result.refused.length > 0) this.handlers.onRefused(result.refused)
    }, error => {
      // Keep the edits for the next attempt unless something newer arrived meanwhile.
      for (const element of elements) {
        if (!this.pending.has(element.id) && this.host.get(element.id) === element) {
          this.host.delete(element.id)
          this.pending.set(element.id, element)
        }
      }
      for (const [id, file] of Object.entries(files)) {
        this.knownFiles.delete(id)
        this.pendingFiles.set(id, file)
      }
      if (!this.disposed && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.send().catch(() => {}) }, 2000)
      throw error
    }).finally(() => {
      this.sending = null
    })
    await this.sending
  }

  addFiles(files) {
    const fresh = Object.values(files).filter(file => !this.knownFiles.has(file.id))
    for (const file of fresh) this.knownFiles.add(file.id)
    if (fresh.length > 0) this.excalidraw?.addFiles(fresh)
  }

  applyRemote(elements) {
    const fresh = []
    for (const element of elements) {
      if (!supersedes(element, this.host.get(element.id))) continue
      this.host.set(element.id, element)
      fresh.push(element)
    }
    if (fresh.length === 0 || !this.excalidraw) return
    const local = this.excalidraw.getSceneElementsIncludingDeleted()
    this.locked = agentLockedBoxes([...new Map([...local, ...fresh].map(element => [element.id, element])).values()])
    const merged = reconcileElements(local, fresh.map(element => this.display(element)), this.excalidraw.getAppState())
    this.excalidraw.updateScene({ elements: merged.map(element => this.redisplay(element)), captureUpdate: CaptureUpdateAction.NEVER })
  }

  /** Re-derive the lock overlay of one element from the Host copy and the agent-held boxes. */
  redisplay(element) {
    if (this.isProtected(element)) return element.locked ? element : { ...element, locked: true }
    const known = this.host.get(element.id)
    if (known && known.version === element.version && known.locked !== element.locked) return { ...element, locked: known.locked }
    return element
  }

  refreshDisplay() {
    if (!this.excalidraw) return
    const local = this.excalidraw.getSceneElementsIncludingDeleted()
    this.locked = agentLockedBoxes(local)
    let changed = false
    const next = local.map(element => {
      const shown = this.redisplay(element)
      if (shown !== element) changed = true
      return shown
    })
    if (changed) this.excalidraw.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
  }

  /** After a reconnect, take the Host's scene, including deletions missed meanwhile. */
  async resync() {
    const scene = await api('scene', { query: { workspaceId: this.workspaceId, name: this.name } })
    this.addFiles(scene.files ?? {})
    const live = new Set(scene.elements.map(element => element.id))
    const vanished = this.excalidraw.getSceneElementsIncludingDeleted()
      .filter(element => !element.isDeleted && this.host.has(element.id) && !live.has(element.id) && !this.pending.has(element.id))
      .map(element => ({ ...element, isDeleted: true, version: element.version + 1 }))
    this.applyRemote([...scene.elements, ...vanished])
    this.refreshDisplay()
  }

  /**
   * Replace elements locally as a user edit (recorded for undo), e.g. to name
   * or lock a box; the change is sent like any other.
   */
  editElements(replacements) {
    if (!this.excalidraw) return
    const byId = new Map(replacements.map(element => [element.id, element]))
    const elements = this.excalidraw.getSceneElementsIncludingDeleted().map(element => byId.get(element.id) ?? element)
    this.excalidraw.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }
}
