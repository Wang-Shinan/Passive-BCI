import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

function option(argv, flag) {
  const index = argv.indexOf(flag)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
  return value
}

/** Keep a deployed gaze head paired with its training encoder, not today's defaults. */
export function resolveReveLoraArgs({ task, stateFile, ncc, argv = [], env = {} }) {
  const explicit = option(argv, '--lora-checkpoint')
  const noLora = argv.includes('--no-lora') || (!explicit && env.MODEL_REVE_NO_LORA === '1')
  if (explicit && argv.includes('--no-lora')) {
    throw new Error('--lora-checkpoint and --no-lora are mutually exclusive')
  }
  let paired
  let frozenBase = false
  if (task === 'gaze_smr') {
    if (!stateFile || !/\.pt$/i.test(stateFile) || !existsSync(stateFile)) {
      throw new Error('Missing gaze-SMR active head; complete gaze collection and fitting first')
    }
    const reportPath = stateFile.replace(/\.pt$/i, '.json')
    if (!existsSync(reportPath)) throw new Error(`Missing gaze-SMR report: ${reportPath}`)
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (!report || report.task !== 'gaze_smr') throw new Error('Gaze head/report task mismatch')
    if (report.headSha256 && createHash('sha256').update(readFileSync(stateFile)).digest('hex') !== report.headSha256) {
      throw new Error('Gaze head/report checksum mismatch; finish activation before starting')
    }
    const encoder = report.encoderId
    if (typeof encoder !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(encoder)) {
      throw new Error('Gaze report is missing a valid encoderId')
    }
    frozenBase = encoder === 'reve-base' || encoder === 'reve-large'
    const size = encoder === 'reve-large' ? 'large' : 'base'
    if (option(argv, '--size') && option(argv, '--size') !== size) {
      throw new Error('Requested REVE size differs from the gaze training encoder')
    }
    if (!frozenBase) {
      // NCC PR #1 reports encoderId but older reports omit loraCheckpoint.
      paired = typeof report.loraCheckpoint === 'string' && report.loraCheckpoint
        ? path.resolve(ncc, report.loraCheckpoint)
        : path.join(ncc, 'checkpoints', 'adapters', encoder, 'best.pt')
      if (!existsSync(paired)) throw new Error(`Missing paired LoRA: ${paired}`)
      if (noLora) throw new Error('The selected gaze head requires its paired LoRA; remove --no-lora')
      if (explicit && (!existsSync(path.resolve(ncc, explicit)) || realpathSync(path.resolve(ncc, explicit)) !== realpathSync(paired))) {
        throw new Error('Explicit LoRA differs from the gaze head training encoder')
      }
    } else if (explicit) {
      throw new Error('This gaze head was trained without LoRA')
    }
  }
  if (frozenBase || noLora) return ['--no-lora']
  const checkpoint = paired || explicit || env.MODEL_REVE_LORA
  return checkpoint ? ['--lora-checkpoint', checkpoint] : []
}
