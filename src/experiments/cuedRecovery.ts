import {
  subscribeGuiContinuity,
  suppressGuiSegmentReopen,
  type GuiContinuityEvent,
} from '../acquisition/omni/guiSession'

export type CuedRecoveryHooks = {
  hasActiveRun(): boolean
  inInterruptiblePhase(): boolean
  nextTrialIndex(): number
  planLength(): number
  readyToResume(): boolean
  onInterrupt?(event: Extract<GuiContinuityEvent, { type: 'interrupt' }>): void | Promise<void>
  invalidateCurrent(event: Extract<GuiContinuityEvent, { type: 'interrupt' }>): void | Promise<void>
  resumeNext(nextIndex: number): void
  completeRun(): void
  ownsReopen?(): boolean
  onStopped?(reason: string): void
  onWaitingChange?(waiting: boolean): void
}

export class CuedRecovery {
  private readonly hooks: CuedRecoveryHooks
  private unsubscribe: (() => void) | null = null
  private pendingNext: number | null = null
  private resumeArmed = false
  private cancelled = false
  private cancellation: Promise<void> = Promise.resolve()
  waiting = false

  constructor(hooks: CuedRecoveryHooks) {
    this.hooks = hooks
  }

  attach(): void {
    if (this.unsubscribe) return
    this.unsubscribe = subscribeGuiContinuity((event) => this.handleEvent(event))
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.cancel()
  }

  arm(): void {
    this.cancelled = false
    this.waiting = false
    this.pendingNext = null
    this.resumeArmed = false
    this.cancellation = Promise.resolve()
  }

  cancel(): Promise<void> {
    if (this.waiting && this.hooks.ownsReopen?.() === true) {
      this.cancellation = suppressGuiSegmentReopen()
    }
    this.cancelled = true
    this.waiting = false
    this.pendingNext = null
    this.resumeArmed = false
    this.hooks.onWaitingChange?.(false)
    return this.cancellation
  }

  handleEvent(event: GuiContinuityEvent): void | Promise<void> {
    if (event.type === 'interrupt') return this.handleInterrupt(event)
    if (event.type === 'ready') return this.handleReady()
    if (event.type === 'stopped') {
      if (this.waiting || this.hooks.hasActiveRun()) this.hooks.onStopped?.(event.reason)
      return
    }
    return
  }

  private async handleInterrupt(event: Extract<GuiContinuityEvent, { type: 'interrupt' }>): Promise<void> {
    if (this.cancelled || this.waiting || !this.hooks.hasActiveRun()) return
    this.waiting = true
    this.pendingNext = this.hooks.nextTrialIndex()
    this.hooks.onWaitingChange?.(true)
    await this.hooks.onInterrupt?.(event)
    if (!this.hooks.inInterruptiblePhase()) return
    await this.hooks.invalidateCurrent(event)
  }

  private handleReady(): void {
    if (this.cancelled || !this.waiting) return
    this.resumeArmed = true
    this.maybeResume()
  }

  maybeResume(): void {
    if (!this.resumeArmed || this.cancelled || !this.waiting) return
    if (!this.hooks.readyToResume()) return
    const next = this.pendingNext ?? this.hooks.planLength()
    this.waiting = false
    this.resumeArmed = false
    this.pendingNext = null
    this.hooks.onWaitingChange?.(false)
    if (next >= this.hooks.planLength()) this.hooks.completeRun()
    else this.hooks.resumeNext(next)
  }
}
