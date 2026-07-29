import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Home } from './Home'
import { RlGraphExperiment } from './experiments/rl-graph'
import { TetrisExperiment } from './experiments/tetris'
import { CardCitExperiment } from './experiments/card-cit'
import { StressRemotePage } from './experiments/tetris/StressRemotePage'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/rl-graph" element={<RlGraphExperiment />} />
        <Route path="/tetris" element={<TetrisExperiment />} />
        <Route path="/card-cit" element={<CardCitExperiment />} />
        <Route path="/stress-remote" element={<StressRemotePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
