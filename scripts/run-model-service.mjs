/**
 * Cross-platform launcher for the bundled Passive-BCI model service.
 *
 *   npm run model-service
 *   npm run model-service:reve
 *   npm run model-service -- --backend reve
 *   npm run model-service -- --profile bcigo32
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveReveLoraArgs, resolveReveHeadMode } from './reve-launch-options.mjs'

import { projectRoot as passiveRoot, backendRoot, findPython, backendEnv } from './backend-paths.mjs'
export { findPython } from './backend-paths.mjs'

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
  const python = findPython()
  if (process.argv.includes('--list-heads')) {
    const child = spawn(python, [path.join(passiveRoot, 'scripts', 'list-reve-heads.py'), passiveRoot], {
      cwd: passiveRoot, env: backendEnv(), stdio: 'inherit', windowsHide: true,
    })
    child.on('exit', (code) => process.exit(code ?? 1))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.on('error', (error) => { console.error(error.message); process.exit(1) })
    return
  }
  const profile = argValue('--profile') || process.env.MODEL_DEVICE_PROFILE || 'neuracle59'
  const port = process.env.MODEL_SERVICE_PORT || '8768'
  const host = process.env.MODEL_SERVICE_HOST || '127.0.0.1'
  const pkg = process.env.MODEL_PACKAGE
  const backend = (argValue('--backend') || process.env.MODEL_BACKEND || '').trim().toLowerCase()
  if (backend === 'eegnet') {
    const args = [path.join(passiveRoot, 'scripts/serve_eegnet_tetris.py'), '--host', host, '--port', port,
      '--channels', argValue('--channels') || '32', '--seed', argValue('--seed') || '20261022']
    if (argValue('--checkpoint')) args.push('--checkpoint', argValue('--checkpoint'))
    if (argValue('--output')) args.push('--output', argValue('--output'))
    const child = spawn(python, args, { cwd: passiveRoot, env: backendEnv(), stdio: 'inherit', windowsHide: true })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.on('error', error => { console.error(error.message); process.exitCode = 1 })
    child.on('exit', code => { process.exitCode = code ?? 1 })
    return
  }
  const omniEndpoint = argValue('--omni-endpoint') || process.env.MODEL_OMNI_ENDPOINT
  const omniChannels = argValue('--omni-channels') || process.env.MODEL_OMNI_CHANNELS
  const omniDeviceType = argValue('--omni-device-type') || process.env.MODEL_OMNI_DEVICE_TYPE || 'esp32'
  if (!['esp32', 'stm32'].includes(omniDeviceType)) throw new Error('Omni device type must be esp32 or stm32')
  if (omniEndpoint || omniChannels) {
    if (backend !== 'reve' || pkg) throw new Error('Omni SDK direct input requires --backend reve')
    if (!omniEndpoint || !omniChannels) throw new Error('Set both --omni-endpoint and --omni-channels (hardware channel order)')
  }
  const task = argValue('--task') || process.env.MODEL_REVE_TASK || 'passive_rating'
  const stepSec = argValue('--step-sec') || process.env.MODEL_STEP_SEC || defaultStepSec(task)
  const { freshHead, checkpointHead } = resolveReveHeadMode({ task, argv: process.argv.slice(2), env: process.env })
  if (freshHead && task === 'gaze_smr') throw new Error('gaze_smr requires a fitted subject head; fresh-head is for SMR plumbing only')
  const requestedStateFile = argValue('--state-file') || (!freshHead && !checkpointHead &&
    (task === 'gaze_smr' ? defaultStateFile(task) : process.env.MODEL_STATE_FILE || defaultStateFile(task))
  )
  const stateFile = requestedStateFile ? path.resolve(passiveRoot, requestedStateFile) : undefined
  const loraArgs = backend === 'reve' && !pkg
    ? resolveReveLoraArgs({ task, stateFile, projectRoot: passiveRoot, argv: [...process.argv.slice(2), ...(checkpointHead ? ['--checkpoint-head'] : [])], env: process.env }) : []
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
          ...(argValue('--model-dir') ? ['--model-dir', argValue('--model-dir')] : []),
          '--device',
          process.env.MODEL_DEVICE || 'auto',
          '--strategy',
          strategy,
          '--task',
          task,
          ...(stepSec ? ['--step-sec', String(stepSec)] : []),
          ...(stateFile ? ['--state-file', stateFile] : []),
          ...loraArgs,
          ...(omniEndpoint ? ['--omni-endpoint', omniEndpoint, '--omni-channels', omniChannels, '--omni-device-type', omniDeviceType] : []),
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
          ...(process.env.MODEL_NO_TCP === '1' ? ['--no-tcp'] : []),
        ]

  // --embed remains accepted for old shortcuts; all backends now run in-tree.
  const launchArgs = args.map(item => item === 'scripts/serve_reve_model.py'
    ? path.join(backendRoot, 'serve_reve_model.py')
    : /^scripts\/serve_.*\.py$/.test(item) ? path.join(backendRoot, item) : item)
  if (!existsSync(launchArgs[0])) throw new Error(`Missing bundled backend entry: ${launchArgs[0]}`)
  console.log(`[model-service] code=${backendRoot}`)
  console.log(`[model-service] python=${python}`)
  const child = spawn(python, launchArgs, {
    cwd: passiveRoot, stdio: 'inherit', env: backendEnv(), windowsHide: true,
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
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
