import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { findNcc, findPython } from './run-model-service.mjs'

const ncc = findNcc()
if (!ncc) throw new Error('找不到 NCC-OI-BCI，请设置 NCC_OI_BCI_ROOT')
const script = path.join(ncc, 'scripts', 'fit_gaze_smr_head.py')
if (!existsSync(script)) throw new Error('缺少 fit_gaze_smr_head.py，请先更新配套 NCC-OI-BCI gaze-SMR 后端')
const child = spawn(findPython(ncc), [script, ...process.argv.slice(2)], {
  cwd: ncc, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal) })
