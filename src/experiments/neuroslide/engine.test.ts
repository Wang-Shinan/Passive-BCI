import { describe, expect, it } from 'vitest'
import { IceGame, slideEnd, type Level, type Direction } from './engine'
import { KeyboardInput } from './input'

const arena: Level = { id: 'test', name: 'test', difficulty: 'test', rows: [
  '#######', '#.....#', '#.....#', '#..S..#', '#.....#', '#....G#', '#######',
] }
describe('discrete ice engine', () => {
  it.each<[Direction, number, number]>([['up', 3, 1], ['down', 3, 5], ['left', 1, 3], ['right', 5, 3]])('slides %s to the last free cell', (direction, x, y) => {
    const game = new IceGame(arena)
    expect(game.command(direction, 0)).toBe(false)
    game.start(0)
    expect(game.command(direction, 0)).toBe(true)
    expect(game.state.slide?.to).toEqual({ x, y })
    game.tick(100)
    expect(game.state.position).toEqual({ x: 3, y: 3 })
    expect(game.state.slide).not.toBeNull()
    expect(game.visualPosition(100)).not.toEqual(game.state.position)
    game.tick(1000)
    expect(game.state.position).toEqual({ x, y })
    expect(game.state.moves).toBe(1)
  })
  it('crosses junctions without stopping, including a goal passed on the way', () => {
    const level = { ...arena, rows: ['#######', '###.###', '#S.G..#', '###.###', '#######'] }
    const game = new IceGame(level)
    game.start(0); game.command('right', 0); game.tick(2000)
    expect(game.state.position).toEqual({ x: 5, y: 2 })
    expect(game.state.status).toBe('running')
    expect(game.state.moves).toBe(1)
  })
  it('stops at map boundaries even without outer walls', () => {
    const level = { ...arena, rows: ['S..', '...', '..G'] }
    expect(slideEnd(level, { x: 0, y: 0 }, 'right')).toEqual({ x: 2, y: 0 })
    expect(slideEnd(level, { x: 0, y: 0 }, 'up')).toEqual({ x: 0, y: 0 })
  })
  it('counts a wall command without displacement or a pending slide', () => {
    const game = new IceGame({ ...arena, rows: ['#####', '#S.G#', '#####'] })
    game.start(0); expect(game.command('up', 0)).toBe(true)
    expect(game.state.position).toEqual({ x: 1, y: 1 })
    expect(game.state.slide).toBeNull(); expect(game.state.moves).toBe(1)
  })
  it('drops all commands during animation, never playing them later', () => {
    const game = new IceGame(arena)
    game.start(0); game.command('right', 0)
    for (const direction of ['left', 'up', 'down', 'right'] as const) expect(game.command(direction, 50)).toBe(false)
    // Even a delayed animation frame cannot let a concurrent input finish and enqueue a move.
    expect(game.command('down', 2000)).toBe(false)
    game.tick(2000); game.tick(5000)
    expect(game.state.position).toEqual({ x: 5, y: 3 }); expect(game.state.moves).toBe(1)
    expect(game.command('down', 5001)).toBe(true)
    game.tick(6000); expect(game.state.status).toBe('won')
    expect(game.command('left', 7000)).toBe(false)
    const elapsed = game.state.elapsedMs
    game.tick(20000); expect(game.state.elapsedMs).toBe(elapsed)
  })
  it('pause completes the slide without permitting a manual mid-cell stop', () => {
    const game = new IceGame(arena)
    game.start(0); game.command('right', 0); game.pause(100)
    expect(game.state.pausePending).toBe(true)
    game.tick(200)
    expect(game.state.slide).not.toBeNull(); expect(game.command('left', 200)).toBe(false)
    game.tick(1000)
    expect(game.state.position).toEqual({ x: 5, y: 3 }); expect(game.state.status).toBe('paused')
    expect(game.state.elapsedMs).toBe(410)
    game.tick(10000); expect(game.state.elapsedMs).toBe(410)
    game.start(10000); game.tick(10100); expect(game.state.elapsedMs).toBe(510)
  })
  it('restart cancels animation and resets the session before a new start', () => {
    const game = new IceGame(arena)
    game.start(0); game.command('right', 0); game.restart(); game.tick(5000)
    expect(game.state.position).toEqual({ x: 3, y: 3 }); expect(game.state.status).toBe('idle')
    expect(game.state.moves).toBe(0); expect(game.state.elapsedMs).toBe(0)
  })
})
describe('keyboard edge input', () => {
  it('long press never repeats; releasing permits a new independent same direction', () => {
    const input = new KeyboardInput()
    expect(input.down('ArrowRight', false, true)).toBe('right')
    expect(input.down('ArrowRight', true, true)).toBeNull()
    expect(input.down('ArrowRight', false, true)).toBeNull()
    input.up('ArrowRight')
    expect(input.down('ArrowRight', false, true)).toBe('right')
  })
  it('keys pressed during animation/paused/editing remain discarded until released', () => {
    const input = new KeyboardInput()
    expect(input.down('ArrowUp', false, false)).toBeNull()
    expect(input.down('ArrowUp', false, true)).toBeNull()
    expect(input.down('ArrowUp', true, true)).toBeNull()
    input.up('ArrowUp'); expect(input.down('ArrowUp', false, true)).toBe('up')
    expect(input.down('KeyW', false, true)).toBeNull()
  })
  it('focus loss does not let a held-key repeat trigger', () => {
    const input = new KeyboardInput()
    input.down('ArrowUp', false, true); input.blur()
    expect(input.down('ArrowUp', true, true)).toBeNull()
    input.up('ArrowUp'); expect(input.down('ArrowUp', false, true)).toBe('up')
  })
})
