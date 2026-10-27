import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'embedded/ncc/scripts/fit_smr_control_head.py'), ['--recordings', path.join(projectRoot, 'recordings'), '--state-file', path.join(projectRoot, 'recordings/.reve-heads/smr_control_tongue.pt'), ...process.argv.slice(2).filter(arg => arg !== '--')])
