import { mulberry32, shuffleInPlace } from '../../lib/rng'
import {
  ROWS,
  SHAPES,
  type Matrix,
  type PieceType,
} from '../tetris/engine'

/** Same row count as the 10×20 `/tetris` well; Task 2 only crops columns. */
export const MINI_ROWS = ROWS
export type MiniWidth = 5 | 7

export type CellPos = { c: number; r: number }

export type MiniPiece = {
  type: PieceType
  rot: number
  x: number
  y: number
  matrix: Matrix
}

export type MiniState = {
  width: MiniWidth
  height: number
  board: number[][]
  subject: MiniPiece
  teacher: MiniPiece
  bag: PieceType[]
}

export type Placement = {
  type: PieceType
  x: number
  y: number
  rot: number
  cells: CellPos[]
}

const BAG_ORDER: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L']

export function emptyBoard(width: number, height = MINI_ROWS): number[][] {
  return Array.from({ length: height }, () => Array(width).fill(0))
}

export function pieceMatrix(type: PieceType, rot: number): Matrix {
  const frames = SHAPES[type]
  return frames[((rot % frames.length) + frames.length) % frames.length]!
}

export function makePiece(type: PieceType, rot: number, x: number, y: number): MiniPiece {
  return { type, rot, x, y, matrix: pieceMatrix(type, rot) }
}

export function spawnX(width: number, type: PieceType, rot = 0): number {
  const matrix = pieceMatrix(type, rot)
  return Math.floor((width - matrix[0]!.length) / 2)
}

export function cellsOf(piece: { x: number; y: number; matrix: Matrix }): CellPos[] {
  const cells: CellPos[] = []
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (!piece.matrix[r]![c]) continue
      cells.push({ c: piece.x + c, r: piece.y + r })
    }
  }
  return cells
}

export function cellsMatch(a: readonly CellPos[], b: readonly CellPos[]): boolean {
  if (a.length !== b.length) return false
  const key = (pos: CellPos) => `${pos.c},${pos.r}`
  const set = new Set(a.map(key))
  return b.every((pos) => set.has(key(pos)))
}

export function collides(
  board: number[][],
  piece: MiniPiece,
  width: number,
  height: number,
  ox = 0,
  oy = 0,
): boolean {
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r]!.length; c++) {
      if (!piece.matrix[r]![c]) continue
      const x = piece.x + c + ox
      const y = piece.y + r + oy
      if (x < 0 || x >= width || y >= height) return true
      if (y >= 0 && board[y]![x]) return true
    }
  }
  return false
}

export function ghostY(
  board: number[][],
  piece: MiniPiece,
  width: number,
  height: number,
): number {
  let dy = 0
  while (!collides(board, piece, width, height, 0, dy + 1)) dy++
  return piece.y + dy
}

export function snapLanding(
  board: number[][],
  piece: MiniPiece,
  width: number,
  height: number,
): MiniPiece {
  return { ...piece, y: ghostY(board, piece, width, height) }
}

export function placementOf(
  board: number[][],
  piece: MiniPiece,
  width: number,
  height: number,
): Placement {
  const landed = snapLanding(board, piece, width, height)
  return {
    type: landed.type,
    x: landed.x,
    y: landed.y,
    rot: landed.rot,
    cells: cellsOf(landed),
  }
}

function spawnYCandidates(type: PieceType): number[] {
  return type === 'I' ? [-1, 0, -2] : [0, -1, -2]
}

export function tryPose(
  board: number[][],
  type: PieceType,
  rot: number,
  x: number,
  width: number,
  height: number,
): MiniPiece | null {
  const matrix = pieceMatrix(type, rot)
  for (const y of spawnYCandidates(type)) {
    const piece = { type, rot, x, y, matrix }
    if (!collides(board, piece, width, height)) {
      return snapLanding(board, piece, width, height)
    }
  }
  return null
}

export function legalPlacements(
  width: number,
  type: PieceType,
  board: number[][] = emptyBoard(width),
  height = MINI_ROWS,
): Placement[] {
  const rotations = type === 'O' ? 1 : 4
  const out: Placement[] = []
  const seen = new Set<string>()
  for (let rot = 0; rot < rotations; rot++) {
    for (let x = -4; x < width + 4; x++) {
      const landed = tryPose(board, type, rot, x, width, height)
      if (!landed) continue
      const cells = cellsOf(landed)
      if (cells.some((cell) => cell.c < 0 || cell.c >= width || cell.r < 0 || cell.r >= height)) {
        continue
      }
      const key = cells
        .map((cell) => `${cell.c},${cell.r}`)
        .sort()
        .join('|')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        type,
        x: landed.x,
        y: landed.y,
        rot: landed.rot,
        cells,
      })
    }
  }
  return out
}

export function placementIsLegal(
  width: number,
  placement: Placement,
  board: number[][] = emptyBoard(width),
  height = MINI_ROWS,
): boolean {
  if (placement.cells.length === 0) return false
  if (placement.cells.some((cell) => cell.c < 0 || cell.c >= width || cell.r < 0 || cell.r >= height)) {
    return false
  }
  const landed = tryPose(board, placement.type, placement.rot, placement.x, width, height)
  if (!landed) return false
  return cellsMatch(cellsOf(landed), placement.cells)
}

function refillBag(rng: () => number): PieceType[] {
  return shuffleInPlace([...BAG_ORDER], rng)
}

export function pullBag(bag: PieceType[], rng: () => number): { type: PieceType; bag: PieceType[] } {
  const next = [...bag]
  if (next.length === 0) next.push(...refillBag(rng))
  const type = next.pop()!
  if (next.length === 0) next.push(...refillBag(rng))
  return { type, bag: next }
}

/** Prefer rotations that still have a left/right choice; then lowest landing; then random. */
export function pickTeacher(
  placements: readonly Placement[],
  rng: () => number,
): Placement | null {
  if (placements.length === 0) return null
  const byRot = new Map<number, number>()
  for (const item of placements) {
    byRot.set(item.rot, (byRot.get(item.rot) ?? 0) + 1)
  }
  const movable = placements.filter((item) => (byRot.get(item.rot) ?? 0) > 1)
  const pool = movable.length > 0 ? movable : [...placements]
  const maxY = Math.max(...pool.map((item) => item.y))
  const lowest = pool.filter((item) => item.y === maxY)
  return lowest[Math.floor(rng() * lowest.length)] ?? lowest[0] ?? null
}

export function subjectStartX(
  placements: readonly Placement[],
  teacher: Placement,
  preferredX: number,
  rng: () => number,
): number {
  const sameRot = placements.filter((item) => item.rot === teacher.rot)
  const others = sameRot.filter((item) => item.x !== teacher.x)
  if (others.length === 0) return sameRot[0]?.x ?? teacher.x
  if (preferredX !== teacher.x && sameRot.some((item) => item.x === preferredX)) return preferredX
  return others[Math.floor(rng() * others.length)]!.x
}

export function spawnOverlapTrial(
  width: MiniWidth,
  rng: () => number,
  bag: PieceType[] = [],
  height = MINI_ROWS,
): MiniState {
  let nextBag = bag
  for (let attempt = 0; attempt < 16; attempt++) {
    const pulled = pullBag(nextBag, rng)
    nextBag = pulled.bag
    const board = emptyBoard(width, height)
    const placements = legalPlacements(width, pulled.type, board, height)
    const teacher = pickTeacher(placements, rng)
    if (!teacher) continue
    const preferred = spawnX(width, pulled.type, teacher.rot)
    const x = subjectStartX(placements, teacher, preferred, rng)
    const subjectLanded = tryPose(board, pulled.type, teacher.rot, x, width, height)
    if (!subjectLanded) continue
    const subjectTop = makePiece(pulled.type, teacher.rot, subjectLanded.x, 0)
    const spawnY = spawnYCandidates(pulled.type).find(
      (y) => !collides(board, { ...subjectTop, y }, width, height),
    )
    return {
      width,
      height,
      board,
      bag: nextBag,
      subject: { ...subjectTop, y: spawnY ?? 0, matrix: subjectLanded.matrix },
      teacher: makePiece(teacher.type, teacher.rot, teacher.x, teacher.y),
    }
  }
  const board = emptyBoard(width, height)
  const fallback = makePiece('O', 0, 0, height - 2)
  return {
    width,
    height,
    board,
    bag: nextBag,
    subject: { ...fallback, x: spawnX(width, 'O'), y: 0 },
    teacher: fallback,
  }
}

export function shiftSubject(state: MiniState, dx: number): MiniState | null {
  const next = makePiece(state.subject.type, state.subject.rot, state.subject.x + dx, state.subject.y)
  if (collides(state.board, next, state.width, state.height)) return null
  return { ...state, subject: next }
}

export function rotateSubject(state: MiniState): MiniState | null {
  if (state.subject.type === 'O') return state
  const to = (state.subject.rot + 1) % 4
  const kicks: [number, number][] = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [-2, 0],
    [2, 0],
  ]
  for (const [kx, ky] of kicks) {
    const next = makePiece(state.subject.type, to, state.subject.x + kx, state.subject.y + ky)
    if (!collides(state.board, next, state.width, state.height)) {
      return { ...state, subject: next }
    }
  }
  return null
}

export function subjectLanding(state: MiniState): MiniPiece {
  return snapLanding(state.board, state.subject, state.width, state.height)
}

export function overlapHit(state: MiniState): boolean {
  const red = cellsOf(subjectLanding(state))
  const green = cellsOf(state.teacher)
  return cellsMatch(red, green)
}

export function applyOverlapAction(
  state: MiniState,
  action: 'left' | 'right' | 'rotate' | 'down',
): MiniState {
  if (action === 'left') return shiftSubject(state, -1) ?? state
  if (action === 'right') return shiftSubject(state, 1) ?? state
  if (action === 'rotate') return rotateSubject(state) ?? state
  return state
}

export function poseLogFrom(piece: MiniPiece): {
  x: number
  y: number
  rot: number
  cells: CellPos[]
} {
  return { x: piece.x, y: piece.y, rot: piece.rot, cells: cellsOf(piece) }
}

export function seededRng(seed: number): () => number {
  return mulberry32(seed)
}
