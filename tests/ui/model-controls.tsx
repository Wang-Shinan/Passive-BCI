// Test-only entry point: production build does not include this fixture.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import { TetrisExperiment } from '../../src/experiments/tetris'
import { sessionHub } from '../../src/lib/session/sessionHub'
import { ensureModelService } from '../../src/lib/model-runtime/modelServiceApi'
import '../../src/styles.css'
function Fixture() {
  const [error, setError] = useState('')
  return <MemoryRouter>
    <button onClick={() => sessionHub.attach({id:'ui-fixture-session',rel:'recordings/ui-fixture'})}>Fixture record</button>
    <button onClick={() => sessionHub.detach()}>Fixture finish</button>
    <button onClick={() => void ensureModelService({task:'gaze_smr'}).catch(e => setError(String(e)))}>Fixture direct launch</button>
    <output data-testid="direct-error">{error}</output>
    <TetrisExperiment />
  </MemoryRouter>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
