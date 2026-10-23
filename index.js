// DSH Mindmap: persistent Excalidraw canvases in the workspace. Each canvas is
// the conversation of one lead Session; a box drawn on it can get its own
// Agent Teams teammate, and box locks keep agents and the user out of each
// other's work.
import z from '@deepseek-ai/schemastery'
import { CanvasActivity } from './src/host/activity.js'
import { registerRoutes } from './src/host/api.js'
import { Canvases } from './src/host/canvases.js'
import { UserEdits } from './src/host/notices.js'
import { defaultCjkFonts } from './src/host/render.js'
import { CanvasTeams } from './src/host/team.js'
import { CanvasTools } from './src/host/tools.js'

export const name = 'mindmap'
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'agents']

export const Config = z.object({
  fontFiles: z.array(z.string()).default([])
    .description('Font files used when drawing canvas images for agents, such as a CJK face. Empty uses the first installed CJK system font.'),
  teammateProvider: z.string().default('spawn')
    .description('Subagent provider a box teammate starts with; the same as Agent Teams uses for fresh teammates.'),
})

const MODEL_LOOKUP_MS = 10_000

export function apply(ctx, config) {
  const fontFiles = config.fontFiles?.length ? config.fontFiles : defaultCjkFonts()
  const warn = message => error => ctx.logger.warn(`mindmap: ${message}: ${error?.stack ?? error}`)

  async function acceptsImages(agent, signal = AbortSignal.timeout(MODEL_LOOKUP_MS)) {
    const llm = ctx.get('llm')
    const routed = agent.session.requestHeader()?.config
    const provider = routed?.provider ?? agent.options.provider
    const model = routed?.model ?? agent.options.model
    if (!llm || !provider || !model) return false
    const info = await llm.resolveModelInfo(provider, model, signal).catch(() => undefined)
    return info?.inputModalities?.includes('image') === true
  }

  /** Store a PNG as a durable image attachment; undefined when no store is mounted. */
  async function saveImage(png, imageName) {
    const attachments = ctx.get('attachments')
    if (!attachments) return undefined
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: imageName })
    return JSON.parse(JSON.stringify(ref))
  }

  const canvases = new Canvases(ctx.workspaceRegistry, ctx.logger)
  const team = new CanvasTeams(ctx, { provider: config.teammateProvider ?? 'spawn' })
  const activity = new CanvasActivity({ canvases, team, agents: ctx.agents })
  const edits = new UserEdits()
  const mindmap = { canvases, team, activity, edits, workspaces: ctx.workspaceRegistry, agents: ctx.agents, fontFiles, acceptsImages, saveImage }
  const tools = new CanvasTools(mindmap, ctx.logger)
  registerRoutes(ctx, mindmap)

  // A failing serial `agent/created` listener would fail the agent's creation, so installation never throws.
  ctx.on('agent/created', ({ agent }) => tools.install(agent).catch(warn(`installing tools on agent ${agent.id}`)))
  ctx.on('agent/disposed', ({ agent }) => tools.uninstall(agent))
  ctx.on('session/event', (session, event) => activity.noteEvent(session, event))
  ctx.on('session/disposed', session => activity.forget(session.id))
  canvases.on('opened', canvas => edits.watch(canvas))
  canvases.on('created', ({ workspaceId }) => tools.installWorkspace(workspaceId).catch(warn('installing tools for a new canvas')))
  for (const agent of ctx.agents.list()) tools.install(agent).catch(warn(`installing tools on agent ${agent.id}`))

  ctx.effect(() => async () => {
    tools.disposeAll()
    await canvases.flushAll()
  }, 'mindmap: tools and saving')
}
