/**
 * Snapshot the REVE WebSocket serving slice into embedded/ncc.
 *
 * The original launcher still starts the sibling NCC checkout.
 * This tree is only used with --embed. Weights and the torch environment stay outside.
 *
 *   node scripts/vendor-ncc-serving.mjs
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findNcc } from './run-model-service.mjs'

const passiveRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const embedRoot = path.join(passiveRoot, 'embedded', 'ncc')
const embedSrc = path.join(embedRoot, 'src')

function replaceOnce(file, from, to) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  if (!text.includes(from)) throw new Error(`pattern missing in ${file}: ${from.slice(0, 80)}`)
  if (text.split(from).length !== 2) throw new Error(`pattern not unique in ${file}`)
  writeFileSync(file, text.replace(from, to))
}

function channelTuple(mappingFile) {
  const text = readFileSync(mappingFile, 'utf8')
  const match = text.match(/_SOURCE_CHANNEL_NAMES: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/)
  if (!match) throw new Error('Neuracle source channel tuple not found')
  return match[1].replace(/\r/g, '').trim()
}

function nccCommit(ncc) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ncc, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function main() {
  const ncc = findNcc()
  if (!ncc) {
    console.error('找不到 NCC-OI-BCI。請設定 NCC_OI_BCI_ROOT。')
    process.exit(1)
  }
  const nccSrc = path.join(ncc, 'src')
  const servingSrc = path.join(nccSrc, 'bci_dayloop', 'serving')
  rmSync(embedRoot, { recursive: true, force: true })
  mkdirSync(path.join(embedSrc, 'bci_dayloop', 'serving'), { recursive: true })
  mkdirSync(path.join(embedSrc, 'bci_dayloop', 'runtime'), { recursive: true })

  for (const name of readdirSync(servingSrc)) {
    if (!name.endsWith('.py')) continue
    cpSync(path.join(servingSrc, name), path.join(embedSrc, 'bci_dayloop', 'serving', name))
  }
  cpSync(path.join(nccSrc, 'bci_dayloop', '__init__.py'), path.join(embedSrc, 'bci_dayloop', '__init__.py'))
  cpSync(path.join(nccSrc, 'bci_dayloop', 'runtime', 'types.py'), path.join(embedSrc, 'bci_dayloop', 'runtime', 'types.py'))
  writeFileSync(path.join(embedSrc, 'bci_dayloop', 'runtime', '__init__.py'), '')
  cpSync(path.join(ncc, 'scripts', 'serve_reve_model.py'), path.join(embedRoot, 'serve_reve_model.py'))

  const names = channelTuple(path.join(nccSrc, 'bci_dayloop', 'realtime', 'runtime_mapping.py'))
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'profiles.py'),
    'from bci_dayloop.realtime.runtime_mapping import APPROVED_NEURACLE_59_TO_STANDARD64',
    `class _Neuracle59Source:\n    source_channel_names = (\n        ${names}\n    )\n\nAPPROVED_NEURACLE_59_TO_STANDARD64 = _Neuracle59Source()`,
  )
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'backends.py'),
    `from bci_dayloop.packages.loader import LoadedRuntimePackage
from bci_dayloop.runtime.types import RawEEGWindow
`,
    '',
  )
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'backends.py'),
    '    package: LoadedRuntimePackage',
    '    package: Any',
  )
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'backends.py'),
    '    def predict(self, window: ParsedWindow) -> PredictionResult:\n        raw = RawEEGWindow(',
    '    def predict(self, window: ParsedWindow) -> PredictionResult:\n        raise ProtocolError("runtime package backend stays on the external NCC checkout", code="internal_error", request_id=window.request_id)\n        raw = RawEEGWindow(',
  )
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'reve.py'),
    `def default_checkpoint_root() -> Path:
    return Path(__file__).resolve().parents[3] / "checkpoints" / "backbones"`,
    `def default_checkpoint_root() -> Path:
    from bci_dayloop.serving.embed_paths import checkpoint_root
    return checkpoint_root()`,
  )
  replaceOnce(
    path.join(embedSrc, 'bci_dayloop', 'serving', 'reve_lora.py'),
    `def default_adapter_root() -> Path:
    return Path(__file__).resolve().parents[3] / "checkpoints" / "adapters"`,
    `def default_adapter_root() -> Path:
    from bci_dayloop.serving.embed_paths import adapter_root
    return adapter_root()`,
  )
  replaceOnce(
    path.join(embedRoot, 'serve_reve_model.py'),
    'from _bootstrap import ROOT  # noqa: F401\n',
    `import sys
_EMBED_SRC = Path(__file__).resolve().parent / "src"
if str(_EMBED_SRC) not in sys.path:
    sys.path.insert(0, str(_EMBED_SRC))
`,
  )

  writeFileSync(path.join(embedSrc, 'bci_dayloop', 'serving', 'embed_paths.py'), `"""Weight locations for the in-tree serving slice.

Code lives in Passive-BCI. Checkpoints stay in the sibling NCC checkout,
or in REVE_CHECKPOINT_ROOT / REVE_ADAPTER_ROOT.
"""
from __future__ import annotations

import os
from pathlib import Path


def ncc_checkout() -> Path | None:
    env = os.environ.get("NCC_OI_BCI_ROOT", "").strip()
    if env and Path(env).is_dir():
        return Path(env)
    workspace = Path(__file__).resolve().parents[6]
    sibling = workspace / "NCC-OI-BCI"
    if sibling.is_dir():
        return sibling
    return None


def checkpoint_root() -> Path:
    override = os.environ.get("REVE_CHECKPOINT_ROOT", "").strip()
    if override:
        return Path(override)
    ncc = ncc_checkout()
    if ncc is not None:
        return ncc / "checkpoints" / "backbones"
    return Path(__file__).resolve().parents[3] / "checkpoints" / "backbones"


def adapter_root() -> Path:
    override = os.environ.get("REVE_ADAPTER_ROOT", "").strip()
    if override:
        return Path(override)
    ncc = ncc_checkout()
    if ncc is not None:
        return ncc / "checkpoints" / "adapters"
    return Path(__file__).resolve().parents[3] / "checkpoints" / "adapters"
`)

  const pyFiles = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.py')) pyFiles.push(full)
    }
  }
  walk(embedSrc)
  const commit = nccCommit(ncc)
  writeFileSync(path.join(embedRoot, 'SOURCE.json'), JSON.stringify({
    nccCommit: commit,
    copiedAt: new Date().toISOString(),
    files: pyFiles.map((file) => path.relative(embedRoot, file).replaceAll('\\', '/')).sort(),
    cuts: [
      'profiles.py no longer imports bci_dayloop.realtime',
      'backends.py no longer imports the runtime-package loader at module import',
      'checkpoint and adapter roots resolve outside this tree',
    ],
  }, null, 2))
  console.log(`[ncc-embed] snapshotted ${pyFiles.length} Python files from ${commit.slice(0, 12)}`)
}

main()
