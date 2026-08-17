import { describe, expect, it } from 'vitest'
import { COLS, ROWS } from './engine'
import { boardFeatures, columnHeights } from './boardFeatures'

function emptyBoard(): number[][] {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0))
}

describe('boardFeatures', () => {
  it('is zero on an empty board', () => {
    const feat = boardFeatures(emptyBoard())
    expect(feat).toEqual({
      holes: 0,
      aggregateHeight: 0,
      bumpiness: 0,
      maxHeight: 0,
      wells: 0,
    })
  })

  it('counts holes under a stack and column height from the top block', () => {
    const board = emptyBoard()
    board[17]![0] = 1
    board[18]![0] = 1
    board[19]![0] = 0
    expect(columnHeights(board)[0]).toBe(3)
    expect(boardFeatures(board).holes).toBe(1)
    expect(boardFeatures(board).maxHeight).toBe(3)
    expect(boardFeatures(board).aggregateHeight).toBe(3)
  })

  it('measures bumpiness and wells between neighboring columns', () => {
    const board = emptyBoard()
    for (let r = 15; r < ROWS; r++) {
      board[r]![0] = 1
      board[r]![2] = 1
    }
    board[19]![1] = 1
    const feat = boardFeatures(board)
    expect(feat.maxHeight).toBe(5)
    expect(feat.wells).toBe(4)
    expect(feat.bumpiness).toBe(13)
  })
})
