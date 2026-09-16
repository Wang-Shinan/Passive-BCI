import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findNcc, findPython } from './run-model-service.mjs'

const ncc = findNcc()
if (!ncc) throw new Error('找不到 NCC-OI-BCI')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(findPython(ncc), [path.join(root, 'scripts/training-job.py'), '--ncc', ncc, '--job', process.argv[2]], {
  cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  stdio: 'inherit', windowsHide: true,
})
child.on('error', error => { console.error(error); process.exit(1) })
child.on('exit', code => process.exit(code ?? 1))
