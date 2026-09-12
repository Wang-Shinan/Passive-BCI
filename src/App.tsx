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
import { OnlineLearnPage } from './experiments/online-learn'
import { SmrAdaptPage } from './experiments/smr-adapt'
import { SmrUdPage } from './experiments/smr-ud'
import { TetrisAdaptPage } from './experiments/tetris-adapt'
import { RecordingsPage } from './recordings/RecordingsPage'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/acquisition" element={<AcquisitionDebugPage />} />
        <Route path="/recordings" element={<RecordingsPage />} />
        <Route path="/online-learn" element={<OnlineLearnPage />} />
        <Route path="/smr-adapt" element={<SmrAdaptPage />} />
        <Route path="/smr-ud" element={<SmrUdPage />} />
        <Route path="/tetris-adapt" element={<TetrisAdaptPage />} />
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
