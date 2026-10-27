import path from 'node:path'
import { projectRoot, runBackend } from './backend-paths.mjs'
const scripts = { neuracle: 'bridges/neuracle/ws_bridge.py', bcigo: 'bridges/bcigo/ws_bridge.py', omni: 'bridges/omni/lsl_ws_bridge.py', 'omni-sdk': 'bridges/omni/sdk_ws_bridge.py' }
const script = scripts[process.argv[2]]
if (!script) throw new Error('Choose neuracle, bcigo, omni or omni-sdk')
runBackend(path.join(projectRoot, script), process.argv.slice(3))
