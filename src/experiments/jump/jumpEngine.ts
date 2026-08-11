import { clamp, lerp, mulberry32 } from '../../lib/rng'

/**
 * Physics / scoring constants adapted from
 * https://github.com/yaoshanliang/weapp-jump (game.js BOTTLE / BLOCK / GAME / UI.addScore).
 * Linear sizes are scaled by WORLD_UNIT so the isometric canvas stays readable.
 */
export const WORLD_UNIT = 0.42

export const ISO_X = 0.8660254
export const ISO_Y = 0.5
export const WORLD_SCALE = 28

/** From weapp-jump BOTTLE + GAME. */
export const BOTTLE = {
  reduction: 0.005 * 60, // original per-frame @60fps → per second
  minScale: 0.5,
  velocityY: 135,
  velocityYIncrement: 15,
  velocityZIncrement: 70,
  vzCap: 150,
  vyCap: 180,
}

export const BLOCK = {
  radius: 5 * WORLD_UNIT,
  height: 5.5 * WORLD_UNIT * 0.55,
  minRadiusScale: 0.8,
  maxRadiusScale: 1,
  minDistance: 1 * WORLD_UNIT,
  maxDistance: 17 * WORLD_UNIT,
  minScale: 0.6,
  reduction: 0.005,
}

export const GAME_PHYS = {
  gravity: 720,
}

export type JumpStatus =
  | 'idle'
  | 'ready'
  | 'charging'
  | 'jumping'
  | 'falling'
  | 'gameover'
  | 'paused'

export type PlatformKind = 'box' | 'cylinder' | 'music' | 'gift' | 'stool'

export interface Platform {
  id: number
  x: number
  z: number
  size: number
  height: number
  color: string
  topColor: string
  kind: PlatformKind
}

export interface Piece {
  x: number
  z: number
  y: number
  squash: number
  facing: 1 | -1
  /** Fall tip: +1 overshoot, -1 undershoot. */
  tip: number
}

export interface JumpFlight {
  axisX: number
  axisZ: number
  vz: number
  vy: number
  flyingTime: number
  power: number
  landY: number
}

export interface PerfectFlash {
  x: number
  z: number
  age: number
  ring: number
}

export type JumpEvent =
  | { type: 'game_start'; data: { seed: number; stress: number } }
  | { type: 'charge_start'; data: { platformId: number } }
  | { type: 'jump'; data: { power: number; distance: number; holdMs: number; vz: number; vy: number } }
  | {
      type: 'land'
      data: {
        platformId: number
        perfect: boolean
        combo: number
        scoreDelta: number
        offset: number
        double: number
      }
    }
  | { type: 'miss'; data: { power: number; score: number; tip: number } }
  | { type: 'gameover'; data: { score: number; jumps: number; bestCombo: number } }
  | { type: 'pause' }
  | { type: 'resume' }

export interface Difficulty {
  minRadiusScale: number
  maxRadiusScale: number
  minDistance: number
  maxDistance: number
}

export interface GameState {
  status: JumpStatus
  resumeStatus: JumpStatus | null
  seed: number
  score: number
  /** Perfect streak count (doubleHit in weapp-jump). */
  combo: number
  /** Current score multiplier (1, then 2,4,6…≤32). */
  double: number
  bestCombo: number
  jumps: number
  platforms: Platform[]
  currentIndex: number
  nextDir: 0 | 1
  piece: Piece
  charge: number
  holdMs: number
  flight: JumpFlight | null
  camera: { x: number; z: number }
  cameraTarget: { x: number; z: number }
  perfectFlash: PerfectFlash | null
  elapsedS: number
  nextId: number
  difficulty: Difficulty
  succeedTime: number
}

const PLATFORM_COLORS: Array<{ body: string; top: string }> = [
  { body: '#6ec6ff', top: '#9ad9ff' },
  { body: '#ff9f7a', top: '#ffc2a8' },
  { body: '#7ad67a', top: '#a8e6a8' },
  { body: '#c9a27e', top: '#e2c9ad' },
  { body: '#b39ddb', top: '#d1c4e9' },
  { body: '#f6d365', top: '#ffe9a8' },
  { body: '#90a4ae', top: '#cfd8dc' },
  { body: '#ef9a9a', top: '#ffcdd2' },
  { body: '#81d4fa', top: '#b3e5fc' },
]

const KINDS: PlatformKind[] = ['box', 'box', 'box', 'cylinder', 'music', 'gift', 'stool']

/** Keep UI helpers used by the experiment panel. */
export const MAX_HOLD_MS = 2500
export const CHARGE_SQUASH = 1 - BOTTLE.minScale

export function worldToScreen(x: number, z: number, y = 0, camX = 0, camZ = 0) {
  const dx = x - camX
  const dz = z - camZ
  return {
    sx: (dx - dz) * ISO_X * WORLD_SCALE,
    sy: (dx + dz) * ISO_Y * WORLD_SCALE - y * WORLD_SCALE,
  }
}

export function stressGapMult(stress: number): number {
  // Easy ≈ closer pads; hard ≈ much longer jumps (was 0.95→1.18).
  return lerp(0.68, 1.72, clamp(stress / 100, 0, 1))
}

export function stressSizeMult(stress: number): number {
  // Easy ≈ large tops; hard ≈ small targets (was 1.04→0.82).
  return lerp(1.32, 0.52, clamp(stress / 100, 0, 1))
}

export function stressChargeNoise(_stress: number): number {
  // Charge noise disabled — hold time maps deterministically to vz/vy.
  return 0
}

function pickColor(rng: () => number) {
  return PLATFORM_COLORS[Math.floor(rng() * PLATFORM_COLORS.length)]!
}

function makePlatform(
  id: number,
  x: number,
  z: number,
  size: number,
  rng: () => number,
): Platform {
  const palette = pickColor(rng)
  const kind = KINDS[Math.floor(rng() * KINDS.length)]!
  return {
    id,
    x,
    z,
    size,
    height: BLOCK.height * (0.85 + rng() * 0.25),
    color: palette.body,
    topColor: palette.top,
    kind,
  }
}

function nextPlatformPose(prev: Platform, dir: 0 | 1, gap: number) {
  if (dir === 0) return { x: prev.x + gap, z: prev.z, facing: 1 as const }
  return { x: prev.x, z: prev.z + gap, facing: -1 as const }
}

function defaultDifficulty(): Difficulty {
  return {
    minRadiusScale: BLOCK.minRadiusScale,
    maxRadiusScale: BLOCK.maxRadiusScale,
    minDistance: BLOCK.minDistance,
    maxDistance: BLOCK.maxDistance,
  }
}

/** weapp-jump UI.setScore difficulty ramp. */
function rampDifficulty(diff: Difficulty): Difficulty {
  return {
    minRadiusScale: Math.max(0.25, diff.minRadiusScale - 0.005),
    maxRadiusScale: Math.max(0.6, diff.maxRadiusScale - 0.005),
    minDistance: diff.minDistance,
    maxDistance: Math.min(22 * WORLD_UNIT, diff.maxDistance + 0.03 * WORLD_UNIT),
  }
}

/**
 * weapp-jump UI.addScore(e, perfect, quick):
 * perfect → double: 1→2 then +=2, capped 32; score += e * double
 * miss streak resets double to 1.
 */
export function nextDouble(prevDouble: number, perfect: boolean): number {
  if (!perfect) return 1
  if (prevDouble === 1) return 2
  return Math.min(32, prevDouble + 2)
}

export function powerFromHold(holdMs: number): number {
  const t = clamp(holdMs / MAX_HOLD_MS, 0, 1)
  return t
}

/** Preview distance from weapp-jump release formula (scaled). */
export function jumpDistance(power: number): number {
  const holdS = power * (MAX_HOLD_MS / 1000)
  const vz = Math.min(holdS * BOTTLE.velocityZIncrement, BOTTLE.vzCap) * WORLD_UNIT
  const vy = Math.min(BOTTLE.velocityY + holdS * BOTTLE.velocityYIncrement, BOTTLE.vyCap)
  // Approximate flight time for flat landing: 2 * vy / g
  const flightT = (2 * vy) / GAME_PHYS.gravity
  return vz * flightT
}

function velocitiesFromHold(holdMs: number, noise = 0) {
  const holdS = Math.max(0, holdMs / 1000) * (1 + noise)
  const vzRaw = Math.min(holdS * BOTTLE.velocityZIncrement, BOTTLE.vzCap)
  const vyRaw = Math.min(BOTTLE.velocityY + holdS * BOTTLE.velocityYIncrement, BOTTLE.vyCap)
  return {
    vz: Number((vzRaw * WORLD_UNIT).toFixed(4)),
    vy: Number(vyRaw.toFixed(4)),
    power: powerFromHold(holdMs),
  }
}

function landOffset(pieceX: number, pieceZ: number, plat: Platform): number {
  return Math.hypot(pieceX - plat.x, pieceZ - plat.z)
}

export function isCircularPlatform(kind: PlatformKind): boolean {
  return kind === 'cylinder'
}

/**
 * weapp-jump checkHit2 perfect: distance² < 0.5 in raw coords
 * → distance < √0.5, scaled by WORLD_UNIT.
 */
export const PERFECT_HIT_DIST = Math.sqrt(0.5) * WORLD_UNIT

/** Landable half-extent / radius in xz (matches visual `size`). */
export function landHitExtent(plat: Platform): number {
  return plat.size * 0.95
}

/**
 * Landing test against platform footprint in xz.
 * Uses a circle of radius `landHitExtent` for all kinds so it matches the
 * stylized top overlay (diamond / ellipse) used in the canvas.
 */
export function isOnPlatform(pieceX: number, pieceZ: number, plat: Platform): boolean {
  return landOffset(pieceX, pieceZ, plat) <= landHitExtent(plat)
}

export function isPerfectLand(pieceX: number, pieceZ: number, plat: Platform): boolean {
  return landOffset(pieceX, pieceZ, plat) <= PERFECT_HIT_DIST
}

function spawnAhead(
  state: GameState,
  count: number,
  rng: () => number,
  stress: number,
): GameState {
  const platforms = [...state.platforms]
  let nextId = state.nextId
  let nextDir = state.nextDir
  let cursor = platforms[platforms.length - 1]!
  const { minDistance, maxDistance, minRadiusScale, maxRadiusScale } = state.difficulty

  for (let i = 0; i < count; i++) {
    const rawGap =
      minDistance + rng() * Math.max(0.01, maxDistance - minDistance)
    const radiusScale = minRadiusScale + rng() * Math.max(0, maxRadiusScale - minRadiusScale)
    const size = BLOCK.radius * radiusScale * stressSizeMult(stress)
    // Keep centers far enough that stylized tops don’t visually stack.
    const gap =
      Math.max(rawGap, cursor.size + size + 0.35 * WORLD_UNIT) * stressGapMult(stress)
    const pose = nextPlatformPose(cursor, nextDir, gap)
    const plat = makePlatform(nextId++, pose.x, pose.z, size, rng)
    platforms.push(plat)
    cursor = plat
    nextDir = (1 - nextDir) as 0 | 1
  }

  return { ...state, platforms, nextId, nextDir }
}

export function createGame(status: JumpStatus = 'idle', seed = (Math.random() * 0xffffffff) >>> 0): GameState {
  const rng = mulberry32(seed)
  const first = makePlatform(1, 0, 0, BLOCK.radius * 0.95, rng)
  const secondSize = BLOCK.radius * 0.9
  const secondGap = Math.max(
    BLOCK.minDistance + 3.2 * WORLD_UNIT,
    first.size + secondSize + 0.5 * WORLD_UNIT,
  )
  const secondPose = nextPlatformPose(first, 0, secondGap)
  const second = makePlatform(2, secondPose.x, secondPose.z, secondSize, rng)

  let state: GameState = {
    status,
    resumeStatus: null,
    seed,
    score: 0,
    combo: 0,
    double: 1,
    bestCombo: 0,
    jumps: 0,
    platforms: [first, second],
    currentIndex: 0,
    nextDir: 1,
    piece: {
      x: first.x,
      z: first.z,
      y: first.height,
      squash: 1,
      facing: 1,
      tip: 0,
    },
    charge: 0,
    holdMs: 0,
    flight: null,
    camera: { x: first.x, z: first.z },
    cameraTarget: { x: first.x, z: first.z },
    perfectFlash: null,
    elapsedS: 0,
    nextId: 3,
    difficulty: defaultDifficulty(),
    succeedTime: 0,
  }

  state = spawnAhead(state, 6, rng, 40)
  return state
}

export function beginCharge(state: GameState): { state: GameState; events: JumpEvent[] } {
  if (state.status !== 'ready') return { state, events: [] }
  const plat = state.platforms[state.currentIndex]!
  return {
    state: {
      ...state,
      status: 'charging',
      charge: 0,
      holdMs: 0,
      piece: { ...state.piece, squash: 1, tip: 0 },
    },
    events: [{ type: 'charge_start', data: { platformId: plat.id } }],
  }
}

export function releaseJump(
  state: GameState,
  _stress: number,
  _rng: () => number = Math.random,
): { state: GameState; events: JumpEvent[] } {
  if (state.status !== 'charging') return { state, events: [] }

  const { vz, vy, power } = velocitiesFromHold(state.holdMs, 0)
  const current = state.platforms[state.currentIndex]!
  const next = state.platforms[state.currentIndex + 1]
  const dir: 0 | 1 = next
    ? Math.abs(next.x - current.x) >= Math.abs(next.z - current.z)
      ? 0
      : 1
    : 0

  // Jump toward the next block axis (weapp-jump bottle.jump(direction.normalize())).
  const axisX = dir === 0 ? 1 : 0
  const axisZ = dir === 1 ? 1 : 0
  const landY = next?.height ?? current.height
  const distance = jumpDistance(power)

  const flight: JumpFlight = {
    axisX,
    axisZ,
    vz,
    vy,
    flyingTime: 0,
    power,
    landY,
  }

  return {
    state: {
      ...state,
      status: 'jumping',
      charge: power,
      flight,
      piece: {
        ...state.piece,
        squash: 1,
        facing: dir === 0 ? 1 : -1,
        tip: 0,
        y: current.height,
      },
    },
    events: [
      {
        type: 'jump',
        data: {
          power,
          distance,
          holdMs: Math.round(state.holdMs),
          vz,
          vy,
        },
      },
    ],
  }
}

function finishLanding(
  state: GameState,
  stress: number,
  rng: () => number,
  landX: number,
  landZ: number,
): { state: GameState; events: JumpEvent[] } {
  const flight = state.flight
  if (!flight) return { state, events: [] }

  const candidates = state.platforms.slice(state.currentIndex, state.currentIndex + 3)
  let hit: Platform | null = null
  let hitIndex = -1
  for (let i = 0; i < candidates.length; i++) {
    const plat = candidates[i]!
    if (isOnPlatform(landX, landZ, plat)) {
      hit = plat
      hitIndex = state.currentIndex + i
      break
    }
  }

  const nextPlat = state.platforms[state.currentIndex + 1]
  let tip = 0
  if (nextPlat) {
    const along =
      Math.abs(nextPlat.x - state.platforms[state.currentIndex]!.x) >=
      Math.abs(nextPlat.z - state.platforms[state.currentIndex]!.z)
        ? landX - nextPlat.x
        : landZ - nextPlat.z
    tip = along > 0 ? 1 : -1
  }

  if (!hit || hitIndex <= state.currentIndex) {
    return {
      state: {
        ...state,
        status: 'falling',
        flight: null,
        piece: { ...state.piece, x: landX, z: landZ, y: state.piece.y, squash: 1, tip },
      },
      events: [{ type: 'miss', data: { power: flight.power, score: state.score, tip } }],
    }
  }

  const offset = landOffset(landX, landZ, hit)
  // weapp-jump: perfect when landing distance² < 0.5 (fixed, not scaled by platform size).
  const perfect = isPerfectLand(landX, landZ, hit)
  const combo = perfect ? state.combo + 1 : 0
  const appliedDouble = perfect ? nextDouble(state.double, true) : 1
  const scoreDelta = 1 * appliedDouble
  const bestCombo = Math.max(state.bestCombo, combo)

  let next: GameState = {
    ...state,
    status: 'ready',
    score: state.score + scoreDelta,
    combo,
    double: appliedDouble,
    bestCombo,
    jumps: state.jumps + 1,
    succeedTime: state.succeedTime + 1,
    currentIndex: hitIndex,
    flight: null,
    difficulty: rampDifficulty(state.difficulty),
    piece: {
      x: hit.x,
      z: hit.z,
      y: hit.height,
      squash: 1,
      facing: state.piece.facing,
      tip: 0,
    },
    cameraTarget: { x: hit.x, z: hit.z },
    perfectFlash: perfect
      ? { x: hit.x, z: hit.z, age: 0, ring: Math.min(4, combo) }
      : null,
    charge: 0,
    holdMs: 0,
  }

  if (next.platforms.length - hitIndex < 5) {
    next = spawnAhead(next, 4, rng, stress)
  }
  if (hitIndex > 4) {
    const drop = hitIndex - 4
    next = {
      ...next,
      platforms: next.platforms.slice(drop),
      currentIndex: next.currentIndex - drop,
    }
  }

  return {
    state: next,
    events: [
      {
        type: 'land',
        data: {
          platformId: hit.id,
          perfect,
          combo,
          scoreDelta,
          offset: Number(offset.toFixed(3)),
          double: appliedDouble,
        },
      },
    ],
  }
}

export function togglePause(state: GameState): { state: GameState; events: JumpEvent[] } {
  if (state.status === 'paused') {
    return {
      state: { ...state, status: state.resumeStatus ?? 'ready', resumeStatus: null },
      events: [{ type: 'resume' }],
    }
  }
  if (state.status === 'idle' || state.status === 'gameover') return { state, events: [] }
  return {
    state: { ...state, status: 'paused', resumeStatus: state.status },
    events: [{ type: 'pause' }],
  }
}

export function stepGame(
  state: GameState,
  dtS: number,
  stress: number,
  rng: () => number = Math.random,
): { state: GameState; events: JumpEvent[] } {
  if (state.status === 'idle' || state.status === 'gameover' || state.status === 'paused') {
    return { state, events: [] }
  }

  const events: JumpEvent[] = []
  let next = { ...state, elapsedS: state.elapsedS + dtS }

  next.camera = {
    x: lerp(next.camera.x, next.cameraTarget.x, 1 - Math.exp(-dtS * 4.5)),
    z: lerp(next.camera.z, next.cameraTarget.z, 1 - Math.exp(-dtS * 4.5)),
  }

  if (next.perfectFlash) {
    const age = next.perfectFlash.age + dtS
    next.perfectFlash = age > 0.85 ? null : { ...next.perfectFlash, age }
  }

  // weapp-jump bottle._prepare: squash while charging
  if (next.status === 'charging') {
    const holdMs = Math.min(MAX_HOLD_MS, next.holdMs + dtS * 1000)
    const charge = powerFromHold(holdMs)
    const squash = Math.max(BOTTLE.minScale, 1 - charge * (1 - BOTTLE.minScale))
    const plat = next.platforms[next.currentIndex]!
    // Platform also sinks slightly (block._shrink spirit).
    next = {
      ...next,
      holdMs,
      charge,
      piece: {
        ...next.piece,
        squash,
        y: plat.height * squash,
        tip: 0,
      },
    }
  }

  // weapp-jump bottle._jump(dt)
  if (next.status === 'jumping' && next.flight) {
    const e = dtS
    const flight = { ...next.flight }
    const dz = flight.vz * e
    const dy =
      flight.vy * e -
      (GAME_PHYS.gravity / 2) * e * e -
      GAME_PHYS.gravity * flight.flyingTime * e
    flight.flyingTime += e

    const x = next.piece.x + flight.axisX * dz
    const z = next.piece.z + flight.axisZ * dz
    const y = next.piece.y + dy * WORLD_UNIT

    next = {
      ...next,
      flight,
      piece: { ...next.piece, x, z, y, squash: 1 },
    }

    const descending = flight.flyingTime > flight.vy / GAME_PHYS.gravity
    if (descending && y <= flight.landY) {
      const landed = finishLanding(next, stress, rng, x, z)
      next = {
        ...landed.state,
        piece: {
          ...landed.state.piece,
          y: landed.state.status === 'falling' ? y : landed.state.piece.y,
        },
      }
      events.push(...landed.events)
    } else if (y < -8) {
      next = {
        ...next,
        status: 'falling',
        flight: null,
        piece: { ...next.piece, tip: 1 },
      }
      events.push({ type: 'miss', data: { power: flight.power, score: next.score, tip: 1 } })
    }
  }

  if (next.status === 'falling') {
    const tip = next.piece.tip
    const y = next.piece.y - dtS * 10
    const drift = tip * dtS * 1.8
    const current = next.platforms[next.currentIndex]
    const alongX = current && next.platforms[next.currentIndex + 1]
      ? Math.abs(next.platforms[next.currentIndex + 1]!.x - current.x) >=
        Math.abs(next.platforms[next.currentIndex + 1]!.z - current.z)
      : true
    next = {
      ...next,
      piece: {
        ...next.piece,
        y,
        x: next.piece.x + (alongX ? drift : 0),
        z: next.piece.z + (alongX ? 0 : drift),
      },
    }
    if (y < -6) {
      next = { ...next, status: 'gameover' }
      events.push({
        type: 'gameover',
        data: { score: next.score, jumps: next.jumps, bestCombo: next.bestCombo },
      })
    }
  }

  return { state: next, events }
}
