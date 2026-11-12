import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/train_eegnet_smr.py'), process.argv.slice(2))
