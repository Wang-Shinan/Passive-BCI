import type { ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Home } from './Home'
import { TrainingPage } from './training'
import { AcquisitionDebugPage } from './acquisition'
import { RlGraphExperiment } from './experiments/rl-graph'
import { TetrisExperiment } from './experiments/tetris'
import { CardCitExperiment } from './experiments/card-cit'
import { StressRemotePage } from './experiments/tetris/StressRemotePage'
import { JumpExperiment } from './experiments/jump'
import { DrawGuessExperiment } from './experiments/draw-guess'
import { DinoExperiment } from './experiments/dino'
import { SchulteExperiment } from './experiments/schulte'
import { NBackExperiment } from './experiments/nback'
import { OnlineLearnPage } from './experiments/online-learn'
import { SmrPage } from './experiments/smr'
import { SmrUdPage } from './experiments/smr-ud'
import { GazeTetrisPage } from './experiments/smr-gaze/GazeTetris'
import { TetrisAdaptPage } from './experiments/tetris-adapt'
import { RecordingsPage } from './recordings/RecordingsPage'

export default function App({ home, autoStartModels = true, pageHeader }: { home?: ReactNode; autoStartModels?: boolean; pageHeader?: ReactNode } = {}) {
  return (
    <HashRouter>
      {pageHeader}
      <Routes>
        <Route path="/" element={home ?? <Home />} />
        <Route path="/training" element={<TrainingPage />} />
        <Route path="/acquisition" element={<AcquisitionDebugPage />} />
        <Route path="/recordings" element={<RecordingsPage />} />
        <Route path="/online-learn" element={<OnlineLearnPage />} />
        <Route path="/smr" element={<SmrPage autoStartModel={autoStartModels} />} />
        <Route path="/smr-adapt" element={<Navigate to="/smr?mode=smr" replace />} />
        <Route path="/smr-ud" element={<SmrUdPage autoStartModel={autoStartModels} />} />
        <Route path="/smr-gaze" element={<Navigate to="/smr?mode=gaze" replace />} />
        <Route path="/gaze-smr-tetris" element={<GazeTetrisPage key="smr" />} />
        <Route path="/gaze-tetris" element={<GazeTetrisPage key="eye" eyeOnly />} />
        <Route path="/tetris-adapt" element={<TetrisAdaptPage autoStartModel={autoStartModels} />} />
        <Route path="/rl-graph" element={<RlGraphExperiment />} />
        <Route path="/tetris" element={<TetrisExperiment />} />
        <Route path="/card-cit" element={<CardCitExperiment />} />
        <Route path="/jump" element={<JumpExperiment />} />
        <Route path="/draw-guess" element={<DrawGuessExperiment />} />
        <Route path="/dino" element={<DinoExperiment />} />
        <Route path="/schulte" element={<SchulteExperiment />} />
        <Route path="/nback" element={<NBackExperiment />} />
        <Route path="/stress-remote" element={<StressRemotePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
