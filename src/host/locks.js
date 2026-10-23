// Lock rules shared by the agent tools and the canvas UI routes. A box's lock
// keeps everyone but its holder out: out of the box itself and out of every
// element lying in it. The canvas lead may lift a lock held by an agent, and
// locking a teammate's box again gives it back; only the user lifts their own,
// and the user may lift any.
import { randomBytes } from 'node:crypto'
import { boxInfo, lockHolder, lockedAgainst, mindmapData, sameAgent, touchesBox, withMindmapData } from '../shared/scene.js'

/** Whether `writer` is the canvas lead: the canvas's own Session, Lead of its Agent Team. */
export function isCanvasLead(canvas, writer) {
  return writer !== 'user' && canvas.sessionId !== null && writer.lead === canvas.sessionId && writer.name === 'lead'
}

/** An agent or the user as `viewer` reads it. */
export function describeAgent(canvas, agent, viewer) {
  if (agent === 'user') return viewer === 'user' ? 'you' : 'the user'
  if (sameAgent(agent, viewer)) return 'you'
  if (agent.lead === canvas.sessionId) return agent.name === 'lead' ? 'the canvas lead' : `teammate "${agent.name}"`
  return agent.name === 'lead' ? `session ${agent.lead}` : `agent "${agent.name}" of session ${agent.lead}`
}

export function boxLabel(frame) {
  return `box "${boxInfo(frame).name}" (${frame.id})`
}

/** The first of `frames` locked against `writer` that `element` lies in. */
export function lockedBoxOf(element, frames, writer) {
  return frames.find(frame => frame.id !== element.id && lockedAgainst(frame, writer) && touchesBox(element, frame))
}

/** Why an agent cannot change a box locked against it, and what it can do instead. */
export function lockRefusal(canvas, frame, writer, subject = boxLabel(frame)) {
  const holder = lockHolder(frame)
  const who = describeAgent(canvas, holder, writer)
  if (holder === 'user') return `${subject} is locked by the user; only the user can unlock it, so ask them or work elsewhere`
  if (isCanvasLead(canvas, writer)) {
    return `${subject} is locked by ${who}; agree on the change with ${holder.name} (send_message), who can do it, or unlock the box with {"id": "${frame.id}", "lock": false}, make the change and lock it again with {"id": "${frame.id}", "lock": true}, which gives it back to ${holder.name}`
  }
  if (holder.lead === writer.lead) return `${subject} is locked by ${who}; ask ${holder.name} or the lead with send_message to change it or make room`
  return `${subject} is locked by ${who}; work elsewhere or ask the user`
}

/** Whether `writer` may lift the lock of `frame`. */
export function mayUnlock(canvas, frame, writer) {
  const holder = lockHolder(frame)
  if (!holder) return true
  if (writer === 'user') return true
  if (holder === 'user') return false
  return sameAgent(holder, writer) || isCanvasLead(canvas, writer)
}

/**
 * Box data after `writer` locks (`true`) or unlocks (`false`) it: an agent locking a box without an owner becomes its owner,
 * as does a teammate locking a box the canvas lead owns (the lead hands out boxes it drew), and the canvas lead locking
 * a box its teammate owns gives the lock back to that teammate.
 */
export function lockData(canvas, frame, lock, writer) {
  if (!lock) return { lock: null, stamp: newStamp() }
  if (writer === 'user') return { lock: 'user', stamp: newStamp() }
  const owner = boxInfo(frame).owner
  if (owner && isCanvasLead(canvas, writer) && owner.lead === writer.lead && !sameAgent(owner, writer)) return { lock: owner, stamp: newStamp() }
  const agent = { name: writer.name, lead: writer.lead, sessionId: writer.sessionId }
  const handedOut = owner && isCanvasLead(canvas, owner) && owner.lead === writer.lead
  return { owner: owner && !handedOut ? owner : agent, lock: agent, stamp: newStamp() }
}

export function newStamp() {
  return randomBytes(6).toString('base64url')
}

const LOCK_KEYS = new Set(['version', 'versionNonce', 'updated', 'customData', 'locked'])

// Excalidraw fills in what a loaded scene leaves out, e.g. `boundElements: []` for null.
const field = value => JSON.stringify(value === undefined || (Array.isArray(value) && value.length === 0) ? null : value)

function onlyLockChanged(before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (LOCK_KEYS.has(key)) continue
    if (field(before[key]) !== field(after[key])) return false
  }
  const strip = element => {
    const customData = { ...(element.customData ?? {}) }
    delete customData.mindmap
    return JSON.stringify(customData)
  }
  return !after.isDeleted && strip(before) === strip(after)
}

/**
 * Decide one element change sent by the canvas UI against the boxes as they stand.
 * @returns the id of the box whose lock refuses the change, or undefined.
 */
export function userChangeBlockedBy(frames, before, after) {
  if (after.type === 'frame') {
    if (!before || before.isDeleted || !lockedAgainst(before, 'user')) return undefined
    // While an agent holds a box, the user can still lift or take over its lock.
    return onlyLockChanged(before, after) ? undefined : before.id
  }
  for (const state of [before, after]) {
    if (!state || state.isDeleted) continue
    const frame = lockedBoxOf(state, frames, 'user')
    if (frame) return frame.id
  }
  return undefined
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The box data the Host keeps for a frame sent by the canvas UI. The owner is
 * the Host's; a lock change applies only when the page saw the current lock
 * (its `stamp`), and the UI may only set the user's lock, lift a lock, or
 * give the lock back to the box's owner (an undo of lifting it).
 * @returns the frame to store, `element` itself when nothing was corrected.
 */
export function settleUserBox(current, element) {
  const now = current && !current.isDeleted ? boxInfo(current) : { owner: null, lock: null }
  const sent = mindmapData(element) ?? {}
  const nowStamp = (current && !current.isDeleted ? mindmapData(current)?.stamp : undefined) ?? null
  let lock = now.lock
  let stamp = nowStamp
  if ((sent.stamp ?? null) === nowStamp) {
    const wanted = sent.lock ?? null
    if (!sameValue(wanted, lock) && (wanted === 'user' || wanted === null || sameAgent(wanted, now.owner))) {
      lock = wanted === null || wanted === 'user' ? wanted : now.owner
      stamp = newStamp()
    }
  }
  const settled = { owner: now.owner, lock, stamp }
  if (sameValue(sent.owner, settled.owner) && sameValue(sent.lock, settled.lock) && sameValue(sent.stamp, settled.stamp)) return element
  return withMindmapData(element, settled)
}
