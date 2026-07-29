import type { SignalKind, SignalListener, SignalSample, SignalSource } from './types'

export interface ManualSignalOptions {
  id?: string
  kind: SignalKind
  initial?: number
}

/**
 * Human-in-the-loop signal source (Wizard-of-Oz).
 * Push values from keyboard, sliders, or rating buttons.
 */
export class ManualSignalSource implements SignalSource {
  readonly id: string
  readonly kind: SignalKind
  private sample: SignalSample | null
  private listeners = new Set<SignalListener>()

  constructor(opts: ManualSignalOptions) {
    this.id = opts.id ?? `manual-${opts.kind}`
    this.kind = opts.kind
    this.sample =
      opts.initial === undefined
        ? null
        : { value: opts.initial, t: performance.now(), kind: opts.kind }
  }

  latest(): SignalSample | null {
    return this.sample
  }

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener)
    if (this.sample) listener(this.sample)
    return () => {
      this.listeners.delete(listener)
    }
  }

  push(value: number, meta?: Record<string, unknown>): SignalSample {
    const sample: SignalSample = {
      value,
      t: performance.now(),
      kind: this.kind,
      meta,
    }
    this.sample = sample
    for (const listener of this.listeners) listener(sample)
    return sample
  }
}

/** Rating keys 1–5 → rewards used by Exp 1. */
export const RATING_MAP: Record<string, number> = {
  '1': -1,
  '2': -0.5,
  '3': 0,
  '4': 0.5,
  '5': 1,
}

export const RATING_LABELS: { key: string; value: number; label: string }[] = [
  { key: '1', value: -1, label: '很差' },
  { key: '2', value: -0.5, label: '较差' },
  { key: '3', value: 0, label: '一般' },
  { key: '4', value: 0.5, label: '较好' },
  { key: '5', value: 1, label: '很好' },
]
