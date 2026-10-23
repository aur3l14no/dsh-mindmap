// One canvas: its Excalidraw scene held by the Host as the source of truth,
// saved as a standard `.excalidraw` file under `<workspace>/.mindmaps/<name>/`.
// The file also names the canvas's lead Session (`mindmap.sessionId`).
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateNKeysBetween } from 'fractional-indexing'
import { isBox } from '../shared/scene.js'
import { randomSeed } from './elements.js'

export const CANVAS_FILE = 'canvas.excalidraw'
const SAVE_DELAY_MS = 400

/** Whether `incoming` supersedes `current` under Excalidraw's reconciliation rule. */
export function supersedes(incoming, current) {
  if (!current) return true
  if (incoming.version !== current.version) return incoming.version > current.version
  return incoming.versionNonce < current.versionNonce
}

export class Canvas extends EventEmitter {
  constructor({ workspaceId, workspacePath, name }) {
    super()
    this.workspaceId = workspaceId
    this.workspacePath = workspacePath
    this.name = name
    this.dir = join(workspacePath, '.mindmaps', name)
    this.file = join(this.dir, CANVAS_FILE)
    this.elements = new Map()
    this.files = {}
    this.appState = { viewBackgroundColor: '#ffffff' }
    /** The canvas's lead Session: the conversation of the canvas and the Team Lead of its agents. */
    this.sessionId = null
    this.rev = 0
    this.saveTimer = null
    this.saving = Promise.resolve()
  }

  get key() {
    return `${this.workspaceId}/${this.name}`
  }

  async load() {
    if (!existsSync(this.file)) return this
    const data = JSON.parse(await readFile(this.file, 'utf8'))
    if (data.type !== 'excalidraw' || !Array.isArray(data.elements)) {
      throw new Error(`${this.file} is not an Excalidraw scene`)
    }
    for (const element of data.elements) this.elements.set(element.id, element)
    this.files = data.files ?? {}
    this.appState = { ...this.appState, ...(data.appState ?? {}) }
    this.sessionId = data.mindmap?.sessionId ?? null
    this.repairIndices()
    return this
  }

  /** Create the canvas directory with an empty scene. */
  async create() {
    await mkdir(join(this.dir, 'exports'), { recursive: true })
    if (!existsSync(this.file)) await this.writeNow()
    return this
  }

  repairIndices() {
    const ordered = this.ordered(true)
    let previous = null
    const broken = []
    for (const element of ordered) {
      if (typeof element.index === 'string' && (previous === null || element.index > previous)) {
        if (broken.length > 0) this.reindex(broken, previous === null ? null : previous, element.index)
        broken.length = 0
        previous = element.index
      } else {
        broken.push(element)
      }
    }
    if (broken.length > 0) this.reindex(broken, previous, null)
  }

  reindex(elements, after, before) {
    const keys = generateNKeysBetween(after, before, elements.length)
    elements.forEach((element, index) => this.elements.set(element.id, { ...element, index: keys[index] }))
  }

  /** Elements in z-order. Deleted tombstones are included only when asked. */
  ordered(includeDeleted = false) {
    const list = [...this.elements.values()].filter(element => includeDeleted || !element.isDeleted)
    return list.sort((a, b) => (a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : 0)
  }

  get(id) {
    const element = this.elements.get(id)
    return element && !element.isDeleted ? element : undefined
  }

  boxes() {
    return this.ordered().filter(isBox)
  }

  setSession(sessionId) {
    this.sessionId = sessionId
    this.scheduleSave()
  }

  /**
   * Store already-validated element revisions and notify listeners. `origin`
   * names the writer: `client:<id>`, `agent:<session>` or `host`.
   */
  commit(elements, { origin, files, appState } = {}) {
    for (const element of elements) this.elements.set(element.id, element)
    if (files) Object.assign(this.files, files)
    if (appState) Object.assign(this.appState, appState)
    this.rev += 1
    this.emit('change', { elements, files, appState, rev: this.rev, origin })
    this.scheduleSave()
    return this.rev
  }

  /** Re-issue the Host's copy of an element above a rejected client version. */
  reassert(id, incomingVersion, fallback) {
    const current = this.elements.get(id) ?? { ...fallback, isDeleted: true }
    return {
      ...current,
      version: Math.max(current.version ?? 0, incomingVersion ?? 0) + 1,
      versionNonce: randomSeed(),
    }
  }

  snapshot() {
    return {
      elements: this.ordered(),
      files: this.files,
      appState: this.appState,
      rev: this.rev,
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saving = this.saving.then(() => this.writeNow()).catch(error => this.emit('error', error))
    }, SAVE_DELAY_MS)
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.saving = this.saving.then(() => this.writeNow())
    }
    await this.saving
  }

  async writeNow() {
    await mkdir(this.dir, { recursive: true })
    const usedFiles = new Set(this.ordered().filter(element => element.type === 'image').map(element => element.fileId))
    const files = Object.fromEntries(Object.entries(this.files).filter(([id]) => usedFiles.has(id)))
    const data = {
      type: 'excalidraw',
      version: 2,
      source: 'dsh-mindmap',
      elements: this.ordered(),
      appState: this.appState,
      files,
      mindmap: { sessionId: this.sessionId },
    }
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(data, null, 1)}\n`)
    await rename(temp, this.file)
  }
}
