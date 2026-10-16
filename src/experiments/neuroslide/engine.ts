export type Direction = 'up' | 'down' | 'left' | 'right'
export type Point = { x: number; y: number }
export type Level = { id: string; name: string; difficulty: string; rows: readonly string[] }
export const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right']
export const VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
}
export const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y
export function marker(level: Level, symbol: 'S' | 'G'): Point {
  for (let y = 0; y < level.rows.length; y++) {
    const x = level.rows[y]!.indexOf(symbol)
    if (x >= 0) return { x, y }
  }
  throw new Error(`Level ${level.id} is missing ${symbol}`)
}
export function validateLevel(level: Level): void {
  const width = level.rows[0]?.length ?? 0
  const text = level.rows.join('')
  if (!width || level.rows.some(row => row.length !== width || /[^#.SG]/.test(row)) ||
      [...text].filter(c => c === 'S').length !== 1 || [...text].filter(c => c === 'G').length !== 1) {
    throw new Error(`Invalid level: ${level.id}`)
  }
}
export function slideEnd(level: Level, from: Point, direction: Direction): Point {
  const delta = VECTORS[direction]
  let { x, y } = from
  while (true) {
    const next = level.rows[y + delta.y]?.[x + delta.x]
    if (next == null || next === '#') return { x, y }
    x += delta.x
    y += delta.y
  }
}

export type Slide = { from: Point; to: Point; startedAt: number; duration: number }
export type GameState = {
  position: Point; status: 'idle' | 'running' | 'paused' | 'won'; slide: Slide | null
  moves: number; elapsedMs: number; direction: Direction | null; pausePending: boolean
}

/** Only grid endpoints commit logical position. Animation never accepts commands. */
export class IceGame {
  level: Level
  state: GameState
  private lastTick = 0
  constructor(level: Level) {
    validateLevel(level)
    this.level = level
    this.state = this.initialState()
  }
  private initialState(): GameState {
    return { position: marker(this.level, 'S'), status: 'idle', slide: null,
      moves: 0, elapsedMs: 0, direction: null, pausePending: false }
  }
  get acceptsInput(): boolean { return this.state.status === 'running' && !this.state.slide && !this.state.pausePending }
  restart(level = this.level): void {
    validateLevel(level)
    this.level = level
    this.state = this.initialState()
  }
  start(now: number): void {
    if (this.state.status !== 'idle' && this.state.status !== 'paused') return
    this.lastTick = now
    this.state = { ...this.state, status: 'running', pausePending: false }
  }
  pause(now: number): void {
    this.tick(now)
    if (this.state.status !== 'running') return
    // Finish the committed slide before pausing; pause cannot shorten a move.
    this.state = this.state.slide ? { ...this.state, pausePending: true } : { ...this.state, status: 'paused' }
  }
  command(direction: Direction, now: number): boolean {
    // Check BEFORE ticking: input arriving during an animation is dropped, never queued.
    if (!this.acceptsInput || !DIRECTIONS.includes(direction)) return false
    this.tick(now)
    const from = this.state.position
    const to = slideEnd(this.level, from, direction)
    const cells = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
    this.state = { ...this.state, direction, moves: this.state.moves + 1,
      slide: cells ? { from, to, startedAt: now, duration: 220 + cells * 95 } : null }
    return true
  }
  tick(now: number): void {
    if (this.state.status !== 'running') return
    const slide = this.state.slide
    const finished = slide && now >= slide.startedAt + slide.duration
    const won = Boolean(finished && samePoint(slide.to, marker(this.level, 'G')))
    const stopTime = finished && (won || this.state.pausePending) ? slide.startedAt + slide.duration : now
    const elapsedMs = this.state.elapsedMs + Math.max(0, stopTime - this.lastTick)
    this.lastTick = Math.max(this.lastTick, now)
    this.state = { ...this.state, elapsedMs }
    if (finished) this.state = { ...this.state, position: slide.to, slide: null,
      status: won ? 'won' : this.state.pausePending ? 'paused' : 'running', pausePending: false }
  }
  visualPosition(now: number): Point {
    const slide = this.state.slide
    if (!slide) return this.state.position
    const t = Math.max(0, Math.min(1, (now - slide.startedAt) / slide.duration))
    const eased = t * t * (3 - 2 * t)
    return { x: slide.from.x + (slide.to.x - slide.from.x) * eased,
      y: slide.from.y + (slide.to.y - slide.from.y) * eased }
  }
}
