import {
  defaultRangeForDriver,
  displayValueForDriver,
  ensureIdsForDriver,
  resolveDriverRaw,
} from '../../lib/features/controlMapping'
import {
  displayKeysForEnabled,
  FEATURE_CATALOG,
} from '../../lib/features/featureCatalog'

export const DEFAULT_LINEAR_HEAD_FEATURES = [
  'relaxation_score',
  'focus_score',
  'cognitive_load',
  'drowsiness',
  'rel_power_alpha',
  'rel_power_beta',
  'rel_power_theta',
  'rms',
]

export const LINEAR_HEAD_CLASSES = ['差', '中', '好'] as const
export const LINEAR_HEAD_RATINGS = [-1, 0, 1] as const

const N_CLASS = 3
const STORAGE_KEY = 'passive-bci.rl-linear-head'
export const LINEAR_HEAD_MIN_TRAIN = 5

export type LinearHeadPred = {
  classIndex: number
  label: string
  rating: number
  probs: number[]
}

export type LinearHeadStats = {
  nTrain: number
  lastLoss: number | null
  acc: number | null
  hiddenSize: number
  useRelu: boolean
  arch: string
  lr: number
}

export function clampHiddenSize(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(64, Math.round(n)))
}

export function archLabel(hiddenSize: number, useRelu: boolean): string {
  if (hiddenSize <= 0) return '线性'
  return useRelu ? `${hiddenSize}→ReLU→3` : `${hiddenSize}→线性→3`
}

export function allHeadDisplayKeys(): string[] {
  return displayKeysForEnabled(FEATURE_CATALOG.map((f) => f.id))
}

const VALID_HEAD_KEYS = new Set(allHeadDisplayKeys())

export function sanitizeHeadFeatures(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!VALID_HEAD_KEYS.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length ? out : [...DEFAULT_LINEAR_HEAD_FEATURES]
}

export function ensureIdsForHeadFeatures(keys: string[]): string[] {
  const set = new Set<string>()
  for (const id of keys) {
    for (const e of ensureIdsForDriver(id)) set.add(e)
  }
  return [...set]
}

function scaleFeature(id: string, raw: number): number {
  const d = displayValueForDriver(id, raw)
  if (!Number.isFinite(d)) return NaN
  if (id === 'rms' || id === 'std') {
    return Math.max(0, Math.min(1, Math.log1p(Math.max(0, d)) / Math.log1p(80)))
  }
  const r = defaultRangeForDriver(id)
  const lo = Math.min(r.inMin, r.inMax)
  const hi = Math.max(r.inMin, r.inMax)
  const span = hi - lo
  if (Math.abs(span) < 1e-12) return 0.5
  return Math.max(0, Math.min(1, (d - lo) / span))
}

export type LinearFeatureRow = {
  id: string
  raw: number | null
  unit: number | null
}

export function inspectLinearFeatures(
  values: Record<string, number> | undefined,
  keys: string[],
): { rows: LinearFeatureRow[]; vector: number[] | null } {
  const rows: LinearFeatureRow[] = []
  const x: number[] = []
  let ok = Boolean(values) && keys.length > 0
  for (const id of keys) {
    const raw = values ? resolveDriverRaw(values, id) : undefined
    if (raw === undefined || !Number.isFinite(raw)) {
      rows.push({ id, raw: null, unit: null })
      ok = false
      continue
    }
    const unit = scaleFeature(id, raw)
    if (!Number.isFinite(unit)) {
      rows.push({ id, raw, unit: null })
      ok = false
      continue
    }
    rows.push({ id, raw, unit })
    x.push(unit)
  }
  return { rows, vector: ok ? x : null }
}

export function extractLinearFeatures(
  values: Record<string, number> | undefined,
  keys: string[],
): number[] | null {
  return inspectLinearFeatures(values, keys).vector
}

/** Map TAMER rating (−1…+1 or 1–5 keys) onto 3 classes. */
export function ratingToClass(rating: number): number {
  if (rating <= -0.25) return 0
  if (rating >= 0.25) return 2
  return 1
}

function softmax(logits: number[]): number[] {
  const clipped = logits.map((z) => Math.max(-8, Math.min(8, z)))
  const m = Math.max(...clipped)
  const ex = clipped.map((z) => Math.exp(z - m))
  const s = ex.reduce((a, b) => a + b, 0)
  return ex.map((e) => e / s)
}

function zeros(n: number): number[] {
  return Array.from({ length: n }, () => 0)
}

function randMat(nOut: number, nIn: number, scale: number): number[] {
  return Array.from({ length: nOut * nIn }, () => (Math.random() * 2 - 1) * scale)
}

function affine(x: number[], W: number[], b: number[], nIn: number, nOut: number): number[] {
  const out = Array.from({ length: nOut }, () => 0)
  for (let i = 0; i < nOut; i++) {
    let s = b[i]!
    const row = i * nIn
    for (let j = 0; j < nIn; j++) s += W[row + j]! * x[j]!
    out[i] = s
  }
  return out
}

const DATA_CAP = 4000
const LABEL_SMOOTH = 0.05
export const DEFAULT_HEAD_LR = 0.05
const REFIT_STEPS = 60

type DataItem = { x: number[]; y: number }

export class LinearHead {
  keys: string[]
  nFeat: number
  hiddenSize = 0
  useRelu = true
  /** Hidden layer: hiddenSize × nFeat. Empty when linear. */
  W1: number[] = []
  b1: number[] = []
  /** Output layer: 3 × (hiddenSize || nFeat). */
  W: number[]
  b: number[]
  nTrain = 0
  lastLoss: number | null = null
  lr: number
  l2: number
  private data: DataItem[] = []

  constructor(keys: string[] = DEFAULT_LINEAR_HEAD_FEATURES, lr = DEFAULT_HEAD_LR, l2 = 1e-3) {
    this.keys = sanitizeHeadFeatures(keys)
    this.nFeat = this.keys.length
    this.lr = lr
    this.l2 = l2
    this.W = []
    this.b = []
    this.reset()
  }

  /** Rebuild weights if the feature set changed. Returns whether a reset happened. */
  setKeys(keys: string[]): boolean {
    const next = sanitizeHeadFeatures(keys)
    if (next.join('\0') === this.keys.join('\0')) {
      this.keys = next
      return false
    }
    this.keys = next
    this.nFeat = next.length
    this.reset()
    return true
  }

  setArch(hiddenSize: number, useRelu: boolean): boolean {
    const h = clampHiddenSize(hiddenSize)
    const relu = h > 0 && useRelu
    if (h === this.hiddenSize && relu === this.useRelu) return false
    this.hiddenSize = h
    this.useRelu = relu
    this.reset()
    return true
  }

  setLr(lr: number): void {
    if (!Number.isFinite(lr)) return
    this.lr = Math.max(0.001, Math.min(0.2, lr))
  }

  private outDim(): number {
    return this.hiddenSize > 0 ? this.hiddenSize : this.nFeat
  }

  private forward(x: number[]): { logits: number[]; h: number[]; pre: number[] } {
    if (this.hiddenSize <= 0) {
      return { logits: affine(x, this.W, this.b, this.nFeat, N_CLASS), h: x, pre: x }
    }
    const pre = affine(x, this.W1, this.b1, this.nFeat, this.hiddenSize)
    const h = this.useRelu ? pre.map((z) => Math.max(0, z)) : pre
    const logits = affine(h, this.W, this.b, this.hiddenSize, N_CLASS)
    return { logits, h, pre }
  }

  predict(x: number[]): LinearHeadPred {
    const probs = softmax(this.forward(x).logits)
    let classIndex = 0
    for (let c = 1; c < N_CLASS; c++) if (probs[c]! > probs[classIndex]!) classIndex = c
    return {
      classIndex,
      label: LINEAR_HEAD_CLASSES[classIndex]!,
      rating: LINEAR_HEAD_RATINGS[classIndex]!,
      probs,
    }
  }

  /** Append a labeled sample, then full-batch GD on all history. Returns mean CE. */
  train(x: number[], classIndex: number): number {
    const y = Math.max(0, Math.min(N_CLASS - 1, classIndex | 0))
    if (x.length !== this.nFeat) return this.batchLoss() ?? 0
    this.data.push({ x: x.slice(), y })
    if (this.data.length > DATA_CAP) this.data.shift()
    this.nTrain = this.data.length
    this.refit()
    return this.lastLoss ?? 0
  }

  /** Mean unsmoothed CE on every stored sample. */
  batchLoss(): number | null {
    if (!this.data.length) return null
    let sum = 0
    for (const s of this.data) {
      const probs = softmax(this.forward(s.x).logits)
      sum += -Math.log(Math.max(1e-8, probs[s.y]!))
    }
    return sum / this.data.length
  }

  accuracy(): number | null {
    if (!this.data.length) return null
    let ok = 0
    for (const s of this.data) {
      const pred = this.predict(s.x)
      if (pred.classIndex === s.y) ok += 1
    }
    return ok / this.data.length
  }

  /** Full-batch gradient descent on all stored labels. */
  refit(): number | null {
    if (!this.data.length) {
      this.lastLoss = null
      return null
    }
    let best = this.batchLoss() ?? Infinity
    let stall = 0
    for (let t = 0; t < REFIT_STEPS; t++) {
      this.fullBatchStep()
      const L = this.batchLoss() ?? Infinity
      if (L < best - 1e-4) {
        best = L
        stall = 0
      } else {
        stall += 1
        if (stall >= 8) break
      }
    }
    this.lastLoss = this.batchLoss()
    this.nTrain = this.data.length
    return this.lastLoss
  }

  private fullBatchStep(): void {
    const n = this.data.length
    if (!n) return
    const nIn = this.outDim()
    const dW = zeros(this.W.length)
    const db = zeros(this.b.length)
    const dW1 = zeros(this.W1.length)
    const db1 = zeros(this.b1.length)
    const off = LABEL_SMOOTH / (N_CLASS - 1)

    for (const s of this.data) {
      const { logits, h, pre } = this.forward(s.x)
      const probs = softmax(logits)
      const g = probs.map((p, c) => p - (c === s.y ? 1 - LABEL_SMOOTH : off))
      const inVec = this.hiddenSize > 0 ? h : s.x
      for (let c = 0; c < N_CLASS; c++) {
        db[c]! += g[c]!
        const row = c * nIn
        for (let k = 0; k < nIn; k++) dW[row + k]! += g[c]! * inVec[k]!
      }
      if (this.hiddenSize > 0) {
        for (let k = 0; k < this.hiddenSize; k++) {
          let dh = 0
          for (let c = 0; c < N_CLASS; c++) dh += g[c]! * this.W[c * nIn + k]!
          const dpre = this.useRelu && pre[k]! <= 0 ? 0 : dh
          db1[k]! += dpre
          const row = k * this.nFeat
          for (let j = 0; j < this.nFeat; j++) dW1[row + j]! += dpre * s.x[j]!
        }
      }
    }

    const lr = this.lr
    const l2 = this.l2
    const inv = 1 / n
    for (let i = 0; i < this.W.length; i++) this.W[i]! -= lr * (dW[i]! * inv + l2 * this.W[i]!)
    for (let i = 0; i < this.b.length; i++) this.b[i]! -= lr * db[i]! * inv
    for (let i = 0; i < this.W1.length; i++) this.W1[i]! -= lr * (dW1[i]! * inv + l2 * this.W1[i]!)
    for (let i = 0; i < this.b1.length; i++) this.b1[i]! -= lr * db1[i]! * inv
  }

  reset(): void {
    const hidScale = Math.min(0.08, Math.sqrt(2 / Math.max(1, this.nFeat)) * 0.25)
    if (this.hiddenSize > 0) {
      this.W1 = randMat(this.hiddenSize, this.nFeat, hidScale)
      this.b1 = zeros(this.hiddenSize)
    } else {
      this.W1 = []
      this.b1 = []
    }
    this.W = randMat(N_CLASS, this.outDim(), 0.02)
    this.b = zeros(N_CLASS)
    this.nTrain = 0
    this.lastLoss = null
    this.data = []
  }

  stats(): LinearHeadStats {
    return {
      nTrain: this.data.length,
      lastLoss: this.data.length ? (this.lastLoss ?? this.batchLoss()) : null,
      acc: this.accuracy(),
      hiddenSize: this.hiddenSize,
      useRelu: this.useRelu,
      arch: archLabel(this.hiddenSize, this.useRelu),
      lr: this.lr,
    }
  }

  save(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ver: 3,
        keys: this.keys,
        hiddenSize: this.hiddenSize,
        useRelu: this.useRelu,
        lr: this.lr,
        W: this.W,
        b: this.b,
        W1: this.W1,
        b1: this.b1,
        data: this.data,
      }),
    )
  }

  static load(): LinearHead {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
        ver?: number
        keys?: string[]
        hiddenSize?: number
        useRelu?: boolean
        lr?: number
        W?: number[]
        b?: number[]
        W1?: number[]
        b1?: number[]
        data?: unknown
      } | null
      const keys = sanitizeHeadFeatures(parsed?.keys ?? DEFAULT_LINEAR_HEAD_FEATURES)
      const head = new LinearHead(keys)
      const hiddenSize = clampHiddenSize(parsed?.hiddenSize ?? 0)
      const useRelu = hiddenSize > 0 && parsed?.useRelu !== false
      head.hiddenSize = hiddenSize
      head.useRelu = useRelu
      if (typeof parsed?.lr === 'number') head.setLr(parsed.lr)
      head.reset()
      const data: DataItem[] = []
      if (Array.isArray(parsed?.data)) {
        for (const row of parsed.data) {
          if (!row || typeof row !== 'object') continue
          const x = (row as DataItem).x
          const y = (row as DataItem).y
          if (!Array.isArray(x) || x.length !== head.nFeat) continue
          if (!x.every((v) => typeof v === 'number' && Number.isFinite(v))) continue
          if (typeof y !== 'number' || y < 0 || y > 2) continue
          data.push({ x: x.slice(), y: y | 0 })
        }
      }
      head.data = data
      head.nTrain = data.length
      const w1Ok =
        hiddenSize <= 0 ||
        (parsed?.W1?.length === head.W1.length && parsed.b1?.length === head.b1.length)
      const wOk =
        parsed?.ver === 3 &&
        parsed.keys?.join('\0') === keys.join('\0') &&
        parsed.W?.length === head.W.length &&
        parsed.b?.length === head.b.length &&
        w1Ok
      if (wOk && parsed.W && parsed.b) {
        head.W = parsed.W
        head.b = parsed.b
        if (hiddenSize > 0 && parsed.W1 && parsed.b1) {
          head.W1 = parsed.W1
          head.b1 = parsed.b1
        }
        head.lastLoss = head.batchLoss()
      } else if (data.length) {
        head.refit()
      }
      return head
    } catch {
      return new LinearHead()
    }
  }
}
