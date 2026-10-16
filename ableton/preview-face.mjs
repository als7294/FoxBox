// A rough SVG of the device's face from its presentation rects (panels, texts, controls), to check the layout without
// Max. Not what Max draws: Live's own controls look like Live's.
//   node --no-warnings ableton/preview-face.mjs <out.svg>
import { writeFileSync } from 'node:fs'
import { devicePatcher, DEVICE_WIDTH } from '../app/src/main/ableton/foxbox-ableton.ts'

const { patcher } = devicePatcher({ port: 47400, secret: '0'.repeat(32) })
const rgba = (c, fallback) => (c ? `rgba(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(',')},${c[3] ?? 1})` : fallback)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const boxes = patcher.boxes.map((b) => b.box).filter((b) => b.presentation_rect)
const order = (b) => (b.maxclass === 'panel' ? 0 : 1)
const parts = boxes.sort((a, b) => order(a) - order(b)).map((b) => {
  const [x, y, w, h] = b.presentation_rect
  if (b.maxclass === 'panel')
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${b.rounded ?? 0}" fill="${rgba(b.bgcolor, '#333')}" stroke="${b.border ? rgba(b.bordercolor, 'none') : 'none'}"/>`
  if (b.maxclass === 'comment') {
    const anchor = b.textjustification === 2 ? 'end' : 'start'
    const tx = anchor === 'end' ? x + w : x
    const weight = /Bold/.test(b.fontname ?? '') ? 700 : 500
    return `<text x="${tx}" y="${y + (b.fontsize ?? 8) + 1}" font-size="${b.fontsize ?? 8}" font-weight="${weight}" text-anchor="${anchor}" fill="${rgba(b.textcolor, '#aaa')}" font-family="Helvetica">${esc(b.text || '·')}</text>`
  }
  const label = b.maxclass === 'live.text' ? b.text : b.maxclass === 'live.numbox' ? 'C#2' : b.maxclass === 'live.menu' ? 'Thru' : ''
  const ring = b.maxclass === 'live.dial' ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2 - 2}" fill="none" stroke="rgba(255,138,61,0.9)" stroke-width="3"/>` : ''
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.25)"/>${ring}<text x="${x + 2}" y="${y + Math.min(h - 2, (b.fontsize ?? 8) + 1)}" font-size="${Math.min(b.fontsize ?? 8, h)}" fill="#eee" font-family="Helvetica">${esc(label)}</text>`
})
writeFileSync(process.argv[2], `<svg xmlns="http://www.w3.org/2000/svg" width="${DEVICE_WIDTH * 2}" height="338" viewBox="0 0 ${DEVICE_WIDTH} 169">${parts.join('')}</svg>\n`)
console.log(`${boxes.length} shown boxes`)
