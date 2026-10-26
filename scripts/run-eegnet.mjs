import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/serve_eegnet_tetris.py'), process.argv.slice(2))
