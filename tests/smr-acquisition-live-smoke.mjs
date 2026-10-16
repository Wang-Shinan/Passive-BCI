// Opt-in: real S04 model and EEG, connection/decoding only; never starts recording or training.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.env.SMR_LIVE !== '1') throw new Error('Set SMR_LIVE=1 to connect the real EEG device')
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/src/**', async route => {
    const response = await route.fetch()
    if ((response.headers()['content-type'] || '').includes('javascript')) {
      await route.fulfill({ response, body: (await response.text()).replace(/\?t=\d+/g, '') })
    } else await route.fulfill({ response })
  })
  await page.addInitScript(() => localStorage.setItem('passive-bci.model-service-enabled', 'false'))
  await page.goto(`${process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173'}/#/smr-acquisition`)
  await page.getByRole('button', { name: '实验员设置', exact: true }).click()
  await page.getByRole('button', { name: '使用 S04 个体化模型', exact: true }).click()
  await page.getByRole('button', { name: '连接 EEG 与所选模型', exact: true }).click()
  await page.getByRole('button', { name: '连接 EEG 与所选模型', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const section = document.querySelector('[aria-label="SMR 输入就绪检查"]')
    return section?.textContent?.includes('已接入现有模型')
  }, null, { timeout: 90000 })
  const evidence = await page.evaluate(async () => {
    const { modelRuntimeHub } = await import('/src/lib/model-runtime/modelRuntimeHub.ts')
    const { TemporalEvidenceFilter, DEFAULT_TEMPORAL_FILTER } = await import('/src/lib/model-runtime/temporalEvidence.ts')
    const { reveCursorDrive } = await import('/src/experiments/smr-adapt/smrControl.ts')
    const { liveEegHub } = await import('/src/lib/eeg/liveHub.ts')
    const { recorderIsActive } = await import('/src/lib/session/recordControl.ts')
    const filter = new TemporalEvidenceFilter(DEFAULT_TEMPORAL_FILTER)
    const outputs = []
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const prediction = modelRuntimeHub.latestObservation(1500)
      if (prediction) outputs.push({ probabilities: prediction.probabilities, axes: reveCursorDrive(filter.observePrediction(prediction)) })
    }
    return { hello: modelRuntimeHub.snapshot.serviceHello, outputs, freshEeg: liveEegHub.isFresh(), recording: recorderIsActive() }
  })
  assert.equal(evidence.hello.model_revision, 'web-lp-093f1a91-f720-4773-b87f-4c2f8a5daea3')
  assert.equal(evidence.hello.window_sec, 4)
  assert.equal(evidence.freshEeg, true)
  assert.equal(evidence.recording, false)
  assert(evidence.outputs.some(item => Math.abs(item.axes.zH) + Math.abs(item.axes.zV) > .001))
  assert.equal(await page.getByLabel('组间自动训练并评估接管').isChecked(), true)
  assert.equal(await page.getByLabel('组间自动训练并评估接管').isDisabled(), false)
  assert.deepEqual(errors, [])
  await mkdir('test-results/smr', { recursive: true })
  await writeFile('test-results/smr/live-connection.json', JSON.stringify(evidence, null, 2))
  await page.screenshot({ path: 'test-results/smr/live-connection.png', fullPage: true })
  console.log(JSON.stringify({ok:true, revision:evidence.hello.model_revision, freshEeg:true, output:evidence.outputs.at(-1), recording:false}))
} finally { await browser.close() }
