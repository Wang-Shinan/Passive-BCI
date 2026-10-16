import type { Direction } from './engine'

export const KEY_DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
}
export class KeyboardInput {
  private held = new Set<string>()
  down(code: string, repeat: boolean, available: boolean): Direction | null {
    const direction = KEY_DIRECTIONS[code]
    if (!direction) return null
    const held = this.held.has(code)
    this.held.add(code) // Also remember keys pressed while sliding/paused.
    return !repeat && !held && available ? direction : null
  }
  up(code: string): void { this.held.delete(code) }
  blur(): void { this.held.clear() }
}
