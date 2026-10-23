// Browser half of scripts/parity.mjs: Excalidraw's own export of the scene, each
// case laid next to the Host renderer's image of it. The sheet goes to `window.__result`.
import { exportToCanvas } from '@excalidraw/excalidraw'

window.EXCALIDRAW_ASSET_PATH = '/assets/excalidraw/'

const PAIRS_PER_ROW = 3
const GAP = 24
const LABEL = 36

const loadImage = src => new Promise((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = reject
  image.src = src
})

async function run() {
  const { elements, cells, scale, cellWidth, cellHeight } = await (await fetch('scene.json')).json()
  const excalidraw = await exportToCanvas({
    elements,
    appState: { viewBackgroundColor: '#ffffff', exportBackground: true },
    files: {},
    exportPadding: 0,
    getDimensions: (width, height) => ({ width: width * scale, height: height * scale, scale }),
  })
  const width = cellWidth * scale
  const height = cellHeight * scale
  const rows = Math.ceil(cells.length / PAIRS_PER_ROW)
  const sheet = document.createElement('canvas')
  sheet.width = PAIRS_PER_ROW * 2 * width + (PAIRS_PER_ROW - 1) * GAP
  sheet.height = rows * (LABEL + height) + (rows - 1) * GAP
  const context = sheet.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, sheet.width, sheet.height)
  context.font = '20px sans-serif'
  context.lineWidth = 2
  context.strokeStyle = '#dee2e6'
  for (const [index, cell] of cells.entries()) {
    const left = (index % PAIRS_PER_ROW) * (2 * width + GAP)
    const top = Math.floor(index / PAIRS_PER_ROW) * (LABEL + height + GAP)
    context.fillStyle = '#495057'
    context.fillText(`${index} · ${cell.name}`, left + 8, top + 26)
    context.drawImage(excalidraw, cell.x * scale, cell.y * scale, width, height, left, top + LABEL, width, height)
    context.drawImage(await loadImage(cell.host), 0, cell.top, width, height, left + width, top + LABEL, width, height)
    context.strokeRect(left, top + LABEL, width, height)
    context.strokeRect(left + width, top + LABEL, width, height)
  }
  window.__result = { png: sheet.toDataURL('image/png') }
}

run().catch(error => { window.__result = { error: String(error?.stack ?? error) } })
