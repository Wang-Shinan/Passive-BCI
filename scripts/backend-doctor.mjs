import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/backend_doctor.py'), process.argv.slice(2))
