// Runs against an installed DSH, which provides the host packages:
// DSH_RUNTIME_ROOT=/path/to/app npm test
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvases } from '../src/host/canvases.js'
import { CanvasTeams } from '../src/host/team.js'

const runtimeRoot = process.env.DSH_RUNTIME_ROOT
const skip = runtimeRoot ? false : 'DSH_RUNTIME_ROOT is not set'
const canvasTools = ['canvas_read', 'canvas_view', 'canvas_write']

async function fixture(t) {
  const runtimeParent = pathToFileURL(resolve(runtimeRoot, 'package.json')).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: runtimeParent } : context)
    },
  })
  t.after(() => hooks.deregister())
  const [{ Context }, { SystemPrompt, renderPrompt, renderContextSnapshot }, { ToolRuntime }, { createScope }, native, { CanvasTools }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-tool-executor-native'),
    import('../src/host/tools.js'),
  ])

  const path = await mkdtemp(join(tmpdir(), 'mindmap-tools-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(native, {})
  const owner = ctx.plugin({ name: 'mindmap-test-agents', inject: ['tools', 'systemPrompt'], apply() {} })
  await owner

  const workspace = { id: 'ws', title: 'ws', path }
  const workspaces = { get: () => workspace, resolveByPath: () => workspace }
  const logger = { warn: message => assert.fail(message) }
  const canvases = new Canvases(workspaces, logger)
  const canvas = await canvases.create('ws', 'zoo')
  const agents = new Map()
  const memberships = new Map()
  const team = new CanvasTeams({
    get: name => (name === 'agentTeams' ? { tryMembership: agent => memberships.get(agent.id) } : undefined),
    agents: { get: id => agents.get(id) },
  }, { provider: 'spawn' })
  const tools = new CanvasTools({ canvases, team, workspaces }, logger)

  async function agent(id, header = {}) {
    const subject = { id, session: { id, header: { cwd: path, ...header } } }
    subject.ctx = createScope(owner.ctx, subject).ctx
    agents.set(id, subject)
    await tools.install(subject)
    await tools.installs.get(subject)
    return subject
  }

  /** What one step gives the agent, in the loop's order: tools, then the rendered prompt. */
  async function step(subject) {
    const signal = new AbortController().signal
    const modelSelection = { provider: 'test', model: 'test' }
    const toolSet = await ctx.tools.resolve({ agent: subject, modelSelection, signal })
    const assembly = await ctx.systemPrompt.assemble({ scope: subject, agent: subject, signal, modelSelection, toolSet })
    return {
      tools: assembly.tools.map(tool => tool.name).sort(),
      prompt: renderPrompt(assembly),
      context: renderContextSnapshot(assembly),
    }
  }

  return { agent, step, canvas, memberships }
}

function assertOutside({ tools, prompt, context }) {
  assert.deepEqual(tools, [])
  assert.doesNotMatch(prompt, /Mindmap|canvas/iu)
  assert.doesNotMatch(context, /Mindmap|zoo/iu)
}

test('a Session that does not work on a canvas gets nothing from it', { skip }, async t => {
  const h = await fixture(t)
  h.canvas.setSession('lead')
  assertOutside(await h.step(await h.agent('other')))

  h.memberships.set('outsider', { name: 'helper', root: { id: 'other' } })
  assertOutside(await h.step(await h.agent('outsider')))
})

test('the lead gets the tools and the lead policy from the step after it becomes lead', { skip }, async t => {
  const h = await fixture(t)
  const lead = await h.agent('lead')
  assertOutside(await h.step(lead))

  h.canvas.setSession('lead')
  const { tools, prompt, context } = await h.step(lead)
  assert.deepEqual(tools, canvasTools)
  assert.match(prompt, /# Mindmap canvases/u)
  assert.match(prompt, /## Leading this canvas/u)
  assert.match(context, /lead of Mindmap canvas "zoo"/u)
})

test('a teammate gets the tools once its membership exists, without the lead policy', { skip }, async t => {
  const h = await fixture(t)
  h.canvas.setSession('lead')
  const teammate = await h.agent('pelican')
  assertOutside(await h.step(teammate))

  h.memberships.set('pelican', { name: 'pelican', root: { id: 'lead' } })
  const { tools, prompt, context } = await h.step(teammate)
  assert.deepEqual(tools, canvasTools)
  assert.match(prompt, /# Mindmap canvases/u)
  assert.doesNotMatch(prompt, /## Leading this canvas/u)
  assert.match(context, /Mindmap canvas "zoo" as teammate "pelican"/u)
})

test('a helper works on the canvas only when the Session that started it does', { skip }, async t => {
  const h = await fixture(t)
  h.canvas.setSession('lead')
  await h.agent('lead')
  const helper = await h.agent('helper', { origin: 'subagent', parentSession: 'lead' })
  assert.deepEqual((await h.step(helper)).tools, canvasTools)

  await h.agent('other')
  assertOutside(await h.step(await h.agent('stray', { origin: 'subagent', parentSession: 'other' })))
})
