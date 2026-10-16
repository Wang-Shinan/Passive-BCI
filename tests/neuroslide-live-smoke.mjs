// Opt-in integration check: uses the REAL configured model and BCIGo device, never synthetic predictions.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
if (process.env.NEUROSLIDE_LIVE !== '1') throw new Error('Set NEUROSLIDE_LIVE=1 to explicitly connect the real EEG device')
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('test-results/neuroslide', { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('passive-bci.model-service-enabled', 'false'))
  await page.goto(`${process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173'}/#/neuroslide`)
  await page.getByLabel('关卡选择').selectOption('1')
  await page.getByRole('button', { name: 'BCI Mode', exact: true }).click()
  await page.locator('.ns-settings summary').click()
  await page.getByRole('button', { name: '连接模型并开始', exact: true }).click()
  await page.getByRole('button', { name: '连接模型并开始', exact: true }).waitFor({ timeout: 90000 })
  await page.waitForFunction(() => !document.querySelector('.ns-board-note'))
  assert.equal(await page.getByTestId('model-revision').innerText(), 'web-lp-093f1a91-f720-4773-b87f-4c2f8a5daea3')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="moves"]')?.textContent) > 0, null, { timeout: 30000 })
  const evidence = await page.evaluate(async () => {
    const { modelRuntimeHub } = await import('/src/lib/model-runtime/modelRuntimeHub.ts')
    const { acqRuntime } = await import('/src/acquisition/runtime.ts')
    const snapshot = modelRuntimeHub.snapshot
    return { message: document.querySelector('[data-testid="connection-message"]')?.textContent,
      status: snapshot.status, source: snapshot.sourceDetail, device: acqRuntime.device, streaming: acqRuntime.streaming,
      sentWindows: snapshot.sentWindows, predictionCount: snapshot.predictionCount,
      classNames: snapshot.latestPrediction?.class_names,
      probabilities: snapshot.latestPrediction?.probabilities,
      modelRevision: snapshot.latestPrediction?.model_revision,
      observationId: snapshot.latestPrediction?.observation_id,
      moves: Number(document.querySelector('[data-testid="moves"]')?.textContent),
      command: document.querySelector('.ns-direction-display strong')?.textContent,
      errors: snapshot.lastError }
  })
  console.log(JSON.stringify(evidence))
  await writeFile('test-results/neuroslide/live-connection.json', JSON.stringify(evidence, null, 2))
  assert.match(evidence.message, /已接入现有模型/)
  assert(evidence.sentWindows > 0 && evidence.predictionCount > 0)
  assert(evidence.moves > 0, 'real model must pass the confirmation gate and emit a discrete command')
  assert.equal(await page.getByLabel('类别映射预设').inputValue(), 'auto')
  assert.equal(await page.getByLabel('向下类别标签').inputValue(), 'rest')
  assert.equal(await page.locator('.ns-warning').filter({ hasText: '映射不一致' }).count(), 0)
  assert.equal(await page.locator('.ns-probability b').filter({ hasText: '%' }).count(), 4)
  // Exercise native select keyboard interaction while real model updates keep rendering.
  const preset = page.getByLabel('类别映射预设')
  await preset.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
  assert.equal(await preset.inputValue(), 'smr')
  await page.waitForTimeout(400)
  assert.equal(await preset.inputValue(), 'smr')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  assert.equal(await page.locator('.ns-board-note').count(), 0, 'BCI must not pause when a native select blurs the window')
  await page.screenshot({ path: 'test-results/neuroslide/live-connected.png', fullPage: true })
  await page.reload()
  await page.locator('.ns-settings summary').click()
  assert.equal(await page.getByLabel('类别映射预设').inputValue(), 'smr', 'preset persists after reload')
  assert.deepEqual(errors, [])
} finally { await browser.close() }
