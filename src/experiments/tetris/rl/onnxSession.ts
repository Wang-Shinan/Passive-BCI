/** ONNX Runtime Web session for Tetris DQN inference. */

import * as ort from 'onnxruntime-web'
import type { GameState } from '../engine'
import {
  DEFAULT_RL_METADATA_PATH,
  DEFAULT_RL_MODEL_PATH,
  RL_OBS_CHANNELS,
  RL_OBS_COLS,
  RL_OBS_ROWS,
  type RlModelMetadata,
} from './contracts'
import { encodeObservation, normalizeGravity } from './encode'
import { actionFromIndex } from './step'

export interface RlInferenceResult {
  actionIndex: number
  actionName: ReturnType<typeof actionFromIndex>
  qValues: Float32Array
  latencyMs: number
}

export class TetrisOnnxAgent {
  private session: ort.InferenceSession | null = null
  private metadata: RlModelMetadata | null = null
  private inputName = 'observation'
  private obsBuffer = new Float32Array(RL_OBS_CHANNELS * RL_OBS_ROWS * RL_OBS_COLS)

  get loaded(): boolean {
    return this.session !== null && this.metadata !== null
  }

  get modelMetadata(): RlModelMetadata | null {
    return this.metadata
  }

  async load(
    modelUrl = DEFAULT_RL_MODEL_PATH,
    metadataUrl = DEFAULT_RL_METADATA_PATH,
  ): Promise<RlModelMetadata> {
    const [metaRes, session] = await Promise.all([
      fetch(metadataUrl),
      ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      }),
    ])
    if (!metaRes.ok) {
      throw new Error(`无法加载模型元数据：${metadataUrl} (${metaRes.status})`)
    }
    this.metadata = (await metaRes.json()) as RlModelMetadata
    this.session = session
    const channels = this.metadata.obsChannels
    const rows = this.metadata.obsRows
    const cols = this.metadata.obsCols
    this.obsBuffer = new Float32Array(channels * rows * cols)
    this.inputName = session.inputNames[0] ?? 'observation'
    return this.metadata
  }

  async predict(state: GameState, gravityCellsPerSec: number): Promise<RlInferenceResult> {
    if (!this.session || !this.metadata) {
      throw new Error('模型尚未加载')
    }

    const gravityNorm = normalizeGravity(gravityCellsPerSec, this.metadata)
    encodeObservation(state, gravityNorm, this.obsBuffer)

    const t0 = performance.now()
    const input = new ort.Tensor('float32', this.obsBuffer, [
      1,
      this.metadata.obsChannels,
      this.metadata.obsRows,
      this.metadata.obsCols,
    ])
    const outputs = await this.session.run({ [this.inputName]: input })
    const qTensor = outputs[this.session.outputNames[0]!]
    if (!qTensor?.data) {
      throw new Error('ONNX 输出为空')
    }
    const qValues = qTensor.data as Float32Array
    let best = 0
    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i]! > qValues[best]!) best = i
    }
    const latencyMs = performance.now() - t0
    const actionIndex = best
    return {
      actionIndex,
      actionName: actionFromIndex(actionIndex),
      qValues: qValues.slice(),
      latencyMs,
    }
  }

  dispose(): void {
    this.session = null
    this.metadata = null
  }
}
