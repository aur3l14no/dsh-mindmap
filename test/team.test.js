import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boxInfo } from '../src/shared/scene.js'
import { Canvas } from '../src/host/canvas.js'
import { CanvasTeams } from '../src/host/team.js'
import { prepareWrite } from '../src/host/write.js'

async function scene() {
  const dir = await mkdtemp(join(tmpdir(), 'mindmap-team-'))
  const canvas = new Canvas({ workspaceId: 'ws', workspacePath: dir, name: 'zoo' })
  const { changes } = prepareWrite(canvas, { name: 'lead', lead: 'L', sessionId: 'L' }, {
    elements: [
      { type: 'frame', id: 'b1', name: 'Pelican', x: 0, y: 0, width: 300, height: 200 },
      { type: 'frame', id: 'b2', name: '鹈鹕', x: 400, y: 0, width: 300, height: 200 },
    ],
  })
  canvas.commit(changes, { origin: 'test' })
  return { canvas, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A Host with one live lead "L" and an Agent Teams stand-in recording spawns. */
function host(canvas, { spawn, send } = {}) {
  const lead = { id: 'L', session: { header: { id: 'L' } } }
  const spawned = []
  const sent = []
  const teams = {
    listMembers: () => [{ name: 'lead' }, { name: 'pelican' }],
    tryMembership: agent => agent.member,
    async spawnTeammate(caller, request) {
      spawned.push({ caller, request, box: boxInfo(canvas.get(request.prompt[0].text.match(/id "(\w+)"/)[1])) })
      if (spawn) return spawn(request)
      return { member: { id: `S-${request.name}`, name: request.name } }
    },
    async sendMessage(caller, request) {
      sent.push({ from: caller.id, target: request.target, text: request.content.map(block => block.text).join('') })
      if (send) send(request)
      return { messageId: 'm1' }
    },
  }
  const created = []
  const ctx = {
    get: name => name === 'agentTeams' ? teams : undefined,
    agents: { get: id => (id === 'L' ? lead : id.startsWith('S-') ? { id } : undefined) },
    logger: { warn() {} },
    sessionController: {
      resolveAgent: async id => (id === 'L' ? { agent: lead } : { error: { code: 'session/not-found' } }),
      async create({ workspaceId }) {
        created.push(workspaceId)
        return { sessionId: 'L' }
      },
      async rename(request) {
        created.push(request.title)
      },
    },
  }
  return { team: new CanvasTeams(ctx, { provider: 'spawn' }), spawned, sent, created, lead }
}

test('a canvas gets a lead Session, created again when the stored one is gone', async () => {
  const { canvas, cleanup } = await scene()
  canvas.sessionId = 'gone'
  const { team, created } = host(canvas)
  assert.equal(await team.ensureLead(canvas), 'L')
  assert.equal(await team.ensureLead(canvas), 'L')
  assert.deepEqual(created, ['ws', 'Mindmap · zoo'])
  await canvas.flush()
  const reloaded = await new Canvas({ workspaceId: 'ws', workspacePath: canvas.workspacePath, name: 'zoo' }).load()
  assert.equal(reloaded.sessionId, 'L')
  await cleanup()
})

test('asking for a box spawns a teammate of the lead, with the box locked to it before it starts', async () => {
  const { canvas, cleanup } = await scene()
  canvas.sessionId = 'L'
  const { team, spawned, lead } = host(canvas)
  const member = await team.spawnMember(canvas, 'b1', '  draw a pelican riding a bicycle ')
  assert.deepEqual(member, { name: 'pelican-2', lead: 'L', sessionId: 'S-pelican-2' })
  const [{ caller, request, box }] = spawned
  assert.equal(caller, lead)
  assert.equal(request.context, 'fresh')
  assert.equal(request.provider, 'spawn')
  assert.match(request.prompt[0].text, /draw a pelican riding a bicycle\n/)
  assert.match(request.prompt[0].text, /canvas_read \{"canvas": "zoo", "scope": "b1"\}/)
  assert.equal(box.lock.name, 'pelican-2')
  assert.equal(box.owner.name, 'pelican-2')
  assert.deepEqual(boxInfo(canvas.get('b1')).owner, member)
  assert.deepEqual(boxInfo(canvas.get('b1')).lock, member)
  await assert.rejects(team.spawnMember(canvas, 'b1', 'again'), /already belongs to teammate "pelican-2"/)
  await cleanup()
})

test('the lead hears of a box teammate from the teammate, and a lost message does not undo the box', async () => {
  const { canvas, cleanup } = await scene()
  canvas.sessionId = 'L'
  const { team, sent } = host(canvas, { send: request => { if (/鹈鹕/.test(request.content[0].text)) throw new Error('inbox closed') } })
  await team.spawnMember(canvas, 'b1', 'draw a pelican')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].from, 'S-pelican-2')
  assert.equal(sent[0].target, 'lead')
  assert.match(sent[0].text, /^\(Sent by Mindmap as I started\.\) The user gave me box "Pelican" \(id "b1", x 0, y 0, 300×200\) and asked: draw a pelican$/)
  const member = await team.spawnMember(canvas, 'b2', 'draw')
  assert.equal(sent.length, 2)
  assert.deepEqual(boxInfo(canvas.get('b2')).owner, member)
  await cleanup()
})

test('a teammate that cannot start leaves the box as it was', async () => {
  const { canvas, cleanup } = await scene()
  canvas.sessionId = 'L'
  const { team } = host(canvas, { spawn: () => { throw new Error('Team member limit 8 reached') } })
  await assert.rejects(team.spawnMember(canvas, 'b2', 'draw'), error => error.status === 502 && /limit 8/.test(error.message))
  assert.deepEqual({ ...boxInfo(canvas.get('b2')), id: undefined }, { id: undefined, name: '鹈鹕', owner: null, lock: null })
  await cleanup()
})

test('helpers write as the Team member that started them', async () => {
  const { canvas, cleanup } = await scene()
  const { team, lead } = host(canvas)
  const teammate = { id: 'T', member: { name: 'pelican', root: lead }, session: { header: { id: 'T', origin: 'subagent', parentSession: 'L' } } }
  const helper = { id: 'H', session: { header: { id: 'H', origin: 'subagent', parentSession: 'T' } } }
  team.ctx.agents.get = id => ({ L: lead, T: teammate })[id]
  assert.deepEqual(team.writerOf(teammate), { name: 'pelican', lead: 'L', sessionId: 'T' })
  assert.deepEqual(team.writerOf(helper), { name: 'pelican', lead: 'L', sessionId: 'T' })
  assert.deepEqual(team.writerOf(lead), { name: 'lead', lead: 'L', sessionId: 'L' })
  await cleanup()
})
