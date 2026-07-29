import { StressPanel } from './StressPanel'
import { useStressChannel } from './useStressChannel'

export function StressRemotePage() {
  const { stress, setStress } = useStressChannel(40)
  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-4 text-xl font-semibold">压力遥控面板</h1>
      <StressPanel stress={stress} onChange={setStress} compact />
    </div>
  )
}
