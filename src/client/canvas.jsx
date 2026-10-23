// The Mindmap page: pick a workspace canvas and edit it in Excalidraw. A box
// (a frame, drawn with the F tool) can get its own agent, and the canvas
// lead's conversation runs under the canvas. Loaded on first visit as a lazy chunk.
import { Excalidraw, newElementWith } from '@excalidraw/excalidraw'
import excalidrawCss from '@excalidraw/excalidraw/index.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boxInfo, isBox, lockHolder, withMindmapData } from '../shared/scene.js'
import { api } from './api.js'
import { ChatDock } from './chat.jsx'
import { MindmapIcon } from './icons.jsx'
import { AskPopover, BoxBadges } from './overlay.jsx'
import { AgentPresence } from './presence.js'
import pageCss from './styles.css'
import { SceneSync } from './sync.js'

const LAST_CANVAS = 'dsh-mindmap:last-canvas'
const TOAST_MS = 5000

export function CanvasPage({ t, openSession, chat, colorScheme, language }) {
  const [workspaces, setWorkspaces] = useState(null)
  const [error, setError] = useState(null)
  const [choice, setChoice] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LAST_CANVAS)) ?? {}
    } catch {
      return {}
    }
  })
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { workspaces: list } = await api('workspaces')
      setWorkspaces(list)
      setError(null)
      return list
    } catch (reason) {
      setError(reason.message)
      return null
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const workspace = workspaces?.find(item => item.id === choice.workspaceId)
    ?? workspaces?.find(item => item.canvases.length > 0) ?? workspaces?.[0]
  const name = workspace?.canvases.includes(choice.name) ? choice.name : workspace?.canvases[0]
  const choose = next => {
    setChoice(next)
    localStorage.setItem(LAST_CANVAS, JSON.stringify(next))
  }

  return (
    <div className="mm-page">
      <style>{pageCss}</style>
      <div className="mm-bar">
        <span className="mm-bar-title">{t('panel')}</span>
        {workspaces && workspaces.length > 0 && (
          <>
            <label className="mm-field">
              {t('workspace')}
              <select className="mm-select" value={workspace?.id ?? ''} onChange={event => choose({ workspaceId: event.target.value })}>
                {workspaces.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            {workspace?.canvases.length > 0 && (
              <label className="mm-field">
                {t('canvas')}
                <select className="mm-select" value={name} onChange={event => choose({ workspaceId: workspace.id, name: event.target.value })}>
                  {workspace.canvases.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            )}
            {creating
              ? <NewCanvasForm t={t} onCancel={() => setCreating(false)} onCreate={async canvasName => {
                  await api('canvases', { method: 'POST', body: { workspaceId: workspace.id, name: canvasName } })
                  await refresh()
                  choose({ workspaceId: workspace.id, name: canvasName })
                  setCreating(false)
                }} />
              : <button type="button" className="mm-button" onClick={() => setCreating(true)}>{t('newCanvas')}</button>}
          </>
        )}
        <span className="mm-spacer" />
        {workspace && name && <span className="mm-caption" title={`${workspace.path}/.mindmaps/${name}`}>{`.mindmaps/${name}`}</span>}
      </div>
      {error && <div className="mm-empty">{t('loadFailed', { error })}</div>}
      {!error && workspaces === null && <div className="mm-empty">{t('loading')}</div>}
      {!error && workspaces?.length === 0 && <div className="mm-empty">{t('noWorkspaces')}</div>}
      {!error && workspace && !name && (
        <div className="mm-empty">
          <MindmapIcon size={48} />
          <span>{t('noCanvases')}</span>
          {!creating && <button type="button" className="mm-button mm-primary" onClick={() => setCreating(true)}>{t('newCanvas')}</button>}
        </div>
      )}
      {workspace && name && (
        <Board key={`${workspace.id}/${name}`} t={t} workspaceId={workspace.id} name={name}
          chat={chat} openSession={openSession} colorScheme={colorScheme} language={language} />
      )}
    </div>
  )
}

function NewCanvasForm({ t, onCreate, onCancel }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(null)
  return (
    <form className="mm-field" onSubmit={async event => {
      event.preventDefault()
      try {
        await onCreate(value.trim())
      } catch (reason) {
        setError(reason.message)
      }
    }}>
      <input className="mm-input" autoFocus placeholder={t('canvasName')} value={value} onChange={event => setValue(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') onCancel() }} />
      <button type="submit" className="mm-button mm-primary" disabled={!value.trim()}>{t('create')}</button>
      <button type="button" className="mm-button" onClick={onCancel}>{t('cancel')}</button>
      {error && <span className="mm-error">{error}</span>}
    </form>
  )
}

/** The canvas lead's teammates that own boxes here, with the boxes they own. */
function boxMembers(frames, leadId) {
  const members = new Map()
  for (const frame of frames) {
    const { name, owner } = boxInfo(frame)
    if (!owner || owner.lead !== leadId || owner.name === 'lead') continue
    const member = members.get(owner.name) ?? { name: owner.name, sessionId: owner.sessionId, boxes: [] }
    member.sessionId ??= owner.sessionId
    member.boxes.push(name)
    members.set(owner.name, member)
  }
  return [...members.values()]
}

function Board({ t, workspaceId, name, chat, openSession, colorScheme, language }) {
  const [initial, setInitial] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [online, setOnline] = useState(true)
  const [toast, setToast] = useState(null)
  const [scene, setScene] = useState({ frames: [], selectedIds: [], view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 } })
  // The box a new agent is being asked for; `focus` right after the box was drawn.
  const [asking, setAsking] = useState(null)
  const [member, setMember] = useState(null)
  const excalidrawRef = useRef(null)
  const boardRef = useRef(null)
  const drawingRef = useRef(null)
  const frameRef = useRef(0)
  const sceneKey = useRef('')
  const toastTimer = useRef(null)

  const say = useCallback(message => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const holderName = holder => holder === 'user' ? t('you') : holder?.name ?? '?'
  const presence = useMemo(() => new AgentPresence(t), [workspaceId, name])
  presence.t = t
  const sync = useMemo(() => new SceneSync(workspaceId, name, {
    onRefused: refused => {
      const frame = excalidrawRef.current?.getSceneElements().find(element => element.id === refused[0].boxId)
      say(t('refusedLocked', { box: frame ? boxInfo(frame).name : refused[0].boxId, holder: holderName(frame && lockHolder(frame)) }))
    },
    onConnection: setOnline,
    onActivity: agents => presence.update(agents),
  }), [workspaceId, name])

  useEffect(() => {
    let cancelled = false
    sync.load().then(data => {
      if (cancelled) return
      setInitial(data)
      presence.update(data.activity)
    }, reason => !cancelled && setLoadError(reason.message))
    return () => {
      cancelled = true
      sync.dispose()
      presence.dispose()
      clearTimeout(toastTimer.current)
      cancelAnimationFrame(frameRef.current)
    }
  }, [sync])

  const focusCanvas = useCallback(() => boardRef.current?.querySelector('.excalidraw-container')?.focus({ preventScroll: true }), [])

  const onApi = useCallback(excalidraw => {
    if (!excalidraw || excalidrawRef.current === excalidraw) return
    excalidrawRef.current = excalidraw
    sync.attach(excalidraw)
    presence.attach(excalidraw)
  }, [sync])

  /** A box just drawn gets a name and, when boxes can have agents, the ask popover. */
  const finishGestures = useCallback((elements, appState) => {
    const drawing = appState.newElement?.id ?? null
    const finished = drawingRef.current !== drawing ? drawingRef.current : null
    drawingRef.current = drawing
    const frame = finished && elements.find(element => element.id === finished && isBox(element))
    if (!frame) return
    if (!frame.name) {
      const used = new Set(elements.filter(isBox).map(item => item.name))
      let n = 0
      let boxName
      do boxName = t('boxDefaultName', { n: ++n }); while (used.has(boxName))
      sync.editElements([newElementWith(frame, { name: boxName })])
    }
    if (initial?.teams) setAsking({ boxId: frame.id, focus: true, seen: false })
  }, [sync, t, initial])

  const onChange = useCallback((_elements, _appState, files) => {
    const excalidraw = excalidrawRef.current
    if (!excalidraw) return
    sync.noteLocalChange(excalidraw.getSceneElementsIncludingDeleted(), files)
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      const live = excalidraw.getSceneElements()
      const state = excalidraw.getAppState()
      finishGestures(live, state)
      const next = {
        frames: live.filter(isBox),
        selectedIds: Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id]),
        view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, width: state.width, height: state.height },
      }
      // Excalidraw reports every state change, agent cursors included; the overlay only follows boxes, selection and view.
      const key = JSON.stringify([next.frames.map(frame => [frame.id, frame.version]), next.selectedIds, next.view])
      if (key === sceneKey.current) return
      sceneKey.current = key
      setScene(next)
    })
  }, [sync, finishGestures])

  const selectedBox = scene.selectedIds.length === 1 ? scene.frames.find(frame => frame.id === scene.selectedIds[0]) : undefined
  const members = initial ? boxMembers(scene.frames, initial.sessionId) : []
  // Selecting a box with an agent turns the chat to that agent, or to the lead when the box is the lead's.
  useEffect(() => {
    const owner = selectedBox && boxInfo(selectedBox).owner
    if (!owner || owner.lead !== initial?.sessionId) return
    const found = members.find(item => item.name === owner.name)
    if (owner.name === 'lead') setMember(null)
    else if (found?.sessionId) setMember(found)
  }, [selectedBox?.id])
  // The ask popover closes once its box is no longer selected.
  useEffect(() => {
    if (!asking) return
    if (scene.selectedIds.includes(asking.boxId)) {
      if (!asking.seen) setAsking({ ...asking, seen: true })
    } else if (asking.seen || scene.selectedIds.length > 0) {
      setAsking(null)
    }
  }, [scene.selectedIds.join(), asking?.boxId])

  const current = id => excalidrawRef.current.getSceneElements().find(element => element.id === id)
  const setLock = (frame, lock) => {
    const latest = current(frame.id) ?? frame
    // The canvas shows a box an agent holds locked; the stored element keeps its own `locked`.
    sync.editElements([newElementWith(latest, {
      locked: sync.host.get(frame.id)?.locked ?? false,
      customData: withMindmapData(latest, { lock: lock ? 'user' : null }).customData,
    })])
  }
  // The popover had the keyboard; the canvas takes it back so its shortcuts work again.
  const closeAsk = () => {
    setAsking(null)
    focusCanvas()
  }
  const ask = async (boxId, instruction) => {
    await sync.flush()
    const result = await api('member', { method: 'POST', body: { workspaceId, name, boxId, instruction } })
    closeAsk()
    setMember({ ...result.member, boxes: [] })
  }

  if (loadError) return <div className="mm-empty">{t('loadFailed', { error: loadError })}</div>
  if (!initial) return <div className="mm-empty">{t('loading')}</div>

  const askFrame = asking && scene.frames.find(frame => frame.id === asking.boxId)
  const chatMember = member && (members.find(item => item.name === member.name) ?? member)
  return (
    <>
      <div ref={boardRef} className="mm-board">
        <style>{excalidrawCss}</style>
        <Excalidraw
          excalidrawAPI={onApi}
          autoFocus
          initialData={{ elements: initial.elements, files: initial.files, appState: initial.appState, scrollToContent: true }}
          onChange={onChange}
          theme={colorScheme}
          langCode={language === 'zh' ? 'zh-CN' : 'en'}
          name={name}
          onUserFollow={({ userToFollow, action }) => action === 'FOLLOW' && presence.goTo(userToFollow.socketId)}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false } }}
        />
        <BoxBadges
          t={t}
          view={scene.view}
          frames={scene.frames}
          selectedId={selectedBox?.id}
          chatWith={chatMember?.name ?? null}
          members={initial.teams}
          onChat={owner => setMember(members.find(item => item.name === owner.name) ?? null)}
          onLock={setLock}
          onAsk={boxId => setAsking({ boxId, focus: true, seen: true })}
        />
        {askFrame && (
          <AskPopover key={askFrame.id} t={t} frame={askFrame} view={scene.view} autoFocus={asking.focus}
            onSubmit={instruction => ask(askFrame.id, instruction)} onClose={closeAsk} />
        )}
        {(toast || !online) && <div className="mm-toast" role="status">{toast ?? t('reconnecting')}</div>}
      </div>
      <ChatDock t={t} chat={chat} leadId={initial.sessionId} members={members} member={chatMember}
        onMember={setMember} openSession={openSession} focusCanvas={focusCanvas} />
    </>
  )
}
