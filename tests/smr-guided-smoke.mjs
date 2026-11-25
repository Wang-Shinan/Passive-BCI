// Exercise the participant route using an isolated browser, synthetic EEG clock and in-memory recordings.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)('playwright-core')
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN, channel: process.env.CHROME_BIN ? undefined : 'chrome',
  args: ['--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => route.fulfill({ json: { ok: true, running: false, id: null, heads: [], weights: [] } }))
  let headId = 'baseline', revision = 'baseline-revision'
  await page.route('**/api/model-service/**', async route => {
    const action = route.request().url().split('/').at(-1)
    if (action === 'ensure') {
      headId = route.request().postDataJSON().headId
      revision = headId === 'adapted' ? 'adapted-revision' : 'baseline-revision'
    }
    await route.fulfill({ json: { ok: true, running: action !== 'stop', owned: true,
      task: 'smr_control', backend: 'reve', headId, modelRevision: revision, stepSec: 0.1, heads: [], weights: [] } })
  })
  const jobs = [], journal = []
  await page.route('**/api/training/**', async route => {
    const action = route.request().url().split('/api/training/')[1]
    const body = route.request().postDataJSON()
    if (action === 'rounds') {
      assert.equal(body.subjectId, 'GUIDED')
      return route.fulfill({ json: { ok: true, round: { id: 'guided-round' } } })
    }
    if (action === 'rounds/guided-round') {
      journal.push(body)
      return route.fulfill({ json: { ok: true } })
    }
    if (action === 'jobs') {
      jobs.push(body)
      return route.fulfill({ json: { ok: true, job: { id: jobs.length } } })
    }
    const job = jobs[Number(action.split('/')[1]) - 1]
    const promote = jobs.filter(job => job.kind === 'fit').length >= 2
    await route.fulfill({ json: { ok: true, job: { status: 'complete' }, report: job.kind === 'fit' ? {
      baselineRevision: job.baselineRevision, modelRevision: 'adapted-revision', headId: 'adapted',
      baseline: { balancedAccuracy: 0.25 }, metrics: { validation: { balancedAccuracy: promote ? 0.8 : 0.25 } },
      decision: { promote, reason: promote ? '通过验证' : '未通过验证' },
    } : {} } })
  })
  await page.route('**/src/**', async route => {
    const response = await route.fetch()
    if (!response.headers()['content-type']?.includes('javascript')) return route.fulfill({ response })
    const source = (await response.text()).replace(/\?t=\d+/g, '')
    await route.fulfill({ response, body: source })
  })
  await page.addInitScript(() => {
    localStorage.setItem('passive-bci.model-service-enabled', 'false')
    window.runs = []
  })
  await page.route('**/src/lib/session/recordControl.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { sessionHub } from '/src/lib/session/sessionHub.ts'
    export const recorderIsActive = () => sessionHub.active
    export const canStartExperimentRecording = () => true
    export const recorderBytes = () => 0
    export async function startExperimentRecording(meta) {
      const rel = 'memory-' + window.runs.length
      window.runs.push({ ...meta, rel, events: [] })
      sessionHub.attach({id: rel, rel})
      return { ok: true, sink: 'disk', rel }
    }
    export const rollExperimentRecording = startExperimentRecording
    export async function stopExperimentRecording(options) {
      const run = window.runs.at(-1)
      run.saved = true
      run.interrupted = Boolean(options?.interrupted)
      sessionHub.detach()
      return {ok:true, rel:run.rel}
    }
  ` }))
  await page.goto((process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173') + '/#/smr-acquisition')
  await page.getByRole('button', { name: '全屏开始熟悉动作' }).waitFor()
  await page.evaluate(async () => {
    const { liveEegHub } = await import('/src/lib/eeg/liveHub.ts')
    const { sampleClock } = await import('/src/lib/eeg/sampleClock.ts')
    const { sessionHub } = await import('/src/lib/session/sessionHub.ts')
    const { mapLogEventTrigger } = await import('/src/acquisition/omni/guiTrigger.ts')
    const { acqRuntime } = await import('/src/acquisition/runtime.ts')
    const { modelRuntimeHub, modelUrlPresets } = await import('/src/lib/model-runtime/index.ts')
    liveEegHub.isFresh = () => true
    Object.defineProperty(acqRuntime, 'streaming', { value: true, configurable: true })
    const hello = rev => ({ task: 'smr_control', model_type: 'reve', model_name: 'reve',
      model_revision: rev, window_sec: 2, class_names: ['left_hand','right_hand','tongue','rest'] })
    modelRuntimeHub.disconnect = () => modelRuntimeHub.patch({status: 'idle', serviceHello: null})
    modelRuntimeHub.connect = async () => {
      const status = await fetch('/api/model-service/status').then(r => r.json())
      modelRuntimeHub.patch({enabled: true, status: 'ready', serviceHello: hello(status.modelRevision)})
    }
    modelRuntimeHub.latestObservation = () => modelRuntimeHub.snapshot.serviceHello && {
      class_names: modelRuntimeHub.snapshot.serviceHello.class_names, probabilities: [0.55, 0.15, 0.15, 0.15],
      prepare_latency_ms: 5, inference_latency_ms: 5, received_at_ms: performance.now(),
    }
    modelRuntimeHub.patch({url: modelUrlPresets().find(p => p.id === 'proxy').url,
      enabled: true, status: 'ready', serviceHello: hello('baseline-revision')})
    window.applyTestRevision = rev => modelRuntimeHub.patch({serviceHello: hello(rev)})
    sampleClock.snapshot = () => ({sampleIndex: Math.round(performance.now() / 4), sampleRate: 250})
    sessionHub.logEvent = event => {
      const run = window.runs.at(-1)
      if (!sessionHub.active || !run) return
      const screen = document.querySelector('.smr-guided-stimulus')
      run.events.push({ ...event, code: mapLogEventTrigger(event.experiment, event.type, event.data)?.code,
        screen: screen?.innerHTML, phase: screen?.dataset.phase })
    }
  })
  await page.clock.install()
  await page.getByLabel('被试编号').fill('GUIDED')
  await page.getByLabel('采集组数').fill('1')
  await page.getByRole('button', { name: '实验员设置' }).click()
  await page.getByRole('dialog', { name: '实验员设置' }).getByText('baseline-revision', { exact: false }).first().waitFor()
  await page.getByRole('button', { name: '返回被试画面' }).click()
  const mouthAsset = page.waitForResponse(response => response.url().endsWith('/armchair/makehuman-mouth/mouth.glb'))
  await page.getByRole('button', { name: '全屏开始熟悉动作' }).click()
  assert.ok((await mouthAsset).ok())
  await page.getByRole('button', { name: '播放第 3 轮舌头示范' }).click()
  await page.getByRole('heading', { name: '观察舌头轻抵上腭' }).waitFor()
  await page.getByRole('button', { name: '播放第 4 轮双脚示范' }).click()
  await page.getByRole('heading', { name: '观察双脚抬脚尖' }).waitFor()
  await page.getByRole('button', { name: '播放第 5 轮咬牙示范' }).click()
  await page.getByRole('heading', { name: '观察轻轻咬住并保持' }).waitFor()
  assert.equal(await page.evaluate(() => window.runs.length), 0)
  assert.ok(await page.getByRole('button', { name: '实验员设置' }).isVisible())
  await page.getByRole('button', { name: '播放第 6 轮放松示范' }).click()
  await page.getByRole('heading', { name: '静坐放松' }).waitFor()
  await page.clock.fastForward(11000)
  await page.locator('[data-phase=prepare]').waitFor()
  await page.evaluate(() => document.exitFullscreen())
  await page.getByRole('heading', { name: '采集已暂停' }).waitFor()
  assert.equal(await page.evaluate(() => window.runs[0].interrupted), true)
  await page.getByRole('button', { name: '继续采集' }).click()
  await page.locator('[data-phase=prepare]').waitFor()
  async function finishGroup() {
    for (let i = 0; i < 20; i++) {
      for (const ms of [2000, 2000, 6000, 1000]) {
        await page.clock.fastForward(ms)
        await page.clock.runFor(55)
      }
    }
  }
  await finishGroup()
  await page.getByRole('button', { name: '追加一组采集' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '开始四类光标控制' }).count(), 0)
  assert.ok(await page.getByRole('button', { name: '实验员设置' }).isVisible())
  await page.getByRole('button', { name: '追加一组采集' }).click()
  await page.locator('[data-phase=prepare]').waitFor()
  await finishGroup()
  await page.getByRole('button', { name: '开始四类光标控制' }).waitFor({ timeout: 5000 })
  assert.equal(await page.evaluate(() => !!document.fullscreenElement), true)
  const runs = await page.evaluate(() => window.runs.slice(1))
  assert.deepEqual(runs.map(r => r.experiment), ['smr-adapt','smr-adapt'])
  assert.deepEqual(jobs.filter(job => job.kind === 'export').map(job => job.sessions), [['memory-1'], ['memory-1', 'memory-2']])
  assert.equal(journal.filter(entry => entry?.type === 'complete').length, 1)
  assert.equal(revision, 'adapted-revision')
  const screens = new Set()
  for (const run of runs) {
    assert.ok(run.saved && !run.interrupted)
    const events = type => run.events.filter(e => e.type === type)
    assert.equal(events('session_start')[0].data.tongueAction, 'tongue_to_palate')
    assert.equal(events('group_end')[0].data.roundId, 'guided-round')
    const trials = events('trial')
    const labels = trials.map(t => t.data.className).sort()
    assert.deepEqual(labels, ['left_hand','rest','right_hand','tongue'].flatMap(label => Array(5).fill(label)))
    for (const [i, trial] of trials.entries()) {
      const cue = events('cue')[i], start = events('feedback_start')[i]
      if (trial.data.target === 'up') {
        assert.match(cue.screen, /想象舌头轻抵上腭/)
        assert.equal(trial.data.tongueAction, 'tongue_to_palate')
        assert.equal(trial.data.cueText, '想象舌头轻抵上腭')
      }
      assert.equal(cue.phase, 'cue')
      assert.equal(start.phase, 'imagery')
      assert.equal(trial.phase, 'recover')
      assert.ok(trial.data.imageryEndSample > trial.data.imageryStartSample)
      assert.ok(trial.data.feedbackSec >= 5.99 && trial.data.feedbackSec < 6.25)
      assert.equal(start.code, cue.code + 10)
      assert.equal(trial.code, cue.code + 20)
      screens.add(start.screen)
    }
  }
  assert.equal(screens.size, 1)
  assert.match([...screens][0], /中央注视点/)
  await page.evaluate(() => window.applyTestRevision('different-revision'))
  await page.getByRole('button', { name: '开始四类光标控制' }).click()
  await page.getByRole('status').filter({hasText:'当前模型与本轮采集已验证的个体化版本不一致'}).waitFor()
  assert.equal(await page.evaluate(() => window.runs.length), 3)
  await page.evaluate(() => window.applyTestRevision('adapted-revision'))
  await page.getByRole('button', { name: '开始四类光标控制' }).click()
  await page.getByRole('button', { name: '停止 · Esc' }).waitFor()
  const cursor = await page.evaluate(() => window.runs.at(-1).events.find(e => e.type === 'session_start').data)
  assert.equal(cursor.protocol, 'smr-guided-cursor-v1')
  assert.equal(cursor.tongueAction, 'tongue_to_palate')
  assert.equal(cursor.calibrationSeed, runs[0].seed)
  assert.equal(cursor.model.revision, 'adapted-revision')
  assert.deepEqual(Object.values(cursor.mapping).sort(), ['left_hand','rest','right_hand','tongue'])
  assert.deepEqual(errors, [])
  console.log('Passed practice, operator settings, fullscreen abort/retry, 40 trials, rejected-candidate hold, cumulative training, and exact-version cursor handover.')
} finally { await browser.close() }
