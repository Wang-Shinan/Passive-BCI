import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { findNcc } from './scripts/run-model-service.mjs'
import { resolveReveLoraArgs } from './scripts/reve-launch-options.mjs'
import type { ModelHead } from './vite.model-heads.ts'

const DIRECTIONS = ['left', 'right', 'up', 'down']
function contained(root: string, file: string): string {
  const real = realpathSync(file)
  const relative = path.relative(realpathSync(root), real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('模型路径越界')
  return real
}

/** Opaque, allowlisted IDs, not arbitrary client-supplied filesystem paths. */
export function readGazeHead(root: string, id = 'gaze_smr_active.pt', ncc = findNcc()): ModelHead {
  if (id !== 'gaze_smr_active.pt' && !/^gaze-smr\/[A-Za-z0-9_-]+\/head\.pt$/.test(id)) throw new Error('无效的 gaze 模型 ID')
  const headsRoot = path.join(root, 'recordings', '.reve-heads')
  const stateFile = contained(headsRoot, path.join(headsRoot, id))
  const reportFile = contained(headsRoot, id === 'gaze_smr_active.pt'
    ? path.join(headsRoot, 'gaze_smr_active.json') : path.join(headsRoot, path.dirname(id), 'report.json'))
  const text = readFileSync(reportFile, 'utf8')
  const report = JSON.parse(text)
  if (!report || report.task !== 'gaze_smr' || typeof report.modelRevision !== 'string' || !report.modelRevision
    || typeof report.subjectId !== 'string' || !report.subjectId.trim()
    || !Array.isArray(report.channels) || !report.channels.length || report.channels.some((v: unknown) => typeof v !== 'string' || !v)
    || new Set(report.channels).size !== report.channels.length || !Number.isFinite(report.sampleRate) || report.sampleRate <= 0
    || !Array.isArray(report.classNames) || report.classNames.join('|') !== DIRECTIONS.join('|')) throw new Error('gaze 报告缺少有效任务、版本、被试、通道或类别')
  const activeClasses = report.activeClasses ?? DIRECTIONS
  if (!Array.isArray(activeClasses) || !['left|right', DIRECTIONS.join('|')].includes(activeClasses.join('|'))) throw new Error('不支持的 gaze 类别子集')
  const hash = createHash('sha256').update(readFileSync(stateFile)).digest('hex')
  if (report.headSha256 !== hash) throw new Error('gaze 头与报告校验和不匹配')
  if (!ncc) throw new Error('找不到 NCC-OI-BCI，请设置 NCC_OI_BCI_ROOT')
  const size = report.encoderId === 'reve-large' ? 'large' : 'base'
  const args = resolveReveLoraArgs({ task: 'gaze_smr', stateFile, ncc, argv: ['--report-file', reportFile, '--size', size] })
  const checkpointIndex = args.indexOf('--lora-checkpoint')
  return {
    id, name: id === 'gaze_smr_active.pt' ? '当前激活 gaze 模型' : `${report.subjectId} · ${path.basename(path.dirname(id))}`,
    updatedAt: new Date(statSync(stateFile).mtimeMs).toISOString(),
    task: 'gaze_smr', encoderId: report.encoderId, classes: 4, available: true, reason: '', stateFile,
    reportFile, loraCheckpoint: checkpointIndex >= 0 ? args[checkpointIndex + 1] ?? null : null, size,
    configurationKey: createHash('sha256').update(hash).update(text).digest('hex'),
    gazeReport: { task: 'gaze_smr', subjectId: report.subjectId, channels: report.channels, sampleRate: report.sampleRate,
      modelRevision: report.modelRevision, encoderId: report.encoderId, classNames: report.classNames, activeClasses,
      trials: report.trials, bootstrapGazeOnly: report.bootstrapGazeOnly, evaluation: report.evaluation },
  }
}

export function listGazeHeads(root: string): ModelHead[] {
  const headsRoot = path.join(root, 'recordings', '.reve-heads')
  if (!existsSync(headsRoot)) return []
  const ids = existsSync(path.join(headsRoot, 'gaze_smr_active.pt')) ? ['gaze_smr_active.pt'] : []
  const archive = path.join(headsRoot, 'gaze-smr')
  if (existsSync(archive)) for (const entry of readdirSync(archive, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)) ids.push(`gaze-smr/${entry.name}/head.pt`)
  }
  return ids.map(id => {
    try { return readGazeHead(root, id) }
    catch (error) { return { id, name: id, task: 'gaze_smr', encoderId: null, classes: null, available: false,
      reason: error instanceof Error ? error.message : String(error), stateFile: '', loraCheckpoint: null, size: 'base' } }
  })
}
