// Rasterise the product icons (CPU: Chrome's software renderer) at each size, and the A / B contact sheet.
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
const APP = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '')
const DIR = APP + '/design/brand/icons'
const { chromium } = createRequire(APP + '/package.json')('@playwright/test')
const PRODUCTS = ['strings', 'voice', 'visuals']
const OPTIONS = ['a', 'b']
const SIZES = [1024, 512, 256, 128, 64, 32, 16]
const bareUri = (o, p) => 'data:image/svg+xml;base64,' + readFileSync(`${DIR}/bare/${o.toUpperCase()}/fox-${p}.svg`).toString('base64')
const uri = (n) => 'data:image/svg+xml;base64,' + readFileSync(`${DIR}/foxbox-${n}.svg`).toString('base64')
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] })
const page = await browser.newPage({ deviceScaleFactor: 1 })
for (const s of SIZES) {
  rmSync(`${DIR}/${s}`, { recursive: true, force: true })
  mkdirSync(`${DIR}/${s}`, { recursive: true })
}
for (const p of PRODUCTS)
  for (const o of OPTIONS)
    for (const s of SIZES) {
      await page.setViewportSize({ width: s, height: s })
      await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${uri(`${p}-${o}`)}" width="${s}" height="${s}" style="display:block">`)
      await page.locator('img').evaluate((i) => i.decode())
      await page.screenshot({ path: `${DIR}/${s}/foxbox-${p}-${o}-${s}.png`, omitBackground: true })
    }
// the sheet: (A) and (B) side by side, each product at 512 and at 32, on dark and on light
const label = { a: 'A · the mark\'s head (the user\'s pick)', b: 'B · a fox per product (alternate)' }
const block = (o, ink) => `<div style="display:flex;flex-direction:column;gap:26px">
  <div style="font:700 26px Helvetica;color:${ink}">${label[o]}</div>
  <div style="display:flex;gap:28px">${PRODUCTS.map((p) => `<img src="${uri(`${p}-${o}`)}" width="512" height="512">`).join('')}</div>
  <div style="display:flex;gap:30px;align-items:center;font:600 20px Helvetica;color:${ink}">${PRODUCTS.map((p) => `<img src="${uri(`${p}-${o}`)}" width="32" height="32"><span style="margin-right:30px">${p[0].toUpperCase() + p.slice(1)}</span>`).join('')}<span style="opacity:.55;margin-left:auto">512 · 32 px</span></div>
  <div style="display:flex;gap:44px;align-items:center;font:600 20px Helvetica;color:${ink}"><span style="opacity:.55">bare</span>${PRODUCTS.map((p) => `<img src="${bareUri(o, p)}" style="height:96px"><img src="${bareUri(o, p)}" style="height:52px">`).join('')}<span style="opacity:.55;margin-left:auto">96 · 52 px</span></div></div>`
const panel = (bg, ink, opts) => `<div style="background:${bg};padding:48px 56px;display:flex;gap:72px">${opts.map((o) => block(o, ink)).join('')}</div>`
// the chosen set (A) on its own, and the A / B comparison
for (const [file, opts] of [['foxbox-icons-sheet.png', ['a']], ['foxbox-icons-sheet-ab.png', ['a', 'b']]]) {
  await page.setViewportSize({ width: 3600, height: 1600 })
  await page.setContent(`<style>html,body{margin:0}#s{display:inline-block}</style><div id="s">${panel('#15100D', '#F6EFE6', opts)}${panel('#F4F1EC', '#1C1611', opts)}</div>`)
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())))
  const box = await page.locator('#s').boundingBox()
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) })
  await page.locator('#s').screenshot({ path: `${DIR}/${file}` })
}
await browser.close()
console.log('done')
