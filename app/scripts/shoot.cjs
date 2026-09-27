// Screenshot helper (dev only): renders a URL in a hidden Electron window and saves PNGs.
//   npx electron scripts/shoot.cjs <url> <outDir> <width> <height> <steps.json>
// steps.json: [{ "name": "01-studio", "wait": 5000, "js": "optional script run before the capture" }, ...]
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const [url, outDir, w, h, stepsFile] = process.argv.slice(2)
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({ width: Number(w), height: Number(h), show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } })
  await win.loadURL(url)
  for (const step of steps) {
    if (step.js) await win.webContents.executeJavaScript(step.js).catch((e) => console.error(step.name, e.message))
    await sleep(step.wait ?? 800)
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${step.name}.png`), img.toPNG())
    console.log('shot', step.name, img.getSize())
  }
  app.quit()
})
