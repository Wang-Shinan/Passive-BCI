import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let records = [], calls = [], finishError = false, modelError = false
const server = createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume request */ }
  calls.push(`${req.method} ${req.url}`)
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/api/record/active') return res.end(JSON.stringify({ ok: true, id: records.at(-1) ?? null, rel: 'recordings/test' }))
  if (req.url?.endsWith('/finish')) {
    res.statusCode = finishError ? 500 : 409
    if (!finishError) records.pop()
    return res.end(JSON.stringify({ ok: false, message: finishError ? 'disk failure' : 'saved interrupted', bytes: 16 }))
  }
  if (req.url === '/api/model-service/status') return res.end(JSON.stringify({ ok: true, running: false }))
  if (req.url === '/api/model-service/ensure' && modelError) {
    res.statusCode = 500
    return res.end(JSON.stringify({ ok: false, message: 'GPU unavailable' }))
  }
  res.end(JSON.stringify({ ok: true }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
async function run(script, args = [], mockBrowser = false) {
  const path = fileURLToPath(new URL(script, import.meta.url))
  const command = mockBrowser
    ? ['-Command', `function Start-Process { Write-Output 'BROWSER_OPENED' }; & '${path.replaceAll("'", "''")}' -BaseUrl '${base}'`]
    : ['-File', path, '-BaseUrl', base, ...args]
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...command], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))
}
try {
  records = ['record001', 'record002']
  let result = await run('stop-local.ps1', ['-ServicesOnly'])
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(records.length, 0)
  assert.ok(calls.indexOf('POST /api/bridge/neuracle/stop') < calls.indexOf('POST /api/record/record002/finish'))
  assert.ok(calls.includes('POST /api/record/record001/finish'))
  records = ['record003']; calls = []; finishError = true
  result = await run('stop-local.ps1', ['-ServicesOnly'])
  assert.equal(result.code, 1)
  assert.equal(records.length, 1)
  assert.match(result.stdout, /not forcibly terminated/)
  finishError = false; calls = []
  result = await run('open-website.ps1', [], true)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /BROWSER_OPENED/)
  assert.equal(calls.some(c => c.endsWith('/ensure')), false)
  records = []; calls = []; modelError = true
  result = await run('open-website.ps1', [], true)
  assert.equal(result.code, 1)
  assert.match(result.stdout, /BROWSER_OPENED/)
  assert.match(result.stdout, /GPU unavailable/)
  console.log('PASS: close saves all orphan recordings; failed save keeps website; recording/model failure cannot block opening UI.')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
