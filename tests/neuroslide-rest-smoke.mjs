// UI test with the public external-prediction adapter; no EEG/device/model connection.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  const modelChanges = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/model-service/ensure')) modelChanges.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('passive-bci.model-service-enabled', 'false')
    if (!localStorage.getItem('neuroslide.config.v1')) localStorage.setItem('neuroslide.config.v1', JSON.stringify({
      mapping: { left: 'left_hand', right: 'right_hand', up: 'tongue', down: 'rest' }, preset: 'smr',
      config: { threshold: .58, stableCount: 2, releaseThreshold: .45, releaseCount: 1, maxGapMs: 1500 },
    }))
  })
  await page.goto(`${process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173'}/#/neuroslide`)
  await page.getByRole('button', { name: 'BCI Mode', exact: true }).click()
  await page.locator('.ns-settings summary').click()
  const modelOptions = await page.getByLabel('脑控分类模型').locator('option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })))
  assert.equal(modelOptions.length, 7, 'six historical S04 checkpoints and reuse-current option')
  for (const option of modelOptions.filter(option => option.value)) {
    await page.getByLabel('脑控分类模型').selectOption(option.value)
    assert.match(await page.getByTestId('selected-model-detail').innerText(), new RegExp(option.value.replaceAll('.', '\\.')))
    await page.reload()
    await page.locator('.ns-settings summary').click()
    assert.equal(await page.getByLabel('脑控分类模型').inputValue(), option.value, 'historical selections survive reload')
  }
  assert.deepEqual(modelChanges, [], 'choosing a model does not load weights until explicitly connected')
  await page.getByRole('button', { name: 'BCI Mode', exact: true }).click()
  assert.equal(await page.getByLabel('rest 稳定预测数', { exact: true }).inputValue(), '2')
  await page.getByLabel('rest 稳定预测数', { exact: true }).fill('4')
  assert.equal(await page.getByLabel('稳定预测数', { exact: true }).inputValue(), '2')
  await page.getByLabel('预测来源').selectOption('external')
  await page.getByRole('button', { name: '开始', exact: true }).click()
  let serial = 0
  const send = (winner, roundId) => page.evaluate(({ winner, roundId, serial }) => {
    window.dispatchEvent(new CustomEvent('neuroslide:prediction', { detail: {
      id: `rest-test-${serial}`, labels: ['left_hand', 'right_hand', 'rest', 'tongue'],
      probabilities: [0, 1, 2, 3].map(i => i === winner ? .94 : .02), receivedAt: performance.now(), roundId,
    } }))
  }, { winner, roundId, serial: ++serial })
  const moves = () => page.getByTestId('moves').innerText().then(Number)
  for (let i = 0; i < 3; i++) await send(2)
  assert.equal(await moves(), 0)
  assert.match(await page.locator('.ns-filter-state').innerText(), /rest 稳定确认 · 3\/4/)
  await send(2)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="moves"]').textContent) === 1)
  await page.waitForFunction(() => document.querySelector('.ns-player').dataset.sliding === 'false')
  for (let i = 0; i < 6; i++) await send(2)
  assert.equal(await moves(), 1, 'sustained rest cannot auto-repeat')
  await send(1, 'new-trial')
  assert.equal(await moves(), 1)
  await send(1, 'new-trial')
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="moves"]').textContent) === 2)
  await page.reload()
  await page.locator('.ns-settings summary').click()
  assert.equal(await page.getByLabel('rest 稳定预测数', { exact: true }).inputValue(), '4')
  assert.equal(await page.getByLabel('稳定预测数', { exact: true }).inputValue(), '2')
  assert.equal(await page.getByLabel('置信度阈值').inputValue(), '0.58')
  assert.equal(await page.getByLabel('释放预测数').inputValue(), '1')
  await mkdir('test-results/neuroslide', { recursive: true })
  await page.locator('.ns-rest-debug').screenshot({ path: 'test-results/neuroslide/rest-settings.png' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ok:true, migration:true, independentRestCount:true, persistentSettings:true, deduplication:true}))
} finally { await browser.close() }
