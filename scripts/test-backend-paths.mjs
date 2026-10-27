import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const script = new URL('./backend-paths.mjs', import.meta.url).href
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('runtime paths ignore external checkout variables and prefer the project interpreter', () => {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `import {projectRoot,backendRoot,findPython,backendEnv} from ${JSON.stringify(script)}; console.log(JSON.stringify({projectRoot,backendRoot,python:findPython(),env:backendEnv()}))`], {
    cwd: path.dirname(root), encoding: 'utf8', env: {...process.env, NCC_OI_BCI_ROOT: '/missing/ncc', NCC_OI_BCI_SRC: '/missing/ncc/src', PASSIVE_BCI_PYTHON: '/configured/python'}
  })
  const result = JSON.parse(stdout)
  assert.equal(result.projectRoot, root)
  assert.equal(result.python, '/configured/python')
  assert.equal(result.backendRoot, path.join(root,'embedded','ncc'))
  assert(!result.env.PYTHONPATH.includes('/missing/ncc'))
})
