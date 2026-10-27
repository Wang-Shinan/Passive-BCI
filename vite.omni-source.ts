import { validElectrodePositions } from './src/acquisition/omni/positions.js'
import { isOmniDeviceType, omniChannelCount, type OmniDeviceType } from './src/acquisition/omni/device.js'
export type OmniModelSource = { endpoint: string; deviceType?: OmniDeviceType; channelNames: string[]; electrodeNames?: string[]; electrodePositions?: number[][] }

export function parseOmniModelSource(value: unknown): OmniModelSource | null {
  if (value == null) return null
  const source = value as Partial<OmniModelSource>
  const deviceType = source.deviceType ?? 'esp32'
  if (!isOmniDeviceType(deviceType)) throw new Error('Omni 设备类型必须是 ESP32 或 STM32')
  const count = omniChannelCount(deviceType)
  const device = source.deviceType === undefined ? {} : { deviceType }
  if (typeof source.endpoint !== 'string' || !source.endpoint.startsWith('ble://') || source.endpoint.length <= 6) {
    throw new Error('请先在采集调试页连接 SDK BLE 设备')
  }
  const names = source.channelNames
  if (!Array.isArray(names) || names.length !== count || names.some(n => typeof n !== 'string' || !n.trim()) || new Set(names.map(n => n.trim().toUpperCase())).size !== count) {
    throw new Error(`请填写 ${count} 个不同的通道名称`)
  }
  if (source.electrodePositions !== undefined) {
    if (!validElectrodePositions(source.electrodePositions, count)) throw new Error(`请填写 ${count} 个有效且不同的三维电极坐标`)
    return { ...device, endpoint: source.endpoint, channelNames: names.map(n => n.trim()), electrodePositions: source.electrodePositions }
  }
  const electrodes = source.electrodeNames ?? names
  if (!Array.isArray(electrodes) || electrodes.length !== count || electrodes.some(n => typeof n !== 'string' || !n.trim() || /^CH\d+$/i.test(n.trim())) || new Set(electrodes.map(n => n.trim().toUpperCase())).size !== count) {
    throw new Error(`请先在采集调试页填写 CH1–CH${count} 的真实电极位置，再启动模型；波形查看和录制不受影响`)
  }
  return { ...device, endpoint: source.endpoint, channelNames: names.map(n => n.trim()),
    ...(source.electrodeNames ? { electrodeNames: electrodes.map(n => n.trim()) } : {}) }
}
