// The agents of a canvas. Each canvas has one lead Session: the conversation
// shown under the canvas and the Team Lead of the agents working on it. Asking
// for a box creates an Agent Teams teammate that owns the box, locked to it,
// and tells the lead; relaying, dependencies and conflicts are left to the Team.
import { boxInfo, boxToRect, frameBox, isBox, lockHolder, mindmapData, sameAgent, withMindmapData } from '../shared/scene.js'
import { MindmapError } from './canvases.js'
import { randomSeed } from './elements.js'
import { describeAgent, newStamp } from './locks.js'

const SPAWN_TIMEOUT_MS = 60_000
const MAX_NAME_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 200

/** A teammate name for a box: lower-kebab-case from the box name, never one the Team used. */
export function memberName(boxName, used) {
  const base = boxName.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, MAX_NAME_LENGTH).replace(/^-+|-+$/g, '')
  const named = base !== '' && base !== 'lead'
  for (let n = 1; ; n += 1) {
    const candidate = named && n === 1 ? base : `${named ? base : 'box'}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * @param ctx - Host context with `sessionController` and `agents`; Agent Teams (`agentTeams`) is optional.
 * @param options.provider - subagent provider teammates start with, as Agent Teams' `spawn_teammate` does for fresh context.
 */
export class CanvasTeams {
  constructor(ctx, { provider }) {
    this.ctx = ctx
    this.provider = provider
    this.checked = new Map()
  }

  get teams() {
    return this.ctx.get('agentTeams')
  }

  /**
   * The lead Session of a canvas, created with the canvas or on first use, and
   * again if it was deleted. Checked once per canvas while DSH runs.
   */
  ensureLead(canvas) {
    let pending = this.checked.get(canvas)
    if (!pending) {
      pending = this.checkLead(canvas)
      pending.catch(() => this.checked.delete(canvas))
      this.checked.set(canvas, pending)
    }
    return pending
  }

  async checkLead(canvas) {
    if (canvas.sessionId) {
      const result = await this.ctx.sessionController.resolveAgent(canvas.sessionId)
      if (!('error' in result) || result.error.code !== 'session/not-found') return canvas.sessionId
    }
    const { sessionId } = await this.ctx.sessionController.create({ workspaceId: canvas.workspaceId })
    await this.ctx.sessionController.rename({ sessionId, title: `Mindmap · ${canvas.name}` })
      .catch(error => this.ctx.logger.warn(`mindmap: naming session ${sessionId}: ${error?.message ?? error}`))
    canvas.setSession(sessionId)
    return sessionId
  }

  async leadAgent(canvas) {
    const sessionId = await this.ensureLead(canvas)
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw new MindmapError(`the canvas lead session is unavailable: ${result.error.message ?? result.error.code}`, 503)
    return result.agent
  }

  /**
   * Who an agent writes as: a Team member `{ name, lead, sessionId }`. Helpers
   * that are not Team members act for the agent that started them; a Session
   * outside any Team is the lead of its own.
   */
  writerOf(agent) {
    const seen = new Set()
    let current = agent
    while (!seen.has(current.id)) {
      seen.add(current.id)
      const membership = this.teams?.tryMembership(current)
      if (membership) return { name: membership.name, lead: membership.root.id, sessionId: current.id }
      const header = current.session.header
      const parent = header.origin === 'subagent' && header.parentSession ? this.ctx.agents.get(header.parentSession) : undefined
      if (!parent) break
      current = parent
    }
    return { name: 'lead', lead: current.id, sessionId: current.id }
  }

  /**
   * Give a box its own teammate: a new member of the canvas lead's Team, told
   * the instruction and owning the box, which is locked to it before it starts.
   * @returns the teammate `{ name, lead, sessionId }`.
   */
  async spawnMember(canvas, boxId, instruction) {
    const teams = this.teams
    if (!teams) throw new MindmapError('Agent Teams is not enabled in this DSH profile, so a box cannot get its own agent; ask the canvas lead in the chat instead', 409)
    const frame = canvas.get(boxId)
    if (!isBox(frame)) throw new MindmapError(`no box "${boxId}" on canvas "${canvas.name}"`, 404)
    const text = typeof instruction === 'string' ? instruction.trim() : ''
    if (!text) throw new MindmapError('say what the agent should do in this box')
    const { name: boxName, owner } = boxInfo(frame)
    if (owner && owner.lead === canvas.sessionId && owner.name !== 'lead') {
      throw new MindmapError(`box "${boxName}" already belongs to teammate "${owner.name}"; talk to it in the chat`, 409)
    }
    const holder = lockHolder(frame)
    if (holder && holder !== 'user') throw new MindmapError(`box "${boxName}" is locked by ${describeAgent(canvas, holder, 'user')}; unlock it first`, 409)

    const lead = await this.leadAgent(canvas)
    const name = memberName(boxName, new Set(teams.listMembers(lead).map(member => member.name)))
    const member = { name, lead: lead.id }
    const previous = mindmapData(frame) ?? {}
    // Reserved before the teammate starts, so its first write finds the box its own.
    this.updateBox(canvas, boxId, { owner: member, lock: member, stamp: newStamp() })
    const rect = boxToRect(frameBox(frame))
    try {
      const { member: row } = await teams.spawnTeammate(lead, {
        name,
        description: `Box "${boxName}" on canvas "${canvas.name}": ${text}`.slice(0, MAX_DESCRIPTION_LENGTH),
        prompt: [{
          type: 'text',
          text: `The user drew box "${boxName}" (id "${boxId}", x ${rect.x}, y ${rect.y}, ${rect.width}×${rect.height}) on Mindmap canvas "${canvas.name}" and asked:\n\n${text}\n\n`
            + `The box is yours and locked to you, so only you can change what lies in it. Read it with canvas_read {"canvas": "${canvas.name}", "scope": "${boxId}"}, look at it with canvas_view, and draw inside it with canvas_write.`,
        }],
        context: 'fresh',
        provider: this.provider,
        signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
      })
      const started = { ...member, sessionId: row.id }
      this.updateBox(canvas, boxId, { owner: started, ...(sameAgent(lockHolder(canvas.get(boxId)), member) ? { lock: started } : {}) },
        data => data.owner?.name === name)
      await this.tellLead(row.id, `(Sent by Mindmap as I started.) The user gave me box "${boxName}" (id "${boxId}", x ${rect.x}, y ${rect.y}, ${rect.width}×${rect.height}) and asked: ${text}`)
      return started
    } catch (error) {
      this.updateBox(canvas, boxId, { owner: previous.owner ?? null, lock: previous.lock ?? null, stamp: newStamp() },
        data => data.owner?.name === name && data.lock?.name === name)
      throw new MindmapError(`could not start an agent for box "${boxName}": ${error?.message ?? error}`, 502)
    }
  }

  /**
   * Tell the lead that a box got its teammate, as a Team message from that
   * teammate, so the lead plans the canvas's work instead of hearing of it late.
   */
  async tellLead(teammateId, text) {
    const teammate = this.ctx.agents.get(teammateId)
    if (!teammate) return
    await this.teams.sendMessage(teammate, { target: 'lead', content: [{ type: 'text', text }], signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS) })
      .catch(error => this.ctx.logger.warn(`mindmap: telling the lead about teammate ${teammateId}: ${error?.message ?? error}`))
  }

  /** Merge box data into a box, unless `still` finds it changed hands meanwhile. */
  updateBox(canvas, boxId, patch, still = () => true) {
    const frame = canvas.get(boxId)
    if (!isBox(frame) || !still(mindmapData(frame) ?? {})) return
    const next = withMindmapData(frame, patch)
    canvas.commit([{ ...next, version: frame.version + 1, versionNonce: randomSeed(), updated: Date.now() }], { origin: 'host' })
  }
}
