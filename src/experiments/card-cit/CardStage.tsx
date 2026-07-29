import type { Card } from './deck'

export function CardFace({
  card,
  highlight = false,
  dimmed = false,
  size = 'md',
}: {
  card: Card
  highlight?: boolean
  dimmed?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const dims =
    size === 'lg'
      ? 'h-36 w-24 text-2xl'
      : size === 'sm'
        ? 'h-20 w-14 text-sm'
        : 'h-28 w-20 text-lg'

  return (
    <div
      className={`relative flex flex-col justify-between rounded-xl border-2 bg-[#f7f3ea] p-2 font-semibold shadow-lg transition duration-100 ${dims}`}
      style={{
        color: card.red ? '#c62828' : '#1a1a1a',
        borderColor: highlight ? '#f5a524' : '#d5cbb8',
        boxShadow: highlight
          ? '0 0 0 3px rgba(245,165,36,0.55), 0 12px 28px rgba(0,0,0,0.35)'
          : undefined,
        opacity: dimmed ? 0.35 : 1,
        transform: highlight ? 'scale(1.06)' : undefined,
      }}
    >
      <div className="leading-none">
        <div>{card.rank}</div>
        <div>{card.suit}</div>
      </div>
      <div className="absolute inset-0 flex items-center justify-center text-3xl opacity-80">
        {card.suit}
      </div>
      <div className="rotate-180 self-end leading-none">
        <div>{card.rank}</div>
        <div>{card.suit}</div>
      </div>
    </div>
  )
}

export function CardStage({
  cards,
  highlightId,
  phase,
}: {
  cards: Card[]
  highlightId: string | null
  phase: string
}) {
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="m-0 text-base font-semibold">牌面</h2>
        <span className="chip">{phase}</span>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        {cards.map((c) => (
          <CardFace
            key={c.id}
            card={c}
            highlight={highlightId === c.id}
            dimmed={highlightId !== null && highlightId !== c.id}
          />
        ))}
      </div>
    </div>
  )
}
