import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const port = 5199, base = `http://127.0.0.1:${port}`
const outDir = join(process.env.TEMP || 'test-results', 'gui-recovery-ui')
mkdirSync(outDir, { recursive: true })
let server = null, spawned = false
let logs = ''
const probe = async () => { try { return (await fetch(base)).ok } catch { return false } }
if (!(await probe())) {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned = true
  server.stdout.on('data', b => { logs += b })
  server.stderr.on('data', b => { logs += b })
}
let browser, page
const errors = []
const netLog = []
const log = (m) => { console.log(m); netLog.push(`[${new Date().toISOString()}] ${m}`) }

const CH = ['CH1', 'CH2']
const FS = 250
const gui = { generation: 7, sessionId: 'gui-sess-A', mode: 'live', head: 100, seq: 1, lastEmitMs: Date.now(), triggerDelayMs: 0, apiOff: false }
const triggers = []
const recSessions = new Map()
const finishedIds = new Set()
const lateWrites = []
let recN = 0
let activeRecId = null

const dataPage = (gen, oldest, next, end, rows) => ({
  source: 'original_device_frames',
  generation: gen,
  oldest_cursor: oldest,
  end_cursor: end,
  next_cursor: next,
  channel_names: CH,
  sample_rate_hz: FS,
  frames: rows,
})
const frame = () => ({ values_uv: [Math.random() * 20 - 10, Math.random() * 20 - 10], sequence: (gui.seq++) >>> 0, mode: 0, valid: true, source_timestamp_us: (gui.seq * 4000) >>> 0 })

try {
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (await probe()) { ready = true; break }
    await new Promise(r => setTimeout(r, 200))
  }
  assert.ok(ready, 'Vite did not start')

  browser = await chromium.launch({ headless: true, executablePath: process.env.EDGE_PATH || undefined })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.setDefaultTimeout(20000)
  page.on('pageerror', e => { errors.push(e.message); console.error('[pageerror]', e.message) })
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = function () { return Promise.resolve() }
  })

  await page.route('**/api/bridge/**', route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, listening: false, collect: false, port: 0, message: 'mock bridge off' }) })
  })
  await page.route('**/api/**', route => {
    netLog.push(`${route.request().method()} ${new URL(route.request().url()).pathname} (generic mock)`)
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, heads: [], weights: [], running: false, items: [], sessions: [] }) })
  })

  await page.route('**/api/client-diagnostics', route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.route('**/api/omni-gui/v1/status', route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      schema_version: 1, api_control_enabled: !gui.apiOff, connected: true,
      streaming: gui.mode !== 'down', session_id: gui.sessionId,
      sample_rate_hz: FS, frames: gui.head, stale: false,
    }) })
  })
  await page.route('**/api/omni-gui/v1/trigger', async route => {
    const body = route.request().postDataJSON()
    triggers.push(body)
    netLog.push(`POST /v1/trigger ${JSON.stringify(body)}`)
    if (gui.triggerDelayMs > 0) await new Promise(r => setTimeout(r, gui.triggerDelayMs))
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      accepted: true, session_id: gui.sessionId, sequence: (gui.seq - 1) >>> 0,
      sample_index: gui.head, code: body.code, label: body.label,
      host_time: new Date().toISOString(),
    }) })
  })
  await page.route('**/api/omni-gui/v1/data**', route => {
    const url = new URL(route.request().url())
    const limit = Number(url.searchParams.get('limit') ?? '1')
    const cursorQ = url.searchParams.get('cursor')
    if (gui.mode === 'conflict') {
      netLog.push('GET /v1/data -> 409')
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        error: 'cursor_out_of_range',
        bounds: { generation: gui.generation, oldest_cursor: Math.max(0, gui.head - 90), end_cursor: gui.head },
      }) })
    }
    if (gui.mode === 'error') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    }
    if (cursorQ === null || limit === 1) {
      gui.head += 8
      const rows = [frame()]
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(
        dataPage(gui.generation, Math.max(0, gui.head - 90), gui.head, gui.head, rows)) })
    }
    const c = Number(cursorQ)
    const nowMs = Date.now()
    const emit = Math.max(12, Math.min(150, Math.round(((nowMs - gui.lastEmitMs) / 1000) * FS)))
    gui.lastEmitMs = nowMs
    gui.head += emit
    const n = Math.min(emit, Math.max(0, gui.head - c))
    const rows = Array.from({ length: n }, frame)
    netLog.push(`GET /v1/data gen=${url.searchParams.get('generation')} cursor=${c} -> ${n} rows`)
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(
      dataPage(gui.generation, Math.max(0, c - 100), c + n, gui.head, rows)) })
  })

  await page.route('**/api/record/active', route => {
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, id: activeRecId, rel: activeRecId ? `recordings/stem-${activeRecId}` : null }) })
  })
  await page.route('**/api/record/start', route => {
    const id = `r${(++recN).toString(36)}fixture`
    const stem = `ui-seg-${recN}`
    recSessions.set(id, { id, stem, rel: `recordings/${stem}`, bytes: 0, events: [], context: [], meta: {}, finish: null })
    activeRecId = id
    netLog.push(`POST /api/record/start -> ${id}`)
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, id, filename: 'eeg.bin', stem, path: `x/${stem}/eeg.bin`, dir: `x/${stem}`, rel: `recordings/${stem}` }) })
  })
  await page.route('**/api/record/*/**', async route => {
    const m = new URL(route.request().url()).pathname.match(/^\/api\/record\/([^/]+)\/(chunk|finish|abort|events|context|meta)$/)
    const recId = m && m[1]
    const sess = m && recSessions.get(recId)
    if (recId && finishedIds.has(recId)) {
      lateWrites.push(`${recId}/${m[2]}`)
      netLog.push(`LATE WRITE REJECTED /api/record/${recId}/${m[2]}`)
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'recording already finished' }) })
    }
    if (!sess) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'no session' }) })
    const action = m[2]
    if (action === 'chunk') {
      const buf = route.request().postDataBuffer() ?? Buffer.alloc(0)
      sess.bytes += buf.byteLength
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, bytes: sess.bytes }) })
    }
    if (action === 'events' || action === 'context') {
      const raw = (route.request().postData() ?? '').trim()
      for (const line of raw.split('\n').filter(Boolean)) sess[action].push(JSON.parse(line))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (action === 'meta') {
      Object.assign(sess.meta, route.request().postDataJSON() ?? {})
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (action === 'abort') {
      sess.finish = { aborted: true }
      finishedIds.add(sess.id)
      recSessions.delete(sess.id)
      if (activeRecId === sess.id) activeRecId = null
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    const body = route.request().postDataJSON() ?? {}
    sess.finish = body
    finishedIds.add(sess.id)
    netLog.push(`POST /api/record/${sess.id}/finish ${JSON.stringify({ interrupted: body.interrupted, reason: body.interruptionReason, bytes: sess.bytes })}`)
    if (activeRecId === sess.id) activeRecId = null
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, bytes: sess.bytes, filename: 'eeg.bin', stem: sess.stem, path: `x/${sess.stem}/eeg.bin`, dir: `x/${sess.stem}`, rel: sess.rel }) })
  })

  await page.goto(`${base}/#/acquisition`)
  const setSelect = (aria, value) => page.evaluate(([a, v]) => {
    const el = [...document.querySelectorAll('select')].find(s => s.getAttribute('aria-label') === a)
    if (!el) throw new Error(`select ${a} not found`)
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, [aria, value])
  await page.locator('select[aria-label="链路"]').first().waitFor({ state: 'attached' })
  await setSelect('链路', 'gui')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.getByText(/已连接 OmniBCI GUI HTTP/).waitFor()
  await page.getByRole('button', { name: '开始采集', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent === '停止' && !b.disabled))
  await page.waitForTimeout(600)
  assert.equal(recSessions.size, 1, 'first recording segment should be open')
  const segA = [...recSessions.values()][0]
  log(`[ui] streaming on GUI link; segment ${segA.id} open`)

  await page.locator('a.acq-home[href="#/"]').first().click()
  await page.locator('a[href="#/focus"]').first().click()
  await page.waitForURL('**/#/focus')
  await page.getByRole('button', { name: '实验员设置' }).click()
  let dialog = page.locator('dialog[open]')
  await dialog.getByLabel(/总试次数/).fill('2')
  for (const name of [/准备时间/, /缓冲/, /有效采集/, /恢复休息/]) {
    const input = dialog.getByLabel(name)
    if (await input.count()) await input.first().fill('1')
  }
  await dialog.getByRole('button', { name: '返回被试画面' }).click()
  const trigBeforeRun = triggers.length
  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 2').waitFor()
  await page.getByRole('heading', { name: /专注|放松/ }).waitFor()
  await page.waitForTimeout(1200)
  log('[ui] run started; interrupting mid-collect')

  gui.mode = 'conflict'
  await page.getByRole('heading', { name: 'EEG 中断' }).waitFor()
  await page.getByText('正在恢复；当前试次已作废').waitFor()
  log('[ui] waiting view shown')
  await page.waitForTimeout(1500)
  assert.ok(segA.finish, 'old segment must be finished')
  assert.equal(segA.finish.interrupted, true, 'old segment saved as interrupted')
  assert.equal(typeof segA.finish.interruptionReason, 'string')
  assert.ok(segA.events.some(e => e.type === 'acquisition_interrupted'), 'old segment logs acquisition_interrupted')
  assert.ok(segA.events.some(e => e.type === 'focus_trial' && e.data?.invalidReason), 'interrupted trial finalized invalid')
  const reqLedger = segA.events.filter(e => e.type === 'trigger_request')
  assert.ok(reqLedger.length >= 1, 'trigger ledger in old segment')
  log(`[ui] old segment ${segA.id} saved interrupted (${segA.bytes} bytes, reason=${segA.finish.interruptionReason})`)

  gui.generation = 8; gui.sessionId = 'gui-sess-B'; gui.head = 500; gui.seq = 1000; gui.mode = 'live'
  await page.getByText('2 / 2').waitFor({ timeout: 20000 })
  log('[ui] recovered; advanced to next trial')
  assert.equal(recSessions.size, 2, 'new linked segment must be open')
  const segB = [...recSessions.values()].find(s => s !== segA)
  assert.ok(segB.finish === null || segB.finish.aborted !== true, 'new segment still open during run')
  for (let i = 0; i < 50 && !segB.events.some(e => e.type === 'acquisition_resumed'); i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(segB.events.some(e => e.type === 'acquisition_resumed'), 'acquisition_resumed logged in new segment')
  assert.equal(segB.events.filter(e => e.type === 'focus_phase' && e.data?.trialIndex === 1 && e.data?.phase === 'prepare').length, 1, 'next trial prepared exactly once')
  assert.equal(segB.events.filter(e => e.type === 'focus_trial' && e.data?.trialIndex === 0).length, 0, 'interrupted trial not repeated in new segment')
  await page.screenshot({ path: join(outDir, 'gui-recovery-next-trial.png'), fullPage: true })

  await page.getByRole('heading', { name: /本轮完成|采集已停止/ }).waitFor({ timeout: 30000 })
  const trialEvents = () => [...recSessions.values()].flatMap(s => s.events).filter(e => e.type === 'focus_trial')
  const idx1 = trialEvents().filter(e => e.data?.trialIndex === 1)
  assert.equal(idx1.length, 1, 'exactly one focus_trial for next index')
  const codeCounts = {}
  for (const t of triggers.slice(trigBeforeRun)) codeCounts[t.code] = (codeCounts[t.code] || 0) + 1
  assert.ok((codeCounts[130] ?? 0) <= 1, 'no duplicated recovery marker retry')
  log(`[ui] run finished; triggers=${JSON.stringify(codeCounts)}`)

  await page.getByRole('button', { name: '实验员设置' }).click()
  dialog = page.locator('dialog[open]')
  await dialog.getByLabel(/总试次数/).fill('4')
  await dialog.getByRole('button', { name: '返回被试画面' }).click()
  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 4').waitFor()
  log('[ui] uninterrupted 4-trial run started')
  await page.getByRole('heading', { name: /本轮完成|采集已停止/ }).waitFor({ timeout: 60000 })
  await page.waitForTimeout(800)
  const allEvents = () => [...recSessions.values()].flatMap(x => x.events)
  const lastStart = allEvents().filter(e => e.type === 'session_start').at(-1)
  const runId = lastStart.data.runId
  const clean = allEvents().filter(e => e.type === 'focus_trial' && e.data?.runId === runId)
  const seen = [0, 1, 2, 3].map(i => clean.filter(e => e.data?.trialIndex === i))
  for (let i = 0; i < 4; i++) {
    assert.equal(seen[i].length, 1, `trial ${i} must be recorded exactly once`)
    assert.equal(seen[i][0].data?.valid, true, `trial ${i} must be valid`)
  }
  const endEvent = allEvents().filter(e => e.type === 'session_end').at(-1)
  assert.deepEqual({ valid: endEvent.data.valid, invalid: endEvent.data.invalid }, { valid: 4, invalid: 0 })
  log('[ui] 4 uninterrupted trials: indices 0..3 once each, all valid')

  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 4').waitFor()
  await page.getByRole('heading', { name: /专注|放松/ }).waitFor()
  await page.waitForTimeout(1200)
  gui.mode = 'conflict'
  await page.getByRole('heading', { name: 'EEG 中断' }).waitFor()
  const recsBeforeStop = recSessions.size
  await page.getByRole('button', { name: /停止 · Esc/ }).click()
  await page.getByRole('heading', { name: '采集已停止' }).waitFor({ timeout: 20000 })
  gui.generation = 9; gui.sessionId = 'gui-sess-C'; gui.head = 900; gui.seq = 5000; gui.mode = 'live'
  await page.waitForTimeout(3000)
  await page.getByRole('heading', { name: '采集已停止' }).waitFor()
  assert.equal(recSessions.size, recsBeforeStop + 1, 'acquisition-owned reopen still proceeds; no extra segments')
  const segC = [...recSessions.values()].find(s => s.finish === null || s.finish === undefined)
  log(`[ui] stop-while-waiting held stopped; sessions=${recSessions.size}`)

  assert.ok(!segC.finish, 'acquisition segment still open')
  assert.equal(activeRecId, segC.id, 'acquisition-owned recorder is the shared recording for jaw')
  for (let i = 0; i < 30 && segC.bytes === 0; i++) await new Promise(r => setTimeout(r, 100))
  log(`[ui] segment ${segC.id} recording (${segC.bytes} bytes flushed); jaw will attach to it`)

  await page.locator('a[href="#/"]').first().click()
  await page.locator('a[href="#/jaw-clench"]').first().click()
  await page.waitForURL('**/#/jaw-clench')
  await page.getByRole('button', { name: '实验员设置' }).click()
  dialog = page.locator('dialog[open]')
  await dialog.getByLabel(/总试次数/).fill('2')
  for (const name of [/准备时间/, /缓冲/, /有效采集/, /恢复休息/]) {
    const input = dialog.getByLabel(name)
    if (await input.count()) await input.first().fill('1')
  }
  await dialog.getByRole('button', { name: '返回被试画面' }).click()
  const trigBeforeJaw = triggers.length
  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 2').waitFor()
  await page.getByRole('heading', { name: /咬牙|放松/ }).waitFor()
  await page.waitForTimeout(1200)
  log('[ui] jaw real run started on shared acquisition recorder; interrupting mid-collect')
  gui.mode = 'conflict'
  await page.getByRole('heading', { name: 'EEG 中断' }).waitFor()
  await page.getByText('正在恢复；当前试次已作废').waitFor()
  await page.waitForTimeout(1500)
  assert.equal(segC.finish?.interrupted, true, 'jaw interruption saved the acquisition segment interrupted')
  const jawInvalid = segC.events.filter(e => e.type === 'jaw_trial' && e.data?.invalidReason)
  assert.equal(jawInvalid.length, 1, 'interrupted jaw trial finalized invalid in old segment')
  assert.ok(segC.events.some(e => e.type === 'acquisition_interrupted'), 'jaw boundary logged interruption')
  gui.generation = 10; gui.sessionId = 'gui-sess-D'; gui.head = 1400; gui.seq = 9000; gui.mode = 'live'
  await page.getByText('2 / 2').waitFor({ timeout: 20000 })
  const segD = [...recSessions.values()].find(s => s !== segC && (s.finish === null || s.finish === undefined))
  assert.ok(segD, 'linked segment opened for jaw recovery')
  for (let i = 0; i < 50 && !segD.events.some(e => e.type === 'acquisition_resumed'); i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(segD.events.some(e => e.type === 'jaw_phase' && e.data?.trialIndex === 1 && e.data?.phase === 'prepare'), 'jaw next trial prepared exactly once')
  await page.getByRole('heading', { name: /本轮完成|采集已停止/ }).waitFor({ timeout: 30000 })
  const jawTrialsAll = () => [...recSessions.values()].flatMap(s => s.events).filter(e => e.type === 'jaw_trial')
  assert.equal(jawTrialsAll().filter(e => e.data?.trialIndex === 1).length, 1, 'jaw next trial recorded exactly once')
  assert.equal(activeRecId, segD.id, 'normal jaw finish leaves the acquisition recorder alive')
  assert.ok(!segD.finish, 'acquisition-owned segment still open after jaw finish')
  log('[ui] jaw recovery: invalid trial + new segment + exactly-once advance; recorder still owned by acquisition')

  await page.getByRole('button', { name: '实验员设置' }).click()
  dialog = page.locator('dialog[open]')
  await dialog.getByLabel(/总试次数/).fill('4')
  await dialog.getByRole('button', { name: '返回被试画面' }).click()
  gui.triggerDelayMs = 350
  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 4').waitFor()
  log('[ui] uninterrupted 4-trial jaw run with 350ms delayed ACKs')
  await page.getByRole('heading', { name: /本轮完成|采集已停止/ }).waitFor({ timeout: 90000 })
  gui.triggerDelayMs = 0
  await page.waitForTimeout(1200)
  const jawEvents = () => [...recSessions.values()].flatMap(x => x.events)
  const jawRunId = jawEvents().filter(e => e.type === 'session_start').at(-1).data.runId
  const jclean = jawEvents().filter(e => e.type === 'jaw_trial' && e.data?.runId === jawRunId)
  for (let i = 0; i < 4; i++) {
    const t = jclean.filter(e => e.data?.trialIndex === i)
    assert.equal(t.length, 1, `jaw trial ${i} must be recorded exactly once`)
    assert.equal(t[0].data?.valid, true, `jaw trial ${i} must be valid`)
  }
  const jend = jawEvents().filter(e => e.type === 'session_end').at(-1)
  assert.deepEqual({ valid: jend.data.valid, invalid: jend.data.invalid }, { valid: 4, invalid: 0 })
  assert.equal(activeRecId, segD.id, 'jaw finish again leaves acquisition recorder alive')
  log('[ui] jaw 4 uninterrupted trials: indices 0..3 once each, all valid')

  await page.getByRole('button', { name: '全屏开始采集' }).click()
  await page.getByText('1 / 4').waitFor()
  await page.getByRole('heading', { name: /咬牙|放松/ }).waitFor()
  await page.waitForTimeout(600)
  gui.triggerDelayMs = 2600
  await page.getByRole('button', { name: /停止 · Esc/ }).click()
  await page.getByRole('heading', { name: '采集已停止' }).waitFor({ timeout: 20000 })
  await page.waitForTimeout(3500)
  gui.triggerDelayMs = 0
  assert.ok(jawEvents().filter(e => e.type === 'session_abort').length >= 1, 'session_abort logged for manual stop')
  const settled = jawEvents().filter(e => e.type === 'trigger_error' && (e.data?.outcome === 'uncertain' || e.data?.outcome === 'cancelled'))
  assert.ok(settled.length >= 1, 'markers pending at stop settle as uncertain/cancelled, not acked')
  log(`[ui] stop with pending ACK: ${settled.length} marker(s) settled uncertain/cancelled`)

  const segsBeforeFatal = recSessions.size
  gui.apiOff = true
  for (let i = 0; i < 50 && !segD.finish; i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(segD.finish?.interrupted, true, 'fatal api-disable saves the active segment interrupted')
  assert.ok(segD.events.some(e => e.type === 'acquisition_interrupted'), 'terminal boundary logged interruption into active segment')
  assert.equal(recSessions.size, segsBeforeFatal, 'fatal boundary opens no new segment')
  assert.equal(activeRecId, null, 'recording stopped on fatal')
  log('[ui] fatal api-disable after recovery with acquisition unmounted: saved interrupted, no reopen')
  await page.screenshot({ path: join(outDir, 'gui-fatal-after-recovery.png'), fullPage: true })

  const trigCountBeforeDemo = triggers.length
  await page.locator('a[href="#/"]').first().click()
  await page.goto(`${base}/#/acquisition`)
  await page.getByRole('button', { name: '演示波形' }).click()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: '停止演示' }).click()
  assert.equal(triggers.length, trigCountBeforeDemo, 'demo path must send zero GUI triggers')
  assert.equal(lateWrites.length, 0, `post-finish writes must be zero: ${lateWrites.join(',')}`)
  assert.deepEqual(errors, [])
  log('[ui] demo path: zero trigger POSTs verified')

  const summary = {
    passed: true,
    scenarios: [
      'GUI connect + stream + record segment A',
      'focus run start with marker POSTs (nested-bounds contract)',
      '409 mid-collect -> waiting view, invalid trial',
      'old segment finished interrupted with reason + ledger',
      'new generation/session -> linked segment B',
      'auto-advance to next trial exactly once',
      '4 uninterrupted trials: indices 0..3 once, all valid, session_end counts',
      'stop while waiting: no extra owned segment; acquisition reopen still allowed',
      'jaw real run on shared acquisition recorder: mid-collect 409 -> invalid + new segment + next trial once',
      'jaw normal finish leaves acquisition-owned recorder alive',
      '4 uninterrupted jaw trials with delayed ACKs: indices 0..3 once each, all valid',
      'stop with pending ACK: markers settle uncertain/cancelled',
      'fatal api-disable after recovery: segment saved interrupted, no reopen',
      'demo path zero GUI trigger POSTs',
    ],
    triggerPosts: triggers.length,
    lateWrites,
    sessions: [...recSessions.values()].map(s => ({ id: s.id, bytes: s.bytes, finish: s.finish, events: s.events.length })),
    spawnedVite: spawned, vitePid: spawned && server ? server.pid : null,
  }
  writeFileSync(join(outDir, 'ui-summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(outDir, 'network.log'), netLog.join('\n'))
  console.log(JSON.stringify(summary))
} catch (error) {
  writeFileSync(join(outDir, 'ui-failure.json'), JSON.stringify({ message: String(error?.stack || error), pageErrors: errors }, null, 2))
  writeFileSync(join(outDir, 'network.log'), netLog.join('\n'))
  if (page) {
    await page.screenshot({ path: join(outDir, 'ui-failure.png'), fullPage: true }).catch(() => {})
    writeFileSync(join(outDir, 'ui-failure.txt'), await page.locator('body').innerText().catch(() => ''))
  }
  throw error
} finally {
  writeFileSync(join(outDir, 'vite.log'), logs)
  await browser?.close()
  if (spawned && server) log('vite pid ' + server.pid + ' left running on port ' + port)
}
