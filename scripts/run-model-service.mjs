/**
 * Cross-platform launcher for the NCC-OI-BCI model WebSocket.
 *
 *   npm run model-service
 *   npm run model-service:reve
 *   npm run model-service -- --backend reve
 *   npm run model-service -- --profile bcigo32
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReveLoraArgs, resolveReveHeadMode } from './reve-launch-options.mjs'

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

export function findNcc() {
  return firstExisting([
    process.env.NCC_OI_BCI_ROOT,
    path.resolve(passiveRoot, '..', 'NCC-OI-BCI'),
    path.join(os.homedir(), 'Desktop', 'NCC-OI-BCI'),
    path.join(os.homedir(), 'Documents', 'NCC-OI-BCI'),
  ])
}

export function findPython(ncc) {
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
    // The former both-hand head is incompatible with the tongue protocol.
    return path.join(passiveRoot, 'recordings', '.reve-heads', 'smr_control_tongue.pt')
  }
  return undefined
}

function defaultStrategy(task) {
  return task === 'smr_control' || task === 'gaze_smr' ? 'none' : 'supervised-head'
}

function defaultStepSec(task) {
  return task === 'tetris_action' || task === 'smr_control' ? '0.1' : undefined
}

function main() {
  const embed = process.argv.includes('--embed') || process.env.NCC_EMBED === '1'
  const foundNcc = findNcc()
  if (!foundNcc && !embed) {
    console.error('[model-service] 找不到 NCC-OI-BCI。请设置 NCC_OI_BCI_ROOT。')
    process.exit(1)
  }
  const ncc = foundNcc ? path.resolve(foundNcc) : ''
  const python = findPython(ncc || passiveRoot)
  if (process.argv.includes('--list-heads') && !ncc) {
    console.error('[model-service] 列出分類頭仍需要外部 NCC-OI-BCI。')
    process.exit(1)
  }
  if (process.argv.includes('--list-heads')) {
    const child = spawn(python, [path.join(passiveRoot, 'scripts', 'list-reve-heads.py'), passiveRoot, ncc], {
      cwd: passiveRoot, stdio: 'inherit', windowsHide: true,
    })
    child.on('exit', (code) => process.exit(code ?? 1))
    child.on('error', (error) => { console.error(error.message); process.exit(1) })
    return
  }
  const profile = argValue('--profile') || process.env.MODEL_DEVICE_PROFILE || 'neuracle59'
  const port = process.env.MODEL_SERVICE_PORT || '8768'
  const host = process.env.MODEL_SERVICE_HOST || '127.0.0.1'
  const pkg = process.env.MODEL_PACKAGE
  const backend = (argValue('--backend') || process.env.MODEL_BACKEND || '').trim().toLowerCase()
  const omniEndpoint = argValue('--omni-endpoint') || process.env.MODEL_OMNI_ENDPOINT
  const omniChannels = argValue('--omni-channels') || process.env.MODEL_OMNI_CHANNELS
  if (omniEndpoint || omniChannels) {
    if (backend !== 'reve' || pkg) throw new Error('Omni SDK direct input requires --backend reve')
    if (!omniEndpoint || !omniChannels) throw new Error('Set both --omni-endpoint and --omni-channels (CH1..CH8 electrode order)')
  }
  const task = argValue('--task') || process.env.MODEL_REVE_TASK || 'passive_rating'
  const stepSec = argValue('--step-sec') || process.env.MODEL_STEP_SEC || defaultStepSec(task)
  const { freshHead, checkpointHead } = resolveReveHeadMode({ task, argv: process.argv.slice(2), env: process.env })
  if (freshHead && task === 'gaze_smr') throw new Error('gaze_smr requires a fitted subject head; fresh-head is for SMR plumbing only')
  const requestedStateFile = argValue('--state-file') || (!freshHead && !checkpointHead &&
    (task === 'gaze_smr' ? defaultStateFile(task) : process.env.MODEL_STATE_FILE || defaultStateFile(task))
  )
  const stateFile = requestedStateFile ? path.resolve(ncc, requestedStateFile) : undefined
  const loraArgs = backend === 'reve' && !pkg
    ? resolveReveLoraArgs({ task, stateFile, ncc, argv: [...process.argv.slice(2), ...(checkpointHead ? ['--checkpoint-head'] : [])], env: process.env }) : []
  if (checkpointHead && (backend !== 'reve' || pkg || !loraArgs.includes('--lora-checkpoint'))) {
    throw new Error('checkpoint-head requires an explicit REVE LoRA checkpoint')
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
          argValue('--size') || (task === 'gaze_smr' ? 'base' : process.env.MODEL_REVE_SIZE || 'base'),
          '--device',
          process.env.MODEL_DEVICE || 'auto',
          '--strategy',
          strategy,
          '--task',
          task,
          ...(stepSec ? ['--step-sec', String(stepSec)] : []),
          ...(stateFile ? ['--state-file', stateFile] : []),
          ...loraArgs,
          ...(omniEndpoint ? ['--omni-endpoint', omniEndpoint, '--omni-channels', omniChannels] : []),
          ...(omniEndpoint && process.argv.includes('--omni-relay') ? ['--omni-relay'] : []),
          ...(omniEndpoint && argValue('--omni-electrodes') ? ['--omni-electrodes', argValue('--omni-electrodes')] : []),
          ...(omniEndpoint && argValue('--omni-positions') ? ['--omni-positions', argValue('--omni-positions')] : []),
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

  const embedRoot = path.join(passiveRoot, 'embedded', 'ncc')
  if (embed && (pkg || backend !== 'reve')) {
    console.error('[model-service] --embed 只切換 REVE 服務程式碼。mock 與 MODEL_PACKAGE 仍走外部 NCC。')
    process.exit(1)
  }
  if (embed && !existsSync(path.join(embedRoot, 'serve_reve_model.py'))) {
    console.error('[model-service] 缺少內置服務。請先執行 node scripts/vendor-ncc-serving.mjs')
    process.exit(1)
  }
  const codeRoot = embed ? embedRoot : ncc
  const launchArgs = embed
    ? args.map((item) => (item === 'scripts/serve_reve_model.py' ? 'serve_reve_model.py' : item))
    : args
  console.log(`[model-service] NCC=${ncc || '(weights only; code is embedded)'}`)
  console.log(`[model-service] code=${codeRoot}`)
  console.log(`[model-service] python=${python}`)
  if (pkg) {
    console.log(`[model-service] runtime package=${pkg}`)
  } else if (backend === 'reve') {
    if (freshHead && !stateFile) console.warn('[model-service] Untrained task head: uniform probabilities. Pipeline check only; collect labeled EEG and fit a head before model-driven control.')
    if (checkpointHead && !stateFile) console.log('[model-service] Using the LoRA checkpoint linear head as initialization; source classes are reported by the model service.')
    console.log(
      `[model-service] backend=reve，启动本地 REVE（窗口按所选模型配置${stepSec ? ` / ${stepSec}s 步` : ''}，task=${task}，strategy=${strategy}）…`,
    )
    if (stateFile) console.log(`[model-service] state-file=${stateFile}`)
  } else {
    console.log(`[model-service] 启动 dev mock（hello ${profile} 窗长；接受 neuracle59 / bcigo32）…`)
    console.log('[model-service] 在线学习请用: npm run model-service:reve')
  }

  const child = spawn(python, launchArgs, {
    cwd: codeRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      ...(embed ? { PYTHONPATH: path.join(embedRoot, 'src'), ...(ncc ? { NCC_OI_BCI_ROOT: ncc } : {}) } : {}),
    },
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
