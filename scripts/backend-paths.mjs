import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const backendRoot = path.join(projectRoot, 'embedded', 'ncc')
export const adapterRoot = path.resolve(process.env.REVE_ADAPTER_ROOT || path.join(projectRoot, 'checkpoints', 'adapters'))
export const checkpointRoot = path.resolve(process.env.REVE_CHECKPOINT_ROOT || path.join(projectRoot, 'checkpoints', 'backbones'))

export function findPython() {
  // Explicit old variable remains an alias; never discover another repository or Conda environment.
  const configured = process.env.PASSIVE_BCI_PYTHON || process.env.NCC_PYTHON
  if (configured) return configured
  const local = path.join(projectRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  if (existsSync(local)) return local
  if (process.platform === 'win32') {
    // The bare `python` on PATH is often the Microsoft Store alias stub (exit 9009).
    // Resolve a real interpreter through the py launcher instead.
    for (const versionFlag of ['-3.11', null]) {
      try {
        const args = [...(versionFlag ? [versionFlag] : []), '-c', 'import sys; print(sys.executable)']
        const exe = execFileSync('py', args, { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
        if (exe && existsSync(exe)) return exe
      } catch { /* keep looking */ }
    }
    return 'python'
  }
  return 'python3'
}
export function backendEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
    PYTHONPATH: [path.join(backendRoot, 'src'), path.join(backendRoot, 'scripts'), path.join(projectRoot, 'scripts')].join(path.delimiter),
    REVE_CHECKPOINT_ROOT: checkpointRoot, REVE_ADAPTER_ROOT: adapterRoot,
    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1', TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE ?? '1' }
}
export function runBackend(script, args = []) {
  const child = spawn(findPython(), [script, ...args], { cwd: projectRoot, env: backendEnv(), stdio: 'inherit', windowsHide: true })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  return child
}
