// The agent tools: look at a canvas (canvas_read, canvas_view) and change it
// (canvas_write). They are installed, with the canvas policy, on every agent
// whose workspace has a canvas; box locks decide what each agent may change.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boxInfo, boxToRect, elementBounds, frameBox, isBox, lockHolder, sameAgent } from '../shared/scene.js'
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE } from '../shared/fonts.js'
import { MindmapError } from './canvases.js'
import { DEFAULTS } from './elements.js'
import { WriteRejected, prepareWrite } from './write.js'
import { describeView, readCanvas, resolveScope, viewCanvas } from './views.js'

const ANY_OBJECT = { type: 'object', additionalProperties: true }
const MAX_REPORTED_BOUNDS = 100

const CANVAS_PARAM = {
  type: 'string',
  description: 'Canvas name in this workspace. Defaults to the canvas your Agent Team works on, or the only canvas.',
}
const GROUP_SHAPE = {
  scale: { type: 'number', description: 'Size relative to now, default 1; text scales too.' },
  angle: { type: 'number', description: 'Radians to turn the group clockwise about its centre, default 0.' },
}
const SCOPE_PARAMS = {
  scope: { type: 'string', description: 'A box id or name to cover only that box; omit for the whole canvas.' },
  ids: { type: 'array', items: { type: 'string' }, description: 'Cover exactly these element ids instead of a scope.' },
}

const WRITE_DESCRIPTION = `Create, change and delete elements of a Mindmap canvas in one atomic batch. Nothing is applied when any part is refused; the error says what to fix.
Elements use Excalidraw scene JSON in the compact form canvas_read returns. Coordinates are canvas units; x grows right, y grows down, and x/y is the top-left corner.
- Create: "type" is rectangle, ellipse, diamond, text, line, arrow, freedraw or frame (a box, with "name"); give x, y and width/height, or "points" [[dx, dy], ...] relative to x/y for line, arrow and freedraw. A line whose last point returns to its first is closed, and its backgroundColor fills it. An optional "id" (letters, digits, _ or -) lets later elements of the batch refer to it.
- rectangle, ellipse, diamond and arrow take "label": "text" or {"text", "fontSize", "fontFamily", "strokeColor", "textAlign", "verticalAlign"}, drawn centered; the shape grows to fit it, and "\\n" breaks lines. An arrow takes "start"/"end": {"id": ...} to attach to elements, and its points are then placed between them.
- Change: give an existing "id" with only the fields to change; "points" given alone are placed from the element's x/y as canvas_read shows it. Moving a frame (changing only x/y) moves its elements; resizing it (width/height, with x/y to grow left or up) leaves them in place.
- Groups: "copy": [{"ids": [...], "x", "y", "scale", "angle", "prefix"}] draws copies of existing elements from any box; "move": [{"ids": [...], "x", "y", "scale", "angle"}] rearranges existing elements, so placed copies are adjusted by moving them, not by deleting and copying again. A group keeps its layout: it is scaled by "scale" (default 1, text included), its top-left lands at x/y (a move without them stays where it is), then it turns "angle" radians clockwise about its centre. Labels come along, and arrows between the group's elements stay attached. A copy gets the id "<prefix><original id>" (prefix default "c1-", "c2-", … whichever is free).
- Style, with the default an omitted field takes (canvas_read leaves defaults out too): strokeColor and backgroundColor, CSS colors (default "${DEFAULTS.strokeColor}" and "${DEFAULTS.backgroundColor}"); fillStyle solid, hachure, cross-hatch or zigzag (default ${DEFAULTS.fillStyle}); strokeWidth (default ${DEFAULTS.strokeWidth}); strokeStyle solid, dashed or dotted (default ${DEFAULTS.strokeStyle}); roughness 0 clean, 1 sketchy, 2 very sketchy (default ${DEFAULTS.roughness}); opacity 0-100 (default ${DEFAULTS.opacity}); roundness null sharp (default), {"type": 3} rounded rectangle corners, {"type": 2} curved lines; angle in radians (default 0).
- Text: "text", fontSize (default ${DEFAULT_FONT_SIZE}), fontFamily (default ${DEFAULT_FONT_FAMILY} hand-drawn, 6 Nunito, 8 Comic Shanns, 2 sans-serif, 3 monospace), textAlign (default left); its size follows its content. Chinese, Japanese and Korean text works in every family.
- Order: elements are drawn in the order canvas_read lists them, later ones on top; new elements go on top. "above" or "below": "<id>" draws a new or existing element directly above or below another one.
Boxes: an element lying fully inside a frame belongs to that box. A frame takes "lock": true to lock the box to you, which makes you its owner, or false to unlock it. While a box is locked, only its holder can change the box or anything lying in it, even partly: inside it, across its border, or where it overlaps another box. The canvas lead may unlock boxes held by agents, and locking a teammate's box again gives it back to that teammate; a box the user locked stays locked until the user unlocks it. A refused write names the holder: message them (send_message) instead of working around the lock.
Example: {"elements": [{"type": "frame", "id": "bike", "name": "Bicycle", "x": 0, "y": 0, "width": 320, "height": 240, "lock": true}, {"type": "ellipse", "id": "wheel", "x": 40, "y": 120, "width": 80, "height": 80}, {"type": "rectangle", "id": "seat", "x": 160, "y": 40, "width": 120, "height": 50, "label": "Seat", "backgroundColor": "#a5d8ff"}, {"type": "arrow", "start": {"id": "wheel"}, "end": {"id": "seat"}}, {"id": "old-note", "strokeColor": "#e03131"}], "delete": ["draft-1"]}`

const POLICY = `# Mindmap canvases
This workspace has Mindmap canvases: Excalidraw boards that the user and agents draw on together, read with canvas_read and canvas_view and changed with canvas_write. Each canvas has a lead, the Session the user talks to under the canvas, which leads the Agent Team working on it. When the user draws a box and gives it an instruction, a teammate is created for that box and the box is locked to it.
- Claim a box before you draw: lock the box you were given or a free one ({"id": "<box>", "lock": true}), or create one in free space with "lock": true. Keep your work inside it and grow the box when you need room.
- Only the holder of a locked box can change it. Do not cover, move or redraw what others hold; when you need their space or content, message the holder or the lead with send_message. To reuse content from another box, copy it into yours (canvas_write "copy") rather than moving it.
- Read and change canvases only with these tools, never by opening .mindmaps/<canvas>/canvas.excalidraw: it may lag behind the canvas, and canvas_read already returns every field that differs from its default. canvas_write "move" and "copy" place, scale and turn whole groups of elements, so assembling parts needs no geometry of your own.
- Keep finished work locked: the lock guards it from other agents, and the user can unlock any box themselves.
- The user steers you in the chat. What the user draws on the canvas is theirs: not an instruction unless they say so, and not yours to move, cover, redo or delete. When the user changed something in or beside your box, the canvas tools tell you: keep it, and judge whether it is meant for you.
- Draw what a picture shows best: let position, connection, colour and shape carry the meaning, and keep every label to a few words, never sentences. When a box answers a question, such as how things compare or what would happen, find the variable the answer turns on and place the things on it rather than listing them in a table. Longer text (prose, quotes, exact numbers, code) goes in workspace files, linked from the elements that need it ("link"), unless the user asks for text on the canvas.
- Where your box meets another (a shared edge, a picture that continues across, an arrow between them), settle the seam directly with its holder. An arrow into a box locked against you is refused: tell the lead which elements it joins, and it draws it once both ends are placed, reading their positions from the canvas, so there are no coordinates to agree on.
- Your drawing is your report. Mark on it what you guessed or could not find, where the user sees it. When you finish, close with one short sentence; the lead is told and sees the canvas. Use send_message only when someone else must act: you need their space, content or a decision. What others need goes in a file or on the canvas: tell them it is ready rather than sending it, and before reading or fetching anything large, look for a file or task that already covers it.
- Teammates cannot start helpers. If your box has more work than you can finish quickly, tell the lead at once which parts to split off. If your box needs the same input or agreement as another box (a source, a list, a scale, a palette), wait for the lead's plan before reading or producing it; it comes within a minute or two. If the user changes your instruction and the change touches another box or a shared agreement, tell the lead.`

const LEAD_POLICY = `## Leading this canvas
The canvas decides where work shows and who may change it: each box has one holder. The Team decides who does the work. Workspace files hold what several agents need but nobody draws. A box the user draws starts with one teammate, and you are told when it does. Most of your work is where the two do not line up.
Plan when boxes arrive, and again when another one does; plan the same way when the user asks you in the chat for work with several parts, drawing a box per part. Read only what decides the plan: the boxes, their instructions, the user's notes, and a list of the units with their rough size (open one sample if the size is unclear). Stop when one more detail would not change who does what, what is shared or what waits; if you are noting content a teammate will draw, you are doing its part. A box that needs nothing from the others and no more hands than its own teammate: leave it alone, adding nothing the user did not ask for. For the rest, settle the points below that apply, but start the hands first: as soon as you know the parts, create their tasks and start their helpers, and let box teammates keep working; the rest of the plan can follow.
1. More work than hands. When a box has more independent parts than one agent finishes quickly (papers, regions, modules, figures), start helpers with spawn_teammate, one per part or small group, without waiting to be asked: each with its task, its parts and what it produces. Where a helper's work should show, draw it an empty, unlocked box beside the box it serves, with a gap between them, and have it lock that box; a box inside another agent's locked box is refused.
2. What several boxes need. A shared input (a source to read, an inventory, a list of components) or a shared agreement (what positions, colours and shapes mean; scale, coordinates, names, interfaces) gets one owner, who produces it once, as a file or a key on the canvas, before the others depend on it. Keep it to what the next step needs; a long spec costs every reader time.
3. Where boxes meet. Boxes that share an edge, continue one picture or connect by arrows: their holders settle the seam directly with each other. An arrow between two boxes touches both, so neither holder can draw it: the holders name the elements it joins, and you draw it once both ends are placed, reading their positions from the canvas (unlock, draw, lock again).
4. What waits. Put dependencies on the task board (blocked_by). A box that waits draws its skeleton first (layout, axes, legend) and fills it as its inputs arrive.
5. How each box shows its part: a scene, a map, layers and flows, a timeline, an axis. A box that answers a question places things on the variable the answer turns on: "which designs survive a power cut" becomes an axis of battery hours with the cut drawn across. Comparable things share one template so their differences show. The box's holder may find better.
Then send each teammate you planned for one message: its part, what it produces and reads, the agreements it follows and the boxes it meets.
Keep handoffs few and small. Whoever produces something draws it. Content moves through files and the canvas; a message carries only "<file> is ready", a question or a dispute, and the same content never goes to several agents. A dispute goes to whoever owns the fact or agreement; step in only when they stay stuck, and decide in one line.
The user's words outrank your plan. When the user asks you in the chat for a change in a box, pass it to its holder in the user's words. The user's stops, deletions, unlocks and own locks are decisions: do not restart, redraw or lock again what they touched; if something depends on it, ask in one line. Whatever else the user draws is theirs; leave it alone unless they ask.
Your work is planning, staffing and refereeing: do not do the parts or relay content yourself. A teammate that is reading or drawing is working, not stalled: before you interrupt one, look at its box and recent activity, and ask it first. Teammates' work is on the canvas: check only what your next step depends on, and do not describe it back to the user. When the only news is that a teammate finished and nothing waits on it, answer in one line. When every box is done, check that a colour or shape means the same everywhere, that seams line up and that no two boxes contradict each other, then tell the user in one line.`

/**
 * @param mindmap - operations shared with the canvas UI: `canvases`, `team`,
 *   `activity`, `workspaces`, `agents`, `fontFiles`, `acceptsImages(agent, signal)`
 *   and `saveImage(png, name)`.
 */
export class CanvasTools {
  constructor(mindmap, logger) {
    this.mindmap = mindmap
    this.logger = logger
    this.installs = new Map()
    this.definitions = [this.readTool(), this.viewTool(), this.writeTool()]
  }

  /** Install the tools, the canvas policy and the agent's place on the canvases in a workspace that has a canvas. */
  async install(agent) {
    if (this.installs.has(agent)) return
    const workspace = await this.workspaceOf(agent)
    const names = workspace ? await this.mindmap.canvases.names(workspace.id) : []
    if (names.length === 0 || this.installs.has(agent)) return
    // Loaded now, so the prompt context can name the agent's canvas.
    await Promise.all(names.map(item => this.mindmap.canvases.open(workspace.id, item).catch(() => undefined)))
    if (this.installs.has(agent)) return
    const fiber = agent.ctx.inject(['tools', 'systemPrompt'], scoped => {
      for (const definition of this.definitions) scoped.tools.register(definition)
      scoped.systemPrompt.section({
        name: 'mindmap:policy',
        order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY') + 10,
        text: () => (this.leadCanvasOf(agent, workspace.id) ? `${POLICY}\n\n${LEAD_POLICY}` : POLICY),
      })
      scoped.systemPrompt.context({
        name: 'mindmap:canvas',
        order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY') + 1,
        text: () => this.placeOf(agent, workspace.id),
      })
    })
    this.installs.set(agent, fiber)
  }

  /** The canvas `agent` leads, if any. */
  leadCanvasOf(agent, workspaceId) {
    const writer = this.mindmap.team.writerOf(agent)
    if (writer.name !== 'lead') return undefined
    return this.mindmap.canvases.loadedIn(workspaceId).find(canvas => canvas.sessionId === writer.lead)
  }

  /** One line placing the agent: lead of a canvas, teammate on one, or neither. */
  placeOf(agent, workspaceId) {
    const writer = this.mindmap.team.writerOf(agent)
    const canvases = this.mindmap.canvases.loadedIn(workspaceId)
    const own = canvases.find(canvas => canvas.sessionId === writer.lead)
    if (own && writer.name === 'lead') {
      return `You are the lead of Mindmap canvas "${own.name}": the user talks to you in the chat under it, so "the canvas" means this one, and its boxes are named there.`
    }
    if (own) return `You work on Mindmap canvas "${own.name}" as teammate "${writer.name}".`
    return `Mindmap canvases in this workspace: ${canvases.map(canvas => `"${canvas.name}"`).join(', ')}.`
  }

  uninstall(agent) {
    const fiber = this.installs.get(agent)
    if (!fiber) return
    this.installs.delete(agent)
    fiber.dispose().catch(error => this.logger.warn(`mindmap: removing tools from agent ${agent.id} failed: ${error.message}`))
  }

  async installWorkspace(workspaceId) {
    for (const agent of this.mindmap.agents.list()) {
      if ((await this.workspaceOf(agent))?.id === workspaceId) await this.install(agent)
    }
  }

  disposeAll() {
    for (const agent of [...this.installs.keys()]) this.uninstall(agent)
  }

  async workspaceOf(agent) {
    const cwd = agent.session.header.cwd
    return cwd ? this.mindmap.workspaces.resolveByPath(cwd) : undefined
  }

  /** Who is calling and which canvas they mean: `{ canvas, writer }`. */
  async caller(agent, canvasName) {
    const { canvas, writer } = await this.resolveCaller(agent, canvasName)
    await this.mindmap.team.ensureLead(canvas)
    return { canvas, writer }
  }

  async resolveCaller(agent, canvasName) {
    if (!agent) throw new MindmapError('the canvas tools run only inside an agent session')
    const writer = this.mindmap.team.writerOf(agent)
    const workspace = await this.workspaceOf(agent)
    if (!workspace) throw new MindmapError('this session is not in a DSH workspace, so it has no canvases')
    const names = await this.mindmap.canvases.names(workspace.id)
    const list = names.map(item => `"${item}"`).join(', ') || 'none'
    if (canvasName !== undefined) {
      if (!names.includes(canvasName)) throw new MindmapError(`no canvas "${canvasName}" in this workspace; canvases: ${list}`)
      return { canvas: await this.mindmap.canvases.open(workspace.id, canvasName), writer }
    }
    const canvases = await Promise.all(names.map(item => this.mindmap.canvases.open(workspace.id, item)))
    const canvas = canvases.find(item => item.sessionId === writer.lead) ?? (canvases.length === 1 ? canvases[0] : undefined)
    if (!canvas) throw new MindmapError(`name the canvas with "canvas"; this workspace has ${list}`)
    return { canvas, writer }
  }

  readTool() {
    return defineTool({
      name: 'canvas_read',
      description: 'Read a Mindmap canvas as JSON: who you are on it, its boxes (named frames grouping elements, with their owner and who holds their lock), and the elements in drawing order in the compact Excalidraw form canvas_write accepts, where fields with their default value are left out.',
      parameters: { canvas: CANVAS_PARAM, ...SCOPE_PARAMS },
      output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const { canvas, writer } = await this.caller(exec.agent, args.canvas)
        const scope = resolveScope(canvas, args)
        const userEdits = this.mindmap.edits.since(canvas, writer)
        this.mindmap.activity.noteLook(canvas, writer, exec.agent.id, 'read', scope.box)
        return { you: describeCaller(canvas, writer), ...(userEdits ? { userEdits } : {}), ...readCanvas(canvas, writer, scope) }
      },
    })
  }

  viewTool() {
    return defineTool({
      name: 'canvas_view',
      description: 'Look at a Mindmap canvas: render the whole canvas, one box or chosen elements as a PNG image you can see, drawn as the canvas shows it. The image is also saved in the canvas folder.',
      parameters: {
        canvas: CANVAS_PARAM,
        ...SCOPE_PARAMS,
        region: {
          type: 'object',
          additionalProperties: false,
          description: 'Show this canvas area instead of fitting the scope.',
          properties: {
            x: { type: 'number', required: true },
            y: { type: 'number', required: true },
            width: { type: 'number', required: true },
            height: { type: 'number', required: true },
          },
        },
        grid: { type: 'boolean', description: 'Overlay labelled canvas coordinates to help place elements.' },
        scale: { type: 'number', description: 'Pixels per canvas unit, default 1, at most 8; reduced so the longer side stays within 1600 px. Zoom into a small region with a large scale.' },
      },
      output: {
        schema: ANY_OBJECT,
        render: (_args, value) => [
          { type: 'text', text: value.text },
          ...(value.image ? [{ type: 'image', attachment: value.image }] : []),
        ],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const { canvas, writer } = await this.caller(exec.agent, args.canvas)
        const scope = resolveScope(canvas, args)
        const userEdits = this.mindmap.edits.since(canvas, writer)
        this.mindmap.activity.noteLook(canvas, writer, exec.agent.id, 'view', scope.box)
        const view = await viewCanvas(canvas, scope, {
          region: args.region, scale: args.scale ?? 1, grid: args.grid === true, fontFiles: this.mindmap.fontFiles,
        })
        const text = userEdits ? `${describeView(view)}\n${userEdits}` : describeView(view)
        if (!(await this.mindmap.acceptsImages(exec.agent, exec.signal))) {
          return { text: `${text}\nThe current model does not accept images, so it is not attached; use canvas_read for the content.` }
        }
        const image = await this.mindmap.saveImage(view.png, `${canvas.name}.png`)
        return { text, image }
      },
    })
  }

  writeTool() {
    return defineTool({
      name: 'canvas_write',
      description: WRITE_DESCRIPTION,
      parameters: {
        canvas: CANVAS_PARAM,
        elements: { type: 'array', items: ANY_OBJECT, description: 'Elements to create, or patches of existing elements by "id".' },
        move: {
          type: 'array',
          description: 'Groups of existing elements to rearrange, each moved, scaled and turned as a whole.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Elements to move; their labels come along.' },
              x: { type: 'number', description: 'New left of the group; default where it is.' },
              y: { type: 'number', description: 'New top of the group; default where it is.' },
              ...GROUP_SHAPE,
            },
          },
        },
        copy: {
          type: 'array',
          description: 'Groups of existing elements to copy, each placed, scaled and turned as a whole.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Elements to copy; their labels come along.' },
              x: { type: 'number', required: true, description: 'Left of the copied group.' },
              y: { type: 'number', required: true, description: 'Top of the copied group.' },
              ...GROUP_SHAPE,
              prefix: { type: 'string', description: 'Copies get ids "<prefix><original id>".' },
            },
          },
        },
        delete: { type: 'array', items: { type: 'string' }, description: 'Ids to delete. A shape takes its label along; a frame takes its elements.' },
      },
      output: { schema: ANY_OBJECT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        const { canvas, writer } = await this.caller(exec.agent, args.canvas)
        const userEdits = this.mindmap.edits.since(canvas, writer)
        if (!args.elements?.length && !args.move?.length && !args.copy?.length && !args.delete?.length) {
          throw new MindmapError('give "elements" to create or change, "move", "copy" or "delete"')
        }
        let prepared
        try {
          prepared = prepareWrite(canvas, writer, args)
        } catch (error) {
          if (error instanceof WriteRejected) {
            throw new MindmapError([error.message, error.hint, userEdits].filter(Boolean).join('\n'))
          }
          throw error
        }
        canvas.commit(prepared.changes, { origin: `agent:${exec.agent.id}` })
        this.mindmap.activity.noteWrite(canvas, writer, exec.agent.id, args, prepared.report)
        return { ...writeResult(canvas, prepared.report), ...(userEdits ? { userEdits } : {}) }
      },
    })
  }
}

/** Who the caller is on this canvas and which boxes it holds, stated at the top of every read. */
function describeCaller(canvas, writer) {
  const held = canvas.boxes().filter(frame => sameAgent(lockHolder(frame), writer))
  const boxes = held.length > 0
    ? `Boxes locked to you: ${held.map(frame => `"${boxInfo(frame).name}" (${frame.id})`).join(', ')}.`
    : 'No box is locked to you; lock one before you draw.'
  if (writer.lead !== canvas.sessionId) return `You are not in the Agent Team of canvas "${canvas.name}". ${boxes}`
  if (writer.name === 'lead') return `You are the lead of canvas "${canvas.name}": the user talks to you under the canvas, and you lead the Agent Team working on it. You may unlock boxes your teammates hold. ${boxes}`
  return `You are teammate "${writer.name}" in the Agent Team of canvas "${canvas.name}", led by "lead". ${boxes}`
}

/** The write report plus the final box of every element written, so layout can continue from it. */
function writeResult(canvas, report) {
  const result = {}
  for (const key of ['created', 'updated', 'deleted', 'absorbed', 'copies']) if (report[key].length > 0) result[key] = report[key]
  const touched = [...report.created, ...report.updated].map(id => canvas.get(id)).filter(element => element && !element.containerId)
  if (touched.length > 0) {
    result.bounds = Object.fromEntries(touched.slice(0, MAX_REPORTED_BOUNDS)
      .map(element => [element.id, boxToRect(isBox(element) ? frameBox(element) : elementBounds(element))]))
    if (touched.length > MAX_REPORTED_BOUNDS) result.boundsOmitted = touched.length - MAX_REPORTED_BOUNDS
  }
  if (report.warnings.length > 0) result.warnings = report.warnings
  return result
}
