import { CONTROL_SIGNAL_OPTIONS } from './controlMapping'
import { scoreToRating, type RecipeEval, type ScorePolarity, type ScoreRecipe, type ScoreTerm } from './scoreRecipe'

const FEATURE_OPTS = CONTROL_SIGNAL_OPTIONS.filter((o) => o.tier !== 'demo')

function featureLabel(id: string): string {
  return FEATURE_OPTS.find((o) => o.id === id)?.label ?? id
}

export function ScoreRecipeEditor({
  recipe,
  onChange,
  onReset,
  evalResult,
  showDifficulty = false,
}: {
  recipe: ScoreRecipe
  onChange: (next: ScoreRecipe) => void
  onReset?: () => void
  evalResult?: RecipeEval | null
  showDifficulty?: boolean
}) {
  const patchTerm = (i: number, partial: Partial<ScoreTerm>) => {
    onChange({
      ...recipe,
      terms: recipe.terms.map((t, j) => (j === i ? { ...t, ...partial } : t)),
    })
  }
  const removeTerm = (i: number) => {
    onChange({ ...recipe, terms: recipe.terms.filter((_, j) => j !== i) })
  }
  const addTerm = () => {
    const used = new Set(recipe.terms.map((t) => t.featureId))
    const next = FEATURE_OPTS.find((o) => !used.has(o.id))
    if (!next) return
    onChange({
      ...recipe,
      terms: [...recipe.terms, { featureId: next.id, polarity: 'high', weight: 1 }],
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="muted text-xs">状态分配方</span>
        {evalResult ? (
          <span className="font-mono text-sm">
            {evalResult.score.toFixed(1)}
            {showDifficulty ? (
              <span className="muted">
                {' '}
                → 难度 {evalResult.difficulty.toFixed(1)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="muted text-xs">等待特征</span>
        )}
      </div>
      <p className="muted mb-0 text-[11px] leading-relaxed">
        加权平均。高 = 该特征越大分越高；低 = 越小分越高。各特征仍走自己的区间映射。
      </p>
      {recipe.terms.map((term, i) => {
        const ev = evalResult?.terms.find((t) => t.featureId === term.featureId)
        return (
          <div key={`${term.featureId}-${i}`} className="rounded-md border border-[#2a3550] p-2">
            <div className="flex items-center gap-1.5">
              <select
                className="min-w-0 flex-1 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 text-xs"
                value={term.featureId}
                onChange={(e) => patchTerm(i, { featureId: e.target.value })}
              >
                {FEATURE_OPTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`btn px-2 py-1 text-[11px] ${term.polarity === 'high' ? 'btn-primary' : ''}`}
                onClick={() =>
                  patchTerm(i, { polarity: (term.polarity === 'high' ? 'low' : 'high') as ScorePolarity })
                }
              >
                {term.polarity === 'high' ? '高' : '低'}
              </button>
              <input
                type="number"
                className="w-14 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 font-mono text-xs"
                min={0}
                step={0.1}
                value={term.weight}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) patchTerm(i, { weight: n })
                }}
                title="权重"
              />
              <button type="button" className="btn px-2 py-1 text-xs" onClick={() => removeTerm(i)}>
                ×
              </button>
            </div>
            {ev ? (
              <p className="muted mb-0 mt-1 font-mono text-[11px]">
                {featureLabel(term.featureId)} {ev.src.toFixed(1)} → {ev.contrib.toFixed(1)}
                {term.polarity === 'low' ? '（取反）' : ''}
              </p>
            ) : null}
          </div>
        )
      })}
      <div className="flex gap-1.5">
        <button type="button" className="btn flex-1 text-xs" onClick={addTerm}>
          加特征
        </button>
        {onReset ? (
          <button type="button" className="btn flex-1 text-xs" onClick={onReset}>
            本实验默认
          </button>
        ) : null}
      </div>
      <div className="rounded-md border border-[#2a3550] p-2">
        <div className="muted mb-1.5 text-[11px]">状态分 → 奖励</div>
        <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-1.5 gap-y-1 text-xs">
          <span className="muted">分</span>
          <input
            type="number"
            className="w-full min-w-0 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 font-mono text-xs"
            step={1}
            value={recipe.ratingInMin}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...recipe, ratingInMin: n })
            }}
          />
          <span className="muted text-center">–</span>
          <input
            type="number"
            className="w-full min-w-0 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 font-mono text-xs"
            step={1}
            value={recipe.ratingInMax}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...recipe, ratingInMax: n })
            }}
          />
          <span className="muted">奖</span>
          <input
            type="number"
            className="w-full min-w-0 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 font-mono text-xs"
            step={0.1}
            value={recipe.ratingOutMin}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...recipe, ratingOutMin: n })
            }}
          />
          <span className="muted text-center">–</span>
          <input
            type="number"
            className="w-full min-w-0 rounded-md border border-[#2a3550] bg-[#0d1425] px-1 py-1 font-mono text-xs"
            step={0.1}
            value={recipe.ratingOutMax}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange({ ...recipe, ratingOutMax: n })
            }}
          />
        </div>
        {evalResult ? (
          <p className="muted mb-0 mt-1.5 font-mono text-[11px]">
            {evalResult.score.toFixed(1)} →{' '}
            {(() => {
              const y = scoreToRating(evalResult.score, recipe)
              return `${y >= 0 ? '+' : ''}${y.toFixed(2)}`
            })()}
          </p>
        ) : null}
      </div>
      {showDifficulty ? (
        <label className="muted flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={recipe.toDifficulty === 'invert'}
            onChange={(e) =>
              onChange({ ...recipe, toDifficulty: e.target.checked ? 'invert' : 'direct' })
            }
          />
          难度 = 100 − 状态分（放松高 → 更容易）
        </label>
      ) : null}
    </div>
  )
}
