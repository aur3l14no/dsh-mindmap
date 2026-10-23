// Excalidraw font identities and the vertical metrics its text layout uses
// (`FONT_METADATA` in @excalidraw/excalidraw 0.18).

export const FONT_FAMILY = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  'Lilita One': 7,
  'Comic Shanns': 8,
  'Liberation Sans': 9,
}

export const DEFAULT_FONT_FAMILY = FONT_FAMILY.Excalifont
export const DEFAULT_FONT_SIZE = 20
export const BOUND_TEXT_PADDING = 5

const METRICS = {
  1: { unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25 },
  2: { unitsPerEm: 2048, ascender: 1577, descender: -471, lineHeight: 1.15 },
  3: { unitsPerEm: 2048, ascender: 1900, descender: -480, lineHeight: 1.2 },
  5: { unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25 },
  6: { unitsPerEm: 1000, ascender: 1011, descender: -353, lineHeight: 1.35 },
  7: { unitsPerEm: 1000, ascender: 923, descender: -220, lineHeight: 1.15 },
  8: { unitsPerEm: 1000, ascender: 750, descender: -250, lineHeight: 1.25 },
  9: { unitsPerEm: 2048, ascender: 1854, descender: -434, lineHeight: 1.15 },
}

export function fontMetrics(fontFamily) {
  return METRICS[fontFamily] ?? METRICS[DEFAULT_FONT_FAMILY]
}

export function lineHeightOf(fontFamily) {
  return fontMetrics(fontFamily).lineHeight
}

/** Baseline offset of the first line, as Excalidraw's `getVerticalOffset`. */
export function verticalOffset(fontFamily, fontSize, lineHeightPx) {
  const { unitsPerEm, ascender, descender } = fontMetrics(fontFamily)
  const em = fontSize / unitsPerEm
  const lineGap = (lineHeightPx - em * ascender + em * descender) / 2
  return em * ascender + lineGap
}
