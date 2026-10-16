// Run against the Vite development server. Playwright is test-only, not a game dependency.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)
const { chromium } = require('playwright-core')
const output = path.resolve('test-results/neuroslide')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) })
const base = process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173'
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.addInitScript(() => localStorage.setItem('passive-bci.model-service-enabled', 'false'))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/#/neuroslide`)
  await page.getByRole('heading', { name: 'NeuroSlide — BCI Ice Maze' }).waitFor()
  const moves = async () => Number(await page.getByTestId('moves').innerText())
  const waitMoves = count => page.waitForFunction(expected => Number(document.querySelector('[data-testid="moves"]')?.textContent) === expected, count, { timeout: 3000 })
  const position = () => page.locator('.ns-player').evaluate(el => [Number(el.dataset.x), Number(el.dataset.y)])
  const stopped = () => page.waitForFunction(() => document.querySelector('.ns-player')?.getAttribute('data-sliding') === 'false')
  const restart = async () => { await page.getByRole('button', { name: '重新开始', exact: true }).click(); await page.getByRole('button', { name: '开始', exact: true }).click() }
  await page.screenshot({ path: `${output}/desktop-1920.png`, fullPage: true })
  assert(await page.evaluate(() => document.documentElement.scrollHeight <= 1080), '1920×1080 default screen fits without scrolling')
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.press('ArrowDown') // discarded while moving
  await stopped()
  for (let i = 0; i < 10; i++) await page.keyboard.down('ArrowRight')
  await page.waitForTimeout(150)
  assert.equal(await moves(), 1)
  assert.deepEqual(await position(), [2, 1])
  await page.keyboard.up('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await stopped()
  assert.deepEqual(await position(), [2, 4])
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  const pausedClock = await page.getByTestId('elapsed').innerText()
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(1100)
  assert.equal(await moves(), 2); assert.equal(await page.getByTestId('elapsed').innerText(), pausedClock)

  // Solver is ONLY in this test harness; the game never searches or executes a route.
  const solutions = await page.evaluate(async () => {
    const { LEVELS } = await import('/src/experiments/neuroslide/levels.ts')
    const { DIRECTIONS, marker, slideEnd } = await import('/src/experiments/neuroslide/engine.ts')
    const key = p => `${p.x},${p.y}`
    return LEVELS.map(level => {
      const start = marker(level, 'S'), goal = marker(level, 'G')
      const queue = [{ p: start, path: [] }], visited = new Set([key(start)])
      for (let i = 0; i < queue.length; i++) {
        const { p, path } = queue[i]
        if (key(p) === key(goal)) return path
        for (const d of DIRECTIONS) {
          const next = slideEnd(level, p, d)
          if (!visited.has(key(next))) { visited.add(key(next)); queue.push({ p: next, path: [...path, d] }) }
        }
      }
      throw new Error('Unsolvable level')
    })
  })
  for (let i = 0; i < solutions.length; i++) {
    await page.getByLabel('关卡选择').selectOption(String(i))
    await restart()
    for (const d of solutions[i]) {
      await page.keyboard.press(`Arrow${d[0].toUpperCase()}${d.slice(1)}`)
      await stopped()
    }
    await page.getByRole('heading', { name: '成功抵达终点' }).waitFor()
    assert.equal(await moves(), [5, 9, 13][i])
    if (i === 2) await page.screenshot({ path: `${output}/victory.png`, fullPage: true, animations: 'disabled' })
  }

  await page.getByLabel('关卡选择').selectOption('0')
  await page.getByRole('button', { name: 'BCI Mode', exact: true }).click()
  await page.locator('.ns-settings summary').click()
  const preset = page.getByLabel('类别映射预设')
  for (const [id, downLabel] of [['smr', 'rest'], ['directions', 'down'], ['mi', 'feet']]) {
    await preset.selectOption(id)
    assert.equal(await preset.inputValue(), id, 'selected preset must remain visible')
    assert.equal(await page.getByLabel('向下类别标签').inputValue(), downLabel)
    await page.waitForTimeout(100)
    assert.equal(await preset.inputValue(), id, 'animation renders must not reset selection')
  }
  await page.getByLabel('预测来源').selectOption('external')
  await page.getByRole('button', { name: '开始', exact: true }).click()
  // The adapter is public, so external EEG integrations exercise exactly this entry point.
  let serial = 0
  const send = async (winner, roundId, id = `smoke-${++serial}`, runtime = false) => {
    await page.evaluate(async ({ winner, roundId, id, runtime }) => {
      const labels = ['left_hand', 'right_hand', runtime ? 'rest' : 'feet', 'tongue']
      const probabilities = labels.map((_, i) => winner < 0 ? .25 : i === winner ? .94 : .02)
      if (runtime) {
        const { modelRuntimeHub } = await import('/src/lib/model-runtime/modelRuntimeHub.ts')
        modelRuntimeHub.patch({ status: 'ready', serviceHello: { class_names: labels }, latestPrediction: {
          type: 'prediction', observation_id: id, class_names: labels, probabilities, received_at_ms: performance.now(),
        } })
      } else window.dispatchEvent(new CustomEvent('neuroslide:prediction', { detail: { id, labels, probabilities, receivedAt: performance.now(), roundId } }))
    }, { winner, roundId, id, runtime })
  }
  await send(1, 'trial-1'); await send(1, 'trial-1')
  assert.equal(await moves(), 0)
  await send(1, 'trial-1', 'confirmed-id')
  await waitMoves(1)
  assert.equal(await moves(), 1)
  await send(2, 'busy-trial'); await stopped()
  await send(2, 'busy-trial'); await send(2, 'busy-trial'); await send(2, 'busy-trial')
  await send(1, 'new-trial', 'confirmed-id')
  assert.equal(await moves(), 1)
  await send(1, 'trial-2'); await send(1, 'trial-2'); await send(1, 'trial-2')
  await waitMoves(2)
  assert.equal(await moves(), 2, 'new same-direction trial is accepted even when adjacent to wall')
  for (let i = 0; i < 5; i++) await send(1, 'trial-2')
  assert.equal(await moves(), 2)
  for (let i = 0; i < 3; i++) await send(-1)
  for (let i = 0; i < 3; i++) await send(2)
  await waitMoves(3)
  assert.equal(await moves(), 3)
  await stopped()
  for (let i = 0; i < 12; i++) await send(2)
  assert.equal(await moves(), 3, 'continuous stream cannot chain slides')

  // Existing model runtime subscription, with actual rest class and shuffled-independent labels.
  await page.getByLabel('预测来源').selectOption('runtime')
  await page.getByLabel('类别映射预设').selectOption('smr')
  assert.equal(await page.getByLabel('类别映射预设').inputValue(), 'smr')
  await restart()
  for (let i = 0; i < 3; i++) await send(-1, undefined, undefined, true)
  for (let i = 0; i < 3; i++) await send(1, undefined, undefined, true)
  await waitMoves(1)
  await stopped(); assert.equal(await moves(), 1)
  assert.deepEqual(await position(), [2, 1])
  await page.screenshot({ path: `${output}/bci-settings.png`, fullPage: true })

  await page.getByRole('button', { name: 'Keyboard Demo', exact: true }).click()
  await page.locator('.ns-settings summary').click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'mobile should not overflow horizontally')
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, solutions: solutions.map(s => s.length), keyboard: 'passed', externalBCI: 'passed', runtimeBCI: 'passed', screenshots: output }))
} finally { await browser.close() }
