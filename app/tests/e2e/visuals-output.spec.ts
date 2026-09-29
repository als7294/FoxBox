import { expect, test } from '@playwright/test'
import { launchApp, waitReady, waitWipe, type Launched } from './app'

let run: Launched
test.afterEach(async () => {
  await run?.app.close()
})

// A projector mid-set: the output window keeps getting the stage's frames while another page is in front.
test('the OUTPUT window keeps drawing while STUDIO is in front', async () => {
  test.setTimeout(180_000)
  run = await launchApp()
  const { page, app } = run
  await waitReady(page)
  const nav = page.getByRole('navigation')
  await nav.getByRole('button', { name: 'VISUALS' }).click()
  await waitWipe(page)
  const [output] = await Promise.all([
    app.waitForEvent('window', { predicate: (w) => w.url().includes('window=output') }),
    page
      .getByRole('button', { name: /OUTPUT/ })
      .first()
      .click(),
  ])
  await output.waitForLoadState()
  await page.waitForTimeout(1000)
  // Count frames the stage sends (instrumented from the test only). Each next frame waits for the output window's
  // "shown", so a steady count also proves the output keeps showing them.
  await page.evaluate(() => {
    const orig = MessagePort.prototype.postMessage
    ;(window as unknown as { sent: number }).sent = 0
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: Parameters<MessagePort['postMessage']>) {
      if ((args[0] as { type?: string })?.type === 'frame') (window as unknown as { sent: number }).sent++
      return orig.apply(this, args)
    } as MessagePort['postMessage']
  })
  const shown = () => page.evaluate(() => (window as unknown as { sent: number }).sent)
  await nav.getByRole('button', { name: 'STUDIO' }).click()
  await waitWipe(page)
  const before = await shown()
  await page.waitForTimeout(1500)
  expect((await shown()) - before).toBeGreaterThan(20) // ~60 fps for 1.5 s, well above a frozen 0
})
