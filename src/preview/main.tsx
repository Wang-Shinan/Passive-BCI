import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import App from '../App'
import Preview from './Preview'
import './preview.css'
import './theme.css'
import { ExperimentThemeBar, PreviewThemeProvider } from './Theme'

// Preserve links shared from the first preview; all experiments use App's real routes.
const previousLinks: Record<string, string> = {
  '#overview': '#/',
  '#experiments': '#/?group=experiments',
  '#smr': '#/?group=smr',
  '#acquisition': '#/acquisition',
  '#recordings': '#/recordings',
  '#training': '#/training',
}
const redirected = previousLinks[window.location.hash]
if (redirected) window.history.replaceState(null, '', `${window.location.pathname}${redirected}`)

createRoot(document.getElementById('root')!).render(<StrictMode><PreviewThemeProvider><App home={<Preview />} autoStartModels={false} pageHeader={<ExperimentThemeBar />} /></PreviewThemeProvider></StrictMode>)
