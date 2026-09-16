import { expect, it } from 'vitest'
import { SessionLogger } from './logger'

it('bounds event memory even when no recording is attached', () => {
  const logger = new SessionLogger('tetris')
  for (let i = 0; i < 100000; i++) logger.log('action', { i })
  expect(logger.getEvents()).toHaveLength(2000)
  expect(logger.getEvents()[0]!.data!.i).toBe(98000)
  expect(logger.getEvents()[1999]!.data!.i).toBe(99999)
})
