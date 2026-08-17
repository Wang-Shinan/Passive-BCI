import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTEXT_SCHEMA, EVENT_SCHEMA } from './contracts'
import { SessionHub } from './sessionHub'

function eventRecord() {
  return {
    schema: EVENT_SCHEMA,
    t_ms: 1,
    perf_ms: 2,
    experiment: 'tetris',
    subjectId: 'S01',
    type: 'spawn',
    data: { piece: 'T' },
    eeg: null,
  } as const
}

function mockFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

describe('SessionHub', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not post until attached', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    const hub = new SessionHub()
    hub.logEvent(eventRecord())
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('batches events from the same tick into one POST', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    const hub = new SessionHub()
    hub.attach({ id: 'rtest0001', rel: 'recordings/demo' })
    hub.logEvent(eventRecord())
    hub.logEvent({ ...eventRecord(), type: 'lock' })
    await Promise.resolve()
    await hub.flush()
    const eventCall = fetchMock.mock.calls.find((c) => c[0].endsWith('/events'))
    expect(eventCall).toBeTruthy()
    expect(String(eventCall?.[1]?.body ?? '').trim().split('\n')).toHaveLength(2)
    hub.detach()
  })

  it('posts context after the batch threshold', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    const hub = new SessionHub()
    hub.attach({ id: 'rtest0002', rel: 'recordings/demo' })
    for (let i = 0; i < 8; i++) {
      hub.logContext({
        schema: CONTEXT_SCHEMA,
        t_ms: i,
        perf_ms: i,
        experiment: 'tetris',
        subjectId: 'S01',
        eeg: null,
        score: i,
      })
    }
    await hub.flush()
    expect(fetchMock.mock.calls.some((c) => c[0].endsWith('/context'))).toBe(true)
    hub.detach()
  })
})
