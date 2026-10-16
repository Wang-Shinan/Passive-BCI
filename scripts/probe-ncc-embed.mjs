import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findNcc, findPython } from './run-model-service.mjs'

const passiveRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ncc = findNcc()
const python = findPython(ncc || passiveRoot)
const embedSrc = path.join(passiveRoot, 'embedded', 'ncc', 'src')
const args = [path.join(passiveRoot, 'scripts', 'probe-ncc-embed.py'), embedSrc]
if (ncc) args.push(path.join(ncc, 'src'))
const child = spawnSync(python, args, { stdio: 'inherit', encoding: 'utf8' })
if (child.error) {
  console.error(child.error.message)
  process.exit(1)
}
process.exit(child.status ?? 1)
