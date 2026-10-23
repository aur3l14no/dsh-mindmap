// Every canvas of every workspace, loaded on first use and shared by the canvas
// UI routes and the agent tools. Canvases live in `<workspace>/.mindmaps/<name>/`.
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CANVAS_FILE, Canvas } from './canvas.js'

export const MINDMAPS_DIR = '.mindmaps'
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,63}$/u

/** A refused canvas operation; `status` is its HTTP status for the canvas UI. */
export class MindmapError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function checkCanvasName(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new MindmapError('a canvas name is 1-64 letters, digits, spaces, "_", "-" or "." and starts with a letter or digit')
  }
  return name
}

/** Emits `created({ workspaceId, name })` when a canvas is created. */
export class Canvases extends EventEmitter {
  constructor(workspaces, logger) {
    super()
    this.workspaces = workspaces
    this.logger = logger
    this.loaded = new Map()
    this.ready = new Map()
  }

  workspace(workspaceId) {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new MindmapError(`unknown workspace "${workspaceId}"`, 404)
    return workspace
  }

  /** Names of the canvases saved in one workspace, sorted. */
  async names(workspaceId) {
    const dir = join(this.workspace(workspaceId).path, MINDMAPS_DIR)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && NAME.test(entry.name) && existsSync(join(dir, entry.name, CANVAS_FILE)))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  }

  open(workspaceId, name) {
    checkCanvasName(name)
    const workspace = this.workspace(workspaceId)
    const key = `${workspaceId}/${name}`
    let pending = this.loaded.get(key)
    if (!pending) {
      const canvas = new Canvas({ workspaceId, workspacePath: workspace.path, name })
      if (!existsSync(canvas.file)) throw new MindmapError(`no canvas "${name}" in workspace "${workspace.title}"`, 404)
      canvas.on('error', error => this.logger.warn(`mindmap: saving ${canvas.file} failed: ${error.message}`))
      pending = canvas.load().then(() => {
        this.ready.set(key, canvas)
        this.emit('opened', canvas)
        return canvas
      })
      pending.catch(() => this.loaded.delete(key))
      this.loaded.set(key, pending)
    }
    return pending
  }

  /** The canvases of a workspace that have finished loading. */
  loadedIn(workspaceId) {
    return [...this.ready.values()].filter(canvas => canvas.workspaceId === workspaceId)
  }

  /** The loaded canvas whose lead is Session `sessionId`, if any. */
  byLead(sessionId) {
    for (const canvas of this.ready.values()) if (canvas.sessionId === sessionId) return canvas
    return undefined
  }

  async create(workspaceId, name) {
    checkCanvasName(name)
    const workspace = this.workspace(workspaceId)
    const canvas = new Canvas({ workspaceId, workspacePath: workspace.path, name })
    if (existsSync(canvas.file)) throw new MindmapError(`canvas "${name}" already exists`, 409)
    await canvas.create()
    this.emit('created', { workspaceId, name })
    return this.open(workspaceId, name)
  }

  async flushAll() {
    await Promise.all([...this.loaded.values()].map(async pending => (await pending).flush()))
  }
}
