// Build the browser bundles and the Host rendering assets.
//
//   client.js           small entry: registers the Mindmap page and sidebar item
//   client.canvas.js    lazy chunk with Excalidraw and the canvas UI
//   assets/excalidraw/  Excalidraw's browser fonts, served by the Host
//   assets/fonts/       merged OpenType fonts used by Host-side PNG export, and
//                       Xiaolai's subsets with an index of the characters each holds
//   assets/font-metrics.json  advance widths used to measure text on the Host
import { build } from 'esbuild'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const manifest = JSON.parse(await readFile(`${root}package.json`, 'utf8'))
const excalidrawDist = `${root}node_modules/@excalidraw/excalidraw/dist/prod`

// Excalidraw font families by numeric id, with the directory holding their
// subset files. Helvetica (2) is a system font in Excalidraw; Liberation Sans
// is its metric-compatible stand-in for Host rendering.
const FONT_SOURCES = [
  { ids: [5], dir: 'Excalifont', family: 'Excalifont' },
  { ids: [6], dir: 'Nunito', family: 'Nunito' },
  { ids: [7], dir: 'Lilita', family: 'Lilita One' },
  { ids: [8], dir: 'ComicShanns', family: 'Comic Shanns' },
  { ids: [1], dir: 'Virgil', family: 'Virgil' },
  { ids: [3], dir: 'Cascadia', family: 'Cascadia' },
  { ids: [9, 2], dir: 'Liberation', family: 'Liberation Sans' },
]

async function buildFonts() {
  const wawoff2 = require('wawoff2')
  const opentype = require('opentype.js')
  await rm(`${root}assets/fonts`, { recursive: true, force: true })
  await mkdir(`${root}assets/fonts`, { recursive: true })
  const metrics = {}
  for (const source of FONT_SOURCES) {
    const files = (await readdir(`${excalidrawDist}/fonts/${source.dir}`)).filter(name => name.endsWith('.woff2')).sort()
    const fonts = []
    for (const file of files) {
      const ttf = await wawoff2.decompress(await readFile(`${excalidrawDist}/fonts/${source.dir}/${file}`))
      fonts.push(opentype.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength)))
    }
    // Excalidraw ships each family as unicode-range subsets; one merged face
    // lets the rasterizer find every glyph under a single family name.
    const glyphs = [fonts[0].glyphs.get(0)]
    const advances = {}
    for (const font of fonts) {
      for (let index = 0; index < font.glyphs.length; index += 1) {
        const glyph = font.glyphs.get(index)
        const codes = (glyph.unicodes ?? []).filter(code => code > 0 && advances[code] === undefined)
        if (codes.length === 0) continue
        for (const code of codes) advances[code] = glyph.advanceWidth
        glyphs.push(new opentype.Glyph({
          name: glyph.name || `uni${codes[0].toString(16)}`,
          unicode: codes[0],
          unicodes: codes,
          advanceWidth: glyph.advanceWidth,
          path: glyph.path,
        }))
      }
    }
    const merged = new opentype.Font({
      familyName: source.family,
      styleName: 'Regular',
      unitsPerEm: fonts[0].unitsPerEm,
      ascender: fonts[0].ascender,
      descender: fonts[0].descender,
      glyphs,
    })
    const file = `${source.dir}.otf`
    await writeFile(`${root}assets/fonts/${file}`, Buffer.from(merged.toArrayBuffer()))
    const values = Object.values(advances)
    const entry = {
      family: source.family,
      file,
      unitsPerEm: fonts[0].unitsPerEm,
      averageAdvance: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      advances,
    }
    for (const id of source.ids) metrics[id] = entry
  }
  await buildXiaolai(metrics[5], wawoff2, opentype)
  await writeFile(`${root}assets/font-metrics.json`, JSON.stringify(metrics))
}

// Excalidraw draws what Excalifont lacks, mostly CJK, in Xiaolai, and measures it
// with Xiaolai's widths. Its subsets add up to 22 MB, so they stay separate files
// and a Host render loads only those holding the characters it draws.
async function buildXiaolai(excalifont, wawoff2, opentype) {
  const dir = `${excalidrawDist}/fonts/Xiaolai`
  await mkdir(`${root}assets/fonts/Xiaolai`)
  const files = (await readdir(dir)).filter(name => name.endsWith('.woff2')).sort()
  const ranges = []
  let family
  for (const [index, file] of files.entries()) {
    const ttf = await wawoff2.decompress(await readFile(`${dir}/${file}`))
    await writeFile(`${root}assets/fonts/Xiaolai/${index}.ttf`, ttf)
    const font = opentype.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength))
    family ??= font.getEnglishName('fontFamily')
    const map = font.tables.cmap.glyphIndexMap
    for (const code of Object.keys(map).map(Number).sort((a, b) => a - b)) {
      excalifont.advances[code] ??= font.glyphs.get(map[code]).advanceWidth * excalifont.unitsPerEm / font.unitsPerEm
      const last = ranges.at(-1)
      if (last && last[2] === index && last[1] === code - 1) last[1] = code
      else ranges.push([code, code, index])
    }
  }
  // `ranges` holds [first, last, file] runs of code points, file being `<file>.ttf`.
  await writeFile(`${root}assets/fonts/Xiaolai/index.json`, JSON.stringify({ family, ranges }))
}

async function copyBrowserFonts() {
  await rm(`${root}assets/excalidraw`, { recursive: true, force: true })
  await cp(`${excalidrawDist}/fonts`, `${root}assets/excalidraw/fonts`, { recursive: true })
}

// Keep the bundle to the two UI languages DSH ships; other Excalidraw locales
// resolve to English. Mermaid conversion (the text-to-diagram dialog) is not
// offered, so its large dependency is replaced by a stub.
const trimExcalidraw = {
  name: 'trim-excalidraw',
  setup(build) {
    build.onResolve({ filter: /^\.\/locales\/[^/]+\.js$/ }, args => {
      if (!args.importer.includes('@excalidraw/excalidraw')) return undefined
      if (/\/(en|zh-CN)-[A-Z0-9]+\.js$/.test(args.path)) return undefined
      return { path: 'excalidraw-locale-fallback', namespace: 'stub' }
    })
    build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({ path: 'mermaid', namespace: 'stub' }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: args.path === 'mermaid'
        ? 'export async function parseMermaidToExcalidraw() { throw new Error("Mermaid import is not available in Mindmap") }'
        : 'export default {}',
      loader: 'js',
    }))
  },
}

async function bundle(entry, chunk) {
  const result = await build({
    entryPoints: [`${root}src/client/${entry}`],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    conditions: ['production'],
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    jsx: 'automatic',
    loader: { '.css': 'text', '.svg': 'text' },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    plugins: [trimExcalidraw],
    metafile: true,
  })
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (!dependency.external) continue
      if (!['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'].includes(dependency.path)) {
        throw new Error(`Unexpected runtime dependency in ${entry}: ${dependency.path}`)
      }
    }
  }
  return `/* ${manifest.name} ${manifest.version}; see THIRD_PARTY_NOTICES.md. */\n`
    + `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},${chunk ? `chunk:${JSON.stringify(chunk)},` : ''}factory(require){\n`
    + 'const module={exports:{}};const exports=module.exports;\n'
    + result.outputFiles[0].text
    + '\nreturn module.exports;\n}});\n'
}

async function buildClient() {
  const canvas = await bundle('canvas.jsx', 'client.canvas.js')
  const entry = await bundle('index.jsx')
  await writeFile(`${root}client.canvas.js`, canvas)
  // The module system derives chunk revisions from client.js, so it is written last.
  await writeFile(`${root}client.js`, entry)
  console.log(`client.js ${Buffer.byteLength(entry).toLocaleString()} bytes; client.canvas.js ${Buffer.byteLength(canvas).toLocaleString()} bytes`)
}

const steps = new Set(process.argv.slice(2))
const all = steps.size === 0
if (all || steps.has('fonts')) {
  await buildFonts()
  await copyBrowserFonts()
}
if (all || steps.has('client')) await buildClient()
