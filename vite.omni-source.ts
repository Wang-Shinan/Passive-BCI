import { validElectrodePositions } from './src/acquisition/omni/positions.js'
export type OmniModelSource = { endpoint: string; channelNames: string[]; electrodeNames?: string[]; electrodePositions?: number[][] }

export function parseOmniModelSource(value: unknown): OmniModelSource | null {
  if (value == null) return null
  const source = value as Partial<OmniModelSource>
  if (typeof source.endpoint !== 'string' || !source.endpoint.startsWith('ble://') || source.endpoint.length <= 6) {
    throw new Error('请先在采集调试页连接 SDK BLE 设备')
  }
  const names = source.channelNames
  if (!Array.isArray(names) || names.length !== 8 || names.some(n => typeof n !== 'string' || !n.trim()) || new Set(names.map(n => n.trim().toUpperCase())).size !== 8) {
    throw new Error('请填写 8 个不同的通道名称')
  }
  if (source.electrodePositions !== undefined) {
    if (!validElectrodePositions(source.electrodePositions)) throw new Error('请填写 8 个有效且不同的三维电极坐标')
    return { endpoint: source.endpoint, channelNames: names.map(n => n.trim()), electrodePositions: source.electrodePositions }
  }
  const electrodes = source.electrodeNames ?? names
  if (!Array.isArray(electrodes) || electrodes.length !== 8 || electrodes.some(n => typeof n !== 'string' || !n.trim() || /^CH\d+$/i.test(n.trim())) || new Set(electrodes.map(n => n.trim().toUpperCase())).size !== 8) {
    throw new Error('请先在采集调试页填写 CH1–CH8 的真实电极位置，再启动模型；波形查看和录制不受影响')
  }
  return { endpoint: source.endpoint, channelNames: names.map(n => n.trim()),
    ...(source.electrodeNames ? { electrodeNames: electrodes.map(n => n.trim()) } : {}) }
}
