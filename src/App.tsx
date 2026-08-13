import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Home } from './Home'
import { AcquisitionDebugPage } from './acquisition'
import { RlGraphExperiment } from './experiments/rl-graph'
import { TetrisExperiment } from './experiments/tetris'
import { CardCitExperiment } from './experiments/card-cit'
import { StressRemotePage } from './experiments/tetris/StressRemotePage'
import { JumpExperiment } from './experiments/jump'
import { DrawGuessExperiment } from './experiments/draw-guess'
import { DinoExperiment } from './experiments/dino'
import { SchulteExperiment } from './experiments/schulte'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/acquisition" element={<AcquisitionDebugPage />} />
        <Route path="/rl-graph" element={<RlGraphExperiment />} />
        <Route path="/tetris" element={<TetrisExperiment />} />
        <Route path="/card-cit" element={<CardCitExperiment />} />
        <Route path="/jump" element={<JumpExperiment />} />
        <Route path="/draw-guess" element={<DrawGuessExperiment />} />
        <Route path="/dino" element={<DinoExperiment />} />
        <Route path="/schulte" element={<SchulteExperiment />} />
        <Route path="/stress-remote" element={<StressRemotePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
