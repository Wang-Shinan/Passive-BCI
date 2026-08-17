import {
  applyRangeMap,
  displayValueForDriver,
  ensureIdsForDriver,
  loadRangeMap,
  resolveDriverRaw,
} from './controlMapping'

export type ExperimentId = 'rl-graph'

export type ScorePolarity = 'high' | 'low'

export type ScoreTerm = {
  featureId: string
  /** high: larger feature → higher score; low: the opposite. */
  polarity: ScorePolarity
  weight: number
}

export type ScoreRecipe = {
  terms: ScoreTerm[]
  /** invert: game difficulty = 100 − score (calm → easier). */
  toDifficulty: 'direct' | 'invert'
  /** State score in [ratingInMin, ratingInMax] → TAMER/Q [ratingOutMin, ratingOutMax]. */
  ratingInMin: number
  ratingInMax: number
  ratingOutMin: number
  ratingOutMax: number
}

const DEFAULT_RATING_BAND = {
  ratingInMin: 0,
  ratingInMax: 100,
  ratingOutMin: -1,
  ratingOutMax: 1,
} as const

function withRecipeDefaults(r: Omit<ScoreRecipe, keyof typeof DEFAULT_RATING_BAND> & Partial<ScoreRecipe>): ScoreRecipe {
  return {
    toDifficulty: r.toDifficulty,
    terms: r.terms.map((t) => ({ ...t })),
    ratingInMin: Number.isFinite(r.ratingInMin) ? r.ratingInMin! : DEFAULT_RATING_BAND.ratingInMin,
    ratingInMax: Number.isFinite(r.ratingInMax) ? r.ratingInMax! : DEFAULT_RATING_BAND.ratingInMax,
    ratingOutMin: Number.isFinite(r.ratingOutMin) ? r.ratingOutMin! : DEFAULT_RATING_BAND.ratingOutMin,
    ratingOutMax: Number.isFinite(r.ratingOutMax) ? r.ratingOutMax! : DEFAULT_RATING_BAND.ratingOutMax,
  }
}

export type RecipeTermEval = {
  featureId: string
  polarity: ScorePolarity
  weight: number
  src: number
  unit: number
  contrib: number
}

export type RecipeEval = {
  score: number
  difficulty: number
  terms: RecipeTermEval[]
}

const STORAGE_KEY = 'passive-bci.score-recipes'

const CALM: ScoreTerm[] = [
  { featureId: 'relaxation_score', polarity: 'high', weight: 1 },
  { featureId: 'focus_score', polarity: 'low', weight: 1 },
  { featureId: 'cognitive_load', polarity: 'low', weight: 1 },
]

export const DEFAULT_SCORE_RECIPES: Record<ExperimentId, ScoreRecipe> = {
  'rl-graph': withRecipeDefaults({
    terms: CALM.map((t) => ({ ...t })),
    toDifficulty: 'direct',
  }),
}

export function defaultScoreRecipe(id: ExperimentId): ScoreRecipe {
  return withRecipeDefaults(DEFAULT_SCORE_RECIPES[id])
}

function isTerm(x: unknown): x is ScoreTerm {
  if (!x || typeof x !== 'object') return false
  const t = x as ScoreTerm
  return (
    typeof t.featureId === 'string' &&
    (t.polarity === 'high' || t.polarity === 'low') &&
    typeof t.weight === 'number' &&
    Number.isFinite(t.weight)
  )
}

function isRecipe(x: unknown): x is ScoreRecipe {
  if (!x || typeof x !== 'object') return false
  const r = x as ScoreRecipe
  return (
    (r.toDifficulty === 'direct' || r.toDifficulty === 'invert') &&
    Array.isArray(r.terms) &&
    r.terms.every(isTerm)
  )
}

export function loadScoreRecipe(id: ExperimentId): ScoreRecipe {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') {
      const hit = (parsed as Record<string, unknown>)[id]
      if (isRecipe(hit) && hit.terms.length) return withRecipeDefaults(hit)
    }
  } catch {
    /* ignore */
  }
  return defaultScoreRecipe(id)
}

export function saveScoreRecipe(id: ExperimentId, recipe: ScoreRecipe): void {
  let all: Record<string, ScoreRecipe> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (parsed && typeof parsed === 'object') all = parsed as Record<string, ScoreRecipe>
  } catch {
    /* ignore */
  }
  all[id] = recipe
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export function recipeEnsureFeatures(recipe: ScoreRecipe): string[] {
  const ids = new Set<string>()
  for (const t of recipe.terms) {
    for (const id of ensureIdsForDriver(t.featureId)) ids.add(id)
  }
  return [...ids]
}

export function evaluateRecipe(
  values: Record<string, number> | undefined,
  recipe: ScoreRecipe,
): RecipeEval | null {
  if (!values || !recipe.terms.length) return null
  const terms: RecipeTermEval[] = []
  let num = 0
  let den = 0
  for (const term of recipe.terms) {
    const w = Math.max(0, term.weight)
    if (w <= 0) continue
    const raw = resolveDriverRaw(values, term.featureId)
    if (raw === undefined) continue
    const src = displayValueForDriver(term.featureId, raw)
    if (!Number.isFinite(src)) continue
    const unit = Math.max(0, Math.min(100, applyRangeMap(src, loadRangeMap(term.featureId))))
    const contrib = term.polarity === 'high' ? unit : 100 - unit
    terms.push({
      featureId: term.featureId,
      polarity: term.polarity,
      weight: w,
      src,
      unit,
      contrib,
    })
    num += w * contrib
    den += w
  }
  if (!den) return null
  const score = num / den
  const difficulty = recipe.toDifficulty === 'invert' ? 100 - score : score
  return { score, difficulty, terms }
}

/** Map state score through the recipe rating band (default 0–100 → −1…+1). */
export function scoreToRating(score: number, recipe?: Pick<ScoreRecipe, 'ratingInMin' | 'ratingInMax' | 'ratingOutMin' | 'ratingOutMax'>): number {
  const band = recipe ?? DEFAULT_RATING_BAND
  return applyRangeMap(score, {
    inMin: band.ratingInMin,
    inMax: band.ratingInMax,
    outMin: band.ratingOutMin,
    outMax: band.ratingOutMax,
  })
}
