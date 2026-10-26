import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/follow_reve_tcp.py'), process.argv.slice(2))
