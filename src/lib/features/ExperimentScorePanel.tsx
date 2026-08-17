import { useMemo } from 'react'
import { Panel } from '../ui/Panel'
import { ScoreRecipeEditor } from './ScoreRecipeEditor'
import { evaluateRecipe, type ScoreRecipe } from './scoreRecipe'
import type { LiveFeatureSnapshot } from './bandFeatures'

/** Sidebar: feature → score recipe. Parent owns `useScoreRecipe` so ensureFeatures stay in sync. */
export function ExperimentScorePanel({
  recipe,
  onChange,
  onReset,
  latest,
  showDifficulty = false,
}: {
  recipe: ScoreRecipe
  onChange: (next: ScoreRecipe) => void
  onReset?: () => void
  latest: LiveFeatureSnapshot | null
  showDifficulty?: boolean
}) {
  const evalResult = useMemo(
    () => evaluateRecipe(latest?.values, recipe),
    [latest, recipe],
  )
  return (
    <Panel title="特征 → 状态分">
      <ScoreRecipeEditor
        recipe={recipe}
        onChange={onChange}
        onReset={onReset}
        evalResult={evalResult}
        showDifficulty={showDifficulty}
      />
    </Panel>
  )
}
