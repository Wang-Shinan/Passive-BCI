import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'embedded/ncc/scripts/export_smr_control_hdf5.py'), ['--recordings', path.join(projectRoot, 'recordings'), ...process.argv.slice(2).filter(arg => arg !== '--')])
