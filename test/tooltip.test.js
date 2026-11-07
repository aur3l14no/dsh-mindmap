import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanUpTooltip } from '../src/client/tooltip.js'

test('removes the body tooltip after the last board unmounts', async () => {
  let removed = false
  const document = { querySelector: selector => selector === '.excalidraw-tooltip' ? { remove: () => { removed = true } } : null }
  cleanUpTooltip(document)
  assert.equal(removed, false)
  await Promise.resolve()
  assert.equal(removed, true)
})

test('keeps the shared tooltip when another board is mounted', async () => {
  let removed = false
  const document = { querySelector: selector => selector === '.mm-board .excalidraw-container' ? {} : { remove: () => { removed = true } } }
  cleanUpTooltip(document)
  await Promise.resolve()
  assert.equal(removed, false)
})

test('allows the tooltip to be absent', async () => {
  cleanUpTooltip({ querySelector: () => null })
  await Promise.resolve()
})
