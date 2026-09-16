import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const port = 5179, base = `http://127.0.0.1:${port}`
const server = spawn('npm', ['run','dev','--','--host','127.0.0.1','--port',String(port),'--strictPort'], { detached:true, stdio:['ignore','pipe','pipe'] })
let logs = ''; server.stdout.on('data', b => { logs += b }); server.stderr.on('data', b => { logs += b })
let browser, page
const errors=[]
mkdirSync('test-results',{recursive:true})
try {
  let ready = false
  for(let i=0;i<150;i++) { try { if((await fetch(base)).ok) { ready=true; break } } catch {} await new Promise(r=>setTimeout(r,200)) }
  assert.ok(ready, 'Vite did not start')
  browser = await chromium.launch({headless:true})
  page = await browser.newPage({ viewport:{width:1600,height:1000} })
  page.setDefaultTimeout(15000)
  page.on('pageerror', e => { errors.push(e.message); console.error('[pageerror]',e.message) })
  await page.addInitScript(() => {
    window.__socketStarts=0
    const NativeSocket = window.WebSocket
    class FakeSocket {
      static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3
      readyState=0;bufferedAmount=0
      constructor(url, protocols) { if (!String(url).includes('/ws/model') && !String(url).includes(':8768')) return new NativeSocket(url, protocols); window.__socketStarts++; setTimeout(()=>{this.readyState=1;this.onopen?.({})},0) }
      send(raw) { if(JSON.parse(raw).type==='hello') setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'hello',schema_version:1,model_type:'reve',...window.__fixtureModel})}),0) }
      close() { this.readyState=3; this.onclose?.({code:1000,reason:'',wasClean:true}) }
    }
    window.WebSocket=FakeSocket
  })
  const report={task:'gaze_smr',subjectId:'S01',channels:['C3','C4'],sampleRate:250,modelRevision:'gaze-history',encoderId:'reve-base',classNames:['left','right','up','down'],activeClasses:['left','right'],trials:20,bootstrapGazeOnly:false,evaluation:{n:4,balancedAccuracy:.75,recalls:[.5,1]}}
  const heads=[{id:'smr-a.pt',task:'smr_control'},{id:'smr-b.pt',task:'smr_control'},{id:'gaze-smr/20260917T120000Z/head.pt',task:'gaze_smr',gazeReport:report}].map(h=>({...h,name:h.id,encoderId:'reve-base',classes:4,available:true,reason:''}))
  let current={ok:true,backend:null,running:false,owned:false,starting:false,headId:null,port:8768,pid:null,alreadyRunning:false}, recording=false, holdNext=false, release
  const launches=[], events=[]
  await page.route('**/api/model-service/**',async route=>{
    const action=new URL(route.request().url()).pathname.split('/').pop()
    let body
    if(action==='heads') body={ok:true,heads}
    else if(action==='status') body=current
    else if(action==='stop') {current={...current,running:false,owned:false,headId:null,task:null}; body=current}
    else if(action==='ensure') {
      const req=route.request().postDataJSON(); launches.push(req)
      const answer={...current,backend:req.backend,task:req.task,headId:req.headId||null,running:true,owned:true,starting:false,stepSec:req.stepSec,modelRevision:req.task==='gaze_smr'?'gaze-history':req.headId,gazeReport:req.task==='gaze_smr'?report:null}
      if(holdNext){holdNext=false;await new Promise(r=>{release=r})}
      else current=answer
      await page.evaluate(v=>{window.__fixtureModel=v},{task:req.task,model_revision:answer.modelRevision,class_names:req.task==='gaze_smr'?['left','right','up','down']:['left_hand','right_hand','both_hand','rest']})
      body=answer
    } else body={ok:true}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{})
  })
  await page.route('**/api/record/**',route=>{
    if(route.request().url().endsWith('/events')) events.push(...route.request().postData().trim().split('\n').filter(Boolean).map(JSON.parse))
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,id:recording?'ui-fixture-session':null,rel:recording?'recordings/ui-fixture':null})})
  })
  await page.goto(`${base}/tests/ui/model-controls.html`)
  console.log('[ui] Tetris fixture opened')
  const picker=page.getByLabel('线性头',{exact:true})
  await picker.selectOption('smr-a.pt')
  await page.getByRole('checkbox',{name:/用 SMR 头操控方块/}).check()
  await page.getByText(/已运行：smr-a.pt/).waitFor()
  assert.equal(launches.at(-1).headId,'smr-a.pt')
  await picker.selectOption('smr-b.pt')
  assert.equal(launches.length,1,'selecting is not applying')
  await page.getByRole('button',{name:'应用线性头并重启',exact:true}).click()
  await page.getByText(/已运行：smr-b.pt/).waitFor()
  assert.equal(launches.at(-1).headId,'smr-b.pt')
  console.log('[ui] selected and applied A/B')
  recording=true; await page.getByRole('button',{name:'Fixture record',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('select[aria-label="线性头"]')?.disabled)
  assert.equal(await page.getByRole('button',{name:'启动 Mock',exact:true}).isDisabled(),true)
  assert.equal(await page.getByLabel('脑控任务',{exact:true}).isDisabled(),true)
  await page.getByRole('button',{name:'Fixture direct launch',exact:true}).click()
  await page.getByTestId('direct-error').filter({hasText:'录制期间'}).waitFor()
  assert.equal(launches.length,2)
  await page.getByRole('button',{name:'停止服务（不自动重连）',exact:true}).click()
  const stoppedSockets=await page.evaluate(()=>window.__socketStarts)
  await page.waitForTimeout(2300)
  assert.equal(await page.evaluate(()=>window.__socketStarts),stoppedSockets,'stop must not reconnect')
  assert.equal(await page.getByRole('checkbox',{name:'启用 NCC 模型旁路',exact:true}).isChecked(),false)
  assert.ok(events.some(e=>e.type==='brain_model_binding' && e.data.headId==='smr-b.pt'),'recording captures loaded head identity')
  console.log('[ui] recording lock, direct API and stop verified')
  recording=false;await page.getByRole('button',{name:'Fixture finish',exact:true}).click()
  await page.getByLabel('脑控任务',{exact:true}).selectOption('gaze_smr')
  await picker.selectOption('gaze-smr/20260917T120000Z/head.pt')
  await page.getByRole('button',{name:'启动 眼动辅助 SMR',exact:true}).click()
  await page.getByText(/已运行：gaze-smr/).waitFor()
  assert.equal(launches.at(-1).headId,'gaze-smr/20260917T120000Z/head.pt')
  await page.screenshot({path:'test-results/tetris-controls.png',fullPage:true})
  await page.getByRole('button',{name:'停止服务（不自动重连）',exact:true}).click()
  await page.getByText(/已运行：未运行/).waitFor()
  console.log('[ui] historical gaze head applied')
  holdNext=true
  await page.getByRole('button',{name:'启动 眼动辅助 SMR',exact:true}).click()
  for(let i=0;i<100&&!release;i++) await page.waitForTimeout(20)
  assert.ok(release,'pending launch not observed')
  await page.getByRole('button',{name:'停止服务（不自动重连）',exact:true}).click()
  release();await page.waitForTimeout(500)
  assert.equal(await page.getByRole('checkbox',{name:'启用 NCC 模型旁路',exact:true}).isChecked(),false,'late launch must not re-enable runtime')
  assert.deepEqual(errors,[])
  const summary={passed:true,scenarios:['traditional head A launch','select B without applying','apply B','recording locks picker/task/Mock','direct API cannot bypass recording lock','stop cancels reconnect','historical gaze selection','stop during launch rejects late success'],limitations:'Mock HTTP/WS and recording attachment; no EEG hardware or model inference.'}
  writeFileSync('test-results/ui-summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary))
} catch (error) {
  writeFileSync('test-results/ui-failure.json',JSON.stringify({message:String(error),pageErrors:errors},null,2))
  if(page) {
    await page.screenshot({path:'test-results/ui-failure.png',fullPage:true}).catch(()=>{})
    writeFileSync('test-results/ui-failure.txt',await page.locator('body').innerText().catch(()=>''))
  }
  throw error
} finally {
  writeFileSync('test-results/vite.log',logs)
  await browser?.close()
  try {process.kill(-server.pid,'SIGTERM')} catch {}
}
