export type OmniDeviceType = 'esp32' | 'stm32'

export function isOmniDeviceType(value: unknown): value is OmniDeviceType {
  return value === 'esp32' || value === 'stm32'
}

export function omniChannelCount(deviceType: OmniDeviceType): number {
  return deviceType === 'stm32' ? 32 : 8
}

export function omniEndpointStorageKey(deviceType: OmniDeviceType): string {
  return deviceType === 'esp32' ? 'passive-bci.omni-sdk-endpoint' : 'passive-bci.omni-sdk-endpoint.stm32'
}
