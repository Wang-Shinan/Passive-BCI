import { useCallback, useMemo, useRef, useState } from 'react'
import {
  defaultScoreRecipe,
  loadScoreRecipe,
  recipeEnsureFeatures,
  saveScoreRecipe,
  type ExperimentId,
  type ScoreRecipe,
} from './scoreRecipe'

export function useScoreRecipe(experimentId: ExperimentId) {
  const [recipe, setRecipeState] = useState<ScoreRecipe>(() => loadScoreRecipe(experimentId))
  const idRef = useRef(experimentId)
  idRef.current = experimentId

  const setRecipe = useCallback((next: ScoreRecipe) => {
    setRecipeState(next)
    saveScoreRecipe(idRef.current, next)
  }, [])

  const resetRecipe = useCallback(() => {
    setRecipe(defaultScoreRecipe(idRef.current))
  }, [setRecipe])

  const ensureFeatures = useMemo(() => recipeEnsureFeatures(recipe), [recipe])

  return { recipe, setRecipe, resetRecipe, ensureFeatures }
}
