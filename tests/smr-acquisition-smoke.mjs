// Isolated UI integration: synthetic predictions and an in-memory recorder, no device or disk recordings.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || import.meta.url)
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = [], mutations = []
  page.on('pageerror', error => errors.push(error.message))
  // Normalize Vite HMR timestamps so mocked imports and the app share one runtime singleton.
  await page.route('**/src/**', async route => {
    const response = await route.fetch()
    if ((response.headers()['content-type'] || '').includes('javascript')) {
      await route.fulfill({ response, body: (await response.text()).replace(/\?t=\d+/g, '') })
    } else await route.fulfill({ response })
  })
  await page.addInitScript(() => {
    localStorage.setItem('passive-bci.model-service-enabled', 'false')
    localStorage.setItem('passive-bci.subject-id', 'S04')
    window.testRecords = { starts: 0, stops: 0, active: false }
  })
  await page.route('**/api/**', async route => {
    if (route.request().method() === 'POST') mutations.push(route.request().url())
    await route.fulfill({ json: { ok: true, running: false, heads: [], id: null } })
  })
  await page.route('**/src/lib/session/recordControl.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    const state = window.testRecords;
    export const recorderIsActive = () => state.active;
    export const recorderBytes = () => 0;
    export const canStartExperimentRecording = () => true;
    export async function startExperimentRecording() { state.starts++; state.active = true; return {ok:true,sink:'disk',rel:'test-memory',message:'test recorder'} }
    export async function stopExperimentRecording() {
      if (window.testSaveFail) return {ok:false,message:'test: save failed'};
      await new Promise(resolve => setTimeout(resolve, 150));
      state.stops++; state.active = false; return {ok:true,rel:'test-memory',message:'test saved'}
    }
    export const rollExperimentRecording = startExperimentRecording;
  ` }))
  await page.route('**/src/lib/model-runtime/connectSmrModel.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import { modelRuntimeHub as hub } from '/src/lib/model-runtime/modelRuntimeHub.ts';
    import { liveEegHub } from '/src/lib/eeg/liveHub.ts';
    export { S04_HEAD } from '/src/lib/model-runtime/subjectModels.ts';
    export async function connectSmrModel(signal, progress, head) {
      window.testPrepareCount = (window.testPrepareCount || 0) + 1;
      if (window.testRecords.active) throw new Error('test: cannot replace model while recording');
      window.testHead = head;
      if (window.testFail) throw new Error('test: EEG unavailable');
      const labels = ['left_hand','right_hand','tongue','rest'];
      const revision = 's04-test-4s';
      liveEegHub.isFresh = () => true;
      hub.patch({status:'ready', serviceHello:{class_names:labels,model_revision:revision,window_sec:4,supports_group_training:false}});
      const send = () => hub.patch({latestPrediction:{type:'prediction', observation_id:crypto.randomUUID(),class_names:labels,probabilities:[0.01,0.97,0.01,0.01],class_name:'right_hand',model_revision:revision,received_at_ms:performance.now()}});
      send(); clearInterval(window.testFeed); window.testFeed = setInterval(send,100);
      progress('test: prediction ready');
    }
  ` }))
  await page.goto(`${process.env.NEUROSLIDE_URL || 'http://127.0.0.1:5173'}/#/smr-acquisition`)
  await page.getByRole('button', { name: '实验员设置', exact: true }).click()
  await page.getByRole('button', { name: '连接 EEG 与所选模型', exact: true }).click()
  await page.getByTestId('smr-model-revision').filter({ hasText: 's04-test-4s' }).waitFor()
  assert.equal(await page.evaluate(() => window.testHead), 'smr_control_lp_093f1a91-f720-4773-b87f-4c2f8a5daea3.pt')
  assert.equal(await page.getByLabel('组间自动训练并评估接管').isChecked(), false)
  assert.equal(await page.getByLabel('组间自动训练并评估接管').isDisabled(), true)
  await page.getByRole('button', { name: '返回被试画面', exact: true }).click()
  await page.evaluate(() => { window.testFail = true })
  await page.getByRole('button', { name: '连接并全屏开始', exact: true }).click()
  await page.getByRole('heading', { name: '尚未开始本轮' }).waitFor()
  assert.equal(await page.evaluate(() => window.testRecords.starts), 0, 'no recording until prediction readiness')
  // Reproduce entering SMR from acquisition with an existing recording.
  const prepareCount = await page.evaluate(() => window.testPrepareCount)
  await page.evaluate(() => { window.testFail = false; window.testSaveFail = true; window.testRecords.active = true })
  await page.getByRole('button', { name: '连接并全屏开始', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'test: save failed' }).first().waitFor()
  assert.equal(await page.evaluate(() => window.testPrepareCount), prepareCount, 'failed saving must prevent model changes')
  assert.equal(await page.evaluate(() => window.testRecords.starts), 0)
  await page.evaluate(() => { window.testSaveFail = false })
  await page.getByRole('button', { name: '连接并全屏开始', exact: true }).click()
  await page.waitForFunction(() => {
    const cursor = document.querySelector('.smr-participant-cursor')
    return cursor && parseFloat(cursor.style.left) > 51
  }, null, { timeout: 15000 })
  assert.equal(await page.evaluate(() => window.testRecords.starts), 1)
  assert.equal(await page.evaluate(() => window.testRecords.stops), 1, 'finish the pre-existing recording before preparing the model')
  await page.evaluate(async () => {
    clearInterval(window.testFeed)
    const { modelRuntimeHub } = await import('/src/lib/model-runtime/modelRuntimeHub.ts')
    modelRuntimeHub.patch({latestPrediction:null})
  })
  await page.getByRole('heading', { name: '采集已暂停' }).waitFor()
  await page.waitForFunction(() => window.testRecords.stops === 2)
  assert.equal(await page.evaluate(() => window.testRecords.stops), 2, 'prediction loss must stop, never fall back to synthetic motion')
  await page.getByRole('button', { name: '实验员设置', exact: true }).click()
  await page.getByLabel('仅演示预览（不录制、不使用模型反馈）').check()
  await page.getByRole('button', { name: '返回被试画面', exact: true }).click()
  await page.getByRole('button', { name: '开始下一轮', exact: true }).click()
  await page.getByLabel('控制光标', { exact: true }).waitFor({ timeout: 10000 })
  assert.equal(await page.evaluate(() => window.testRecords.starts), 1, 'explicit preview never records')
  await page.getByRole('button', { name: '停止 · Esc', exact: true }).click()
  assert.deepEqual(mutations, [], 'no real recordings, training or model mutation')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ok:true, readiness:true, modelDrivenCursor:true, stopsOnPredictionLoss:true, incompatibleTrainingDisabled:true}))
} finally { await browser.close() }
