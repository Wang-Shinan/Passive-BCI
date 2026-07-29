import { mulberry32, shuffleInPlace } from '../../lib/rng'

export type Suit = '♠' | '♥' | '♦' | '♣'
export type Rank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'

export interface Card {
  id: string
  rank: Rank
  suit: Suit
  label: string
  red: boolean
}

const SUITS: Suit[] = ['♠', '♥', '♦', '♣']
const RANKS: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export function fullDeck(): Card[] {
  const cards: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const red = suit === '♥' || suit === '♦'
      cards.push({
        id: `${rank}${suit}`,
        rank,
        suit,
        label: `${rank}${suit}`,
        red,
      })
    }
  }
  return cards
}

export function dealHand(n: number, seed: number): Card[] {
  const rng = mulberry32(seed)
  const deck = shuffleInPlace(fullDeck(), rng)
  return deck.slice(0, Math.max(5, Math.min(16, n)))
}
