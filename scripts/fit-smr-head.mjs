/**
 * Offline-fit the REVE smr_control head from recordings/*smr-adapt* bins.
 *
 *   npm run model-service:reve:smr:fit
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const passiveRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const condaEnvName = 'bci-dayloop'

function firstExisting(candidates) {
  return candidates.find((value) => typeof value === 'string' && value.length > 0 && existsSync(value))
}

function condaRoots() {
  const prefix = process.env.CONDA_PREFIX
  const roots = []
  if (prefix) {
    roots.push(prefix)
    const parent = path.dirname(prefix)
    if (path.basename(parent) === 'envs') roots.push(path.dirname(parent))
    else roots.push(prefix)
  }
  roots.push(
    path.join(os.homedir(), 'anaconda3'),
    path.join(os.homedir(), 'miniconda3'),
    path.join(os.homedir(), 'mambaforge'),
    'D:\\Programs\\Anaconda',
    'C:\\ProgramData\\anaconda3',
  )
  return [...new Set(roots.filter(Boolean))]
}

function findNcc() {
  return firstExisting([
    process.env.NCC_OI_BCI_ROOT,
    path.resolve(passiveRoot, '..', 'NCC-OI-BCI'),
    path.join(os.homedir(), 'Desktop', 'NCC-OI-BCI'),
    path.join(os.homedir(), 'Documents', 'NCC-OI-BCI'),
  ])
}

function findPython(ncc) {
  const candidates = [
    process.env.NCC_PYTHON,
    path.join(ncc, '.venv', 'Scripts', 'python.exe'),
    path.join(ncc, '.venv', 'bin', 'python'),
  ]
  for (const root of condaRoots()) {
    candidates.push(
      path.join(root, 'envs', condaEnvName, 'python.exe'),
      path.join(root, 'envs', condaEnvName, 'bin', 'python'),
    )
    if (path.basename(root) === condaEnvName) {
      candidates.push(path.join(root, 'python.exe'), path.join(root, 'bin', 'python'))
    }
  }
  return firstExisting(candidates) || (process.platform === 'win32' ? 'python' : 'python3')
}

function extraArgs() {
  const start = process.argv.indexOf('--')
  return start >= 0 ? process.argv.slice(start + 1) : process.argv.slice(2)
}

function main() {
  const ncc = findNcc()
  if (!ncc) {
    console.error('[fit-smr] 找不到 NCC-OI-BCI。请设置 NCC_OI_BCI_ROOT。')
    process.exit(1)
  }
  const python = findPython(ncc)
  const recordings = path.join(passiveRoot, 'recordings')
  const stateFile = path.join(recordings, '.reve-heads', 'smr_control.pt')
  const args = [
    'scripts/fit_smr_control_head.py',
    '--recordings',
    recordings,
    '--state-file',
    stateFile,
    ...extraArgs(),
  ]
  console.log(`[fit-smr] NCC=${ncc}`)
  console.log(`[fit-smr] python=${python}`)
  console.log(`[fit-smr] recordings=${recordings}`)
  console.log(`[fit-smr] state-file=${stateFile}`)
  const child = spawn(python, args, {
    cwd: ncc,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    windowsHide: false,
  })
  child.on('error', (error) => {
    console.error(`[fit-smr] 无法启动 Python: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1)
    process.exit(code ?? 1)
  })
}

main()
