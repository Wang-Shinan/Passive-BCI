/**
 * Cross-platform launcher for the NCC-OI-BCI model WebSocket.
 *
 *   npm run model-service
 *   npm run model-service:reve
 *   npm run model-service -- --backend reve
 *   npm run model-service -- --profile bcigo32
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return undefined
}

function defaultStateFile(task) {
  if (task === 'gaze_smr') return path.join(passiveRoot, 'recordings', '.reve-heads', 'gaze_smr_active.pt')
  if (task === 'smr_control') {
    // Live now: 0825pm joint LoRA + LP head refit on today's BCIGo session.
    // Previous default (0825pm hop01 LoRA + serving-refit head): recordings/.reve-heads/smr_control_s02_0825pm_4class_livehead.pt
    // Previous default (0821 LoRA): recordings/.reve-heads/smr_control_s02_4class_livehead.pt
    return path.join(passiveRoot, 'recordings', '.reve-heads', 'smr_control_s02_0825pm_joint_4class_livehead.pt')
  }
  return undefined
}

function defaultStrategy(task) {
  return task === 'smr_control' || task === 'gaze_smr' ? 'none' : 'supervised-head'
}

function defaultStepSec(task) {
  return task === 'tetris_action' ? '0.1' : undefined
}

function main() {
  const ncc = findNcc()
  if (!ncc) {
    console.error('[model-service] 找不到 NCC-OI-BCI。请设置 NCC_OI_BCI_ROOT。')
    process.exit(1)
  }
  const python = findPython(ncc)
  const profile = argValue('--profile') || process.env.MODEL_DEVICE_PROFILE || 'neuracle59'
  const port = process.env.MODEL_SERVICE_PORT || '8768'
  const host = process.env.MODEL_SERVICE_HOST || '127.0.0.1'
  const pkg = process.env.MODEL_PACKAGE
  const backend = (argValue('--backend') || process.env.MODEL_BACKEND || '').trim().toLowerCase()
  const task = argValue('--task') || process.env.MODEL_REVE_TASK || 'passive_rating'
  const stepSec = argValue('--step-sec') || process.env.MODEL_STEP_SEC || defaultStepSec(task)
  const stateFile = argValue('--state-file') || process.env.MODEL_STATE_FILE || defaultStateFile(task)
  let pairedLora = null
  if (task === 'gaze_smr' && stateFile) {
    const metadata = stateFile.replace(/\.pt$/, '.json')
    if (existsSync(metadata)) pairedLora = JSON.parse(readFileSync(metadata, 'utf8')).loraCheckpoint || null
    if (pairedLora && !existsSync(pairedLora)) throw new Error(`Missing paired LoRA: ${pairedLora}`)
  }
  const strategy =
    argValue('--strategy') ||
    (task === 'smr_control' || task === 'gaze_smr' ? defaultStrategy(task) : process.env.MODEL_STRATEGY || defaultStrategy(task))
  const args = pkg
    ? [
        'scripts/serve_runtime_model.py',
        '--package',
        pkg,
        '--host',
        host,
        '--port',
        port,
        '--strategy',
        process.env.MODEL_STRATEGY || 'none',
        ...(process.env.MODEL_DEVICE ? ['--device', process.env.MODEL_DEVICE] : []),
        ...(stateFile ? ['--state-file', stateFile] : []),
      ]
      : backend === 'reve'
      ? [
          'scripts/serve_reve_model.py',
          '--host',
          host,
          '--port',
          port,
          '--size',
          process.env.MODEL_REVE_SIZE || 'base',
          '--device',
          process.env.MODEL_DEVICE || 'auto',
          '--strategy',
          strategy,
          '--task',
          task,
          ...(stepSec ? ['--step-sec', String(stepSec)] : []),
          ...(stateFile ? ['--state-file', stateFile] : []),
          ...(pairedLora || process.env.MODEL_REVE_LORA ? ['--lora-checkpoint', pairedLora || process.env.MODEL_REVE_LORA] : []),
          ...(process.env.MODEL_REVE_NO_LORA === '1' ? ['--no-lora'] : []),
          ...(process.env.MODEL_TCP_HOST ? ['--tcp-host', process.env.MODEL_TCP_HOST] : []),
          ...(process.env.MODEL_TCP_PORT ? ['--tcp-port', process.env.MODEL_TCP_PORT] : []),
          ...(process.env.MODEL_NO_TCP === '1' ? ['--no-tcp'] : []),
        ]
      : [
          'scripts/serve_dev_mock_model.py',
          '--host',
          host,
          '--port',
          port,
          '--profile',
          profile,
        ]

  console.log(`[model-service] NCC=${ncc}`)
  console.log(`[model-service] python=${python}`)
  if (pkg) {
    console.log(`[model-service] runtime package=${pkg}`)
  } else if (backend === 'reve') {
    console.log(
      `[model-service] backend=reve，启动本地 REVE（2s 窗${stepSec ? ` / ${stepSec}s 步` : ''}，task=${task}，strategy=${strategy}）…`,
    )
    if (stateFile) console.log(`[model-service] state-file=${stateFile}`)
  } else {
    console.log(`[model-service] 启动 dev mock（hello ${profile} 窗长；接受 neuracle59 / bcigo32）…`)
    console.log('[model-service] 在线学习请用: npm run model-service:reve')
  }

  const child = spawn(python, args, {
    cwd: ncc,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    windowsHide: false,
  })
  child.on('error', (error) => {
    console.error(`[model-service] 无法启动 Python: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1)
    process.exit(code ?? 1)
  })
}

main()
