import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/training-job.py'), process.argv.slice(2).flatMap((arg, i) => i === 0 ? ['--job', arg] : [arg]))
