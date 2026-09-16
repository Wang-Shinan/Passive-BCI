import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { AppErrorBoundary, installClientDiagnostics } from './lib/clientDiagnostics'

const disposeDiagnostics = installClientDiagnostics()
if (import.meta.hot) import.meta.hot.dispose(disposeDiagnostics)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
