import net from 'node:net'
import { expect, it } from 'vitest'
import { isPortOpen } from './vite.model-service-manager.ts'

it('only observes real listeners during concurrent status checks', async () => {
  const listener = net.createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const port = (listener.address() as net.AddressInfo).port
  const probes = () => Promise.all(Array.from({ length: 16 }, () => isPortOpen(port)))
  try {
    expect(await probes()).toEqual(Array(16).fill(true))
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve())
    })
  }
  expect(await probes()).toEqual(Array(16).fill(false))
})
