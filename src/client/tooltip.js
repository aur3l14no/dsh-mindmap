// Excalidraw places its shared tooltip outside the board and retains it after unmount.
export function cleanUpTooltip(document) {
  queueMicrotask(() => {
    if (!document.querySelector('.mm-board .excalidraw-container')) {
      document.querySelector('.excalidraw-tooltip')?.remove()
    }
  })
}
