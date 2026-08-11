import { clamp, lerp, mulberry32 } from '../../lib/rng'

export type DinoStatus = 'idle' | 'running' | 'paused' | 'gameover'

export type ObstacleKind = 'cactus-s' | 'cactus-m' | 'cactus-l' | 'bird'

export interface Obstacle {
  id: number
  x: number
  kind: ObstacleKind
  w: number
  h: number
  /** Bottom of hitbox above ground (birds fly). */
  y: number
}

export interface DinoGameState {
  status: DinoStatus
  resumeStatus: DinoStatus | null
  seed: number
  /** Horizontal run speed (px/s). */
  speed: number
  distance: number
  score: number
  bestScore: number
  /** Dino feet height above ground. */
  dinoY: number
  dinoVy: number
  ducking: boolean
  grounded: boolean
  obstacles: Obstacle[]
  groundOffset: number
  spawnCooldown: number
  frame: number
  elapsedS: number
  nextId: number
  jumps: number
  hits: number
}

export type DinoEvent =
  | { type: 'game_start'; data: { seed: number; stress: number } }
  | { type: 'jump'; data: { score: number; speed: number } }
  | { type: 'duck'; data: { on: boolean } }
  | { type: 'hit'; data: { score: number; kind: ObstacleKind; distance: number } }
  | { type: 'gameover'; data: { score: number; distance: number; jumps: number } }
  | { type: 'milestone'; data: { score: number } }

export const GROUND_Y = 150
export const DINO_X = 72
export const DINO_W = 44
export const DINO_H = 48
export const DINO_DUCK_H = 28
export const GRAVITY = 2400
export const JUMP_VY = 780
export const BASE_SPEED = 320
export const MAX_SPEED = 720

export function stressSpeedMult(stress: number): number {
  return lerp(0.82, 1.55, clamp(stress / 100, 0, 1))
}

export function stressSpawnMult(stress: number): number {
  // Lower = denser obstacles.
  return lerp(1.35, 0.62, clamp(stress / 100, 0, 1))
}

export function stressBirdChance(stress: number): number {
  return lerp(0.05, 0.28, clamp(stress / 100, 0, 1))
}

function obstacleSpecs(kind: ObstacleKind): Pick<Obstacle, 'w' | 'h' | 'y'> {
  switch (kind) {
    case 'cactus-s':
      return { w: 18, h: 36, y: 0 }
    case 'cactus-m':
      return { w: 28, h: 48, y: 0 }
    case 'cactus-l':
      return { w: 46, h: 52, y: 0 }
    case 'bird':
      return { w: 42, h: 28, y: 40 }
  }
}

function pickObstacleKind(
  score: number,
  stress: number,
  rng: () => number,
): ObstacleKind {
  const birdOk = score > 180 && rng() < stressBirdChance(stress) + Math.min(0.15, score / 4000)
  if (birdOk) return 'bird'
  const roll = rng()
  if (roll < 0.4) return 'cactus-s'
  if (roll < 0.75) return 'cactus-m'
  return 'cactus-l'
}

export function createDinoGame(
  status: DinoStatus = 'idle',
  seed = (Math.random() * 0xffffffff) >>> 0,
  bestScore = 0,
): DinoGameState {
  return {
    status,
    resumeStatus: null,
    seed,
    speed: BASE_SPEED,
    distance: 0,
    score: 0,
    bestScore,
    dinoY: 0,
    dinoVy: 0,
    ducking: false,
    grounded: true,
    obstacles: [],
    groundOffset: 0,
    spawnCooldown: 1.2,
    frame: 0,
    elapsedS: 0,
    nextId: 1,
    jumps: 0,
    hits: 0,
  }
}

export function startDinoRun(
  state: DinoGameState,
  stress: number,
): { state: DinoGameState; events: DinoEvent[] } {
  const seed = (Math.random() * 0xffffffff) >>> 0
  const next = createDinoGame('running', seed, state.bestScore)
  next.speed = BASE_SPEED * stressSpeedMult(stress)
  return {
    state: next,
    events: [{ type: 'game_start', data: { seed, stress } }],
  }
}

export function jumpDino(state: DinoGameState): { state: DinoGameState; events: DinoEvent[] } {
  if (state.status !== 'running' || !state.grounded || state.ducking) {
    return { state, events: [] }
  }
  return {
    state: {
      ...state,
      grounded: false,
      dinoVy: JUMP_VY,
      jumps: state.jumps + 1,
    },
    events: [{ type: 'jump', data: { score: state.score, speed: state.speed } }],
  }
}

export function setDucking(
  state: DinoGameState,
  ducking: boolean,
): { state: DinoGameState; events: DinoEvent[] } {
  if (state.status !== 'running') return { state, events: [] }
  if (state.ducking === ducking) return { state, events: [] }
  const nextDuck = ducking && state.grounded
  return {
    state: { ...state, ducking: nextDuck },
    events: [{ type: 'duck', data: { on: nextDuck } }],
  }
}

export function toggleDinoPause(state: DinoGameState): DinoGameState {
  if (state.status === 'running') {
    return { ...state, status: 'paused', resumeStatus: 'running' }
  }
  if (state.status === 'paused' && state.resumeStatus) {
    return { ...state, status: state.resumeStatus, resumeStatus: null }
  }
  return state
}

function hitboxes(state: DinoGameState): { dx: number; dy: number; dw: number; dh: number } {
  const h = state.ducking ? DINO_DUCK_H : DINO_H
  const inset = 6
  return {
    dx: DINO_X + inset,
    dy: state.dinoY + inset,
    dw: DINO_W - inset * 2,
    dh: h - inset * 2,
  }
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
}

function spawnObstacle(
  state: DinoGameState,
  canvasW: number,
  stress: number,
  rng: () => number,
): DinoGameState {
  const kind = pickObstacleKind(state.score, stress, rng)
  let spec = obstacleSpecs(kind)
  if (kind === 'bird') {
    const tiers = [18, 40, 62]
    spec = { ...spec, y: tiers[Math.floor(rng() * tiers.length)]! }
  }
  const gap = (220 + rng() * 180) * stressSpawnMult(stress)
  const last = state.obstacles[state.obstacles.length - 1]
  const x = Math.max(canvasW + 40, (last?.x ?? canvasW) + gap)
  const obs: Obstacle = {
    id: state.nextId,
    x,
    kind,
    ...spec,
  }
  return {
    ...state,
    nextId: state.nextId + 1,
    obstacles: [...state.obstacles, obs],
    spawnCooldown: gap / Math.max(120, state.speed),
  }
}

export function stepDino(
  state: DinoGameState,
  dtS: number,
  stress: number,
  canvasW: number,
  rng: () => number = Math.random,
): { state: DinoGameState; events: DinoEvent[] } {
  if (state.status !== 'running') return { state, events: [] }

  const events: DinoEvent[] = []
  let next: DinoGameState = {
    ...state,
    elapsedS: state.elapsedS + dtS,
    frame: state.frame + 1,
    obstacles: state.obstacles.map((o) => ({ ...o })),
  }

  const targetSpeed = Math.min(
    MAX_SPEED,
    (BASE_SPEED + next.distance * 0.012) * stressSpeedMult(stress),
  )
  next.speed = lerp(next.speed, targetSpeed, 1 - Math.exp(-dtS * 2.5))

  const move = next.speed * dtS
  next.distance += move
  next.groundOffset = (next.groundOffset + move) % 24
  const score = Math.floor(next.distance / 10)
  if (score !== next.score && score > 0 && score % 100 === 0) {
    events.push({ type: 'milestone', data: { score } })
  }
  next.score = score

  if (!next.grounded) {
    next.dinoVy -= GRAVITY * dtS
    next.dinoY += next.dinoVy * dtS
    if (next.dinoY <= 0) {
      next.dinoY = 0
      next.dinoVy = 0
      next.grounded = true
    }
  }

  next.obstacles = next.obstacles
    .map((o) => ({ ...o, x: o.x - move }))
    .filter((o) => o.x + o.w > -40)

  next.spawnCooldown -= dtS
  if (next.spawnCooldown <= 0 || next.obstacles.length === 0) {
    next = spawnObstacle(next, canvasW, stress, rng)
  }

  const hb = hitboxes(next)
  for (const o of next.obstacles) {
    const ox = o.x + 4
    const oy = o.y + 2
    const ow = o.w - 8
    const oh = o.h - 4
    if (overlaps(hb.dx, hb.dy, hb.dw, hb.dh, ox, oy, ow, oh)) {
      events.push({
        type: 'hit',
        data: { score: next.score, kind: o.kind, distance: next.distance },
      })
      events.push({
        type: 'gameover',
        data: { score: next.score, distance: next.distance, jumps: next.jumps },
      })
      return {
        state: {
          ...next,
          status: 'gameover',
          hits: next.hits + 1,
          bestScore: Math.max(next.bestScore, next.score),
          ducking: false,
        },
        events,
      }
    }
  }

  return { state: next, events }
}

export function makeDinoRng(seed: number): () => number {
  return mulberry32(seed ^ 0xc0ffee)
}
