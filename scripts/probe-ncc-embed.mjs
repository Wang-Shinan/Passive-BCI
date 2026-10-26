import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
runBackend(path.join(projectRoot, 'scripts/probe-ncc-embed.py'))
