import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'embedded/ncc/scripts/fit_gaze_smr_head.py'), process.argv.slice(2))
