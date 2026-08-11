import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Panel } from '../lib/ui/Panel'
import { Slider } from '../lib/ui/Slider'
import { DEFAULT_BAND_SOS, DEFAULT_NOTCH_SOS, LiveIirFilter } from './filter/iir'
import {
  NEURACLE_59_EEG_CHANNEL_NAMES,
  NeuracleWsClient,
  type NeuracleHello,
} from './neuracle/client'
import {
  CMD_START,
  CMD_STOP,
  cmdBulkConfig,
  cmdMode,
  cmdReference,
} from './protocol/commands'
import {
  BAUD,
  CHANNEL_NAMES,
  CHANNELS,
  FS,
  MODE_ITEMS,
  MODE_NAMES,
  MONTAGE_PRESETS,
  NEURACLE_DEFAULT_VISIBLE,
  REFERENCE_SRB1,
  REFERENCE_SRB2,
  VALID_GAINS,
  channelLsbUv,
  defaultChannelConfig,
  type ChannelConfig,
  type ReferenceMode,
} from './protocol/constants'
import { AdsFrameParser } from './protocol/frameParser'
import { BinRecorder } from './session/recorder'
import { WebSerialTransport, webSerialSupported } from './transport/webSerial'
import { CHANNEL_COLORS, WaveformCanvas } from './WaveformCanvas'
import { FeaturePanel } from './FeaturePanel'
import {
  computeLiveFeatures,
  loadEnabledFeatures,
  saveEnabledFeatures,
  type LiveFeatureSnapshot,
} from '../lib/features'

const RING_SECONDS = 12
const FEATURE_HISTORY = 60
const FEATURE_WINDOW_SEC = 1.0
const CFG_STORAGE_KEY = 'passive-bci.acquisition.channel-config'
const DEVICE_STORAGE_KEY = 'passive-bci.acquisition.device'

type DeviceKind = 'omni' | 'neuracle'
type ConnUi = 'idle' | 'connecting' | 'open' | 'streaming' | 'error' | 'unsupported' | 'demo'

function makeRing(nChannels: number, capacity: number): Float32Array[] {
  return Array.from({ length: nChannels }, () => new Float32Array(capacity))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function neuracleWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8766/v1/stream'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  // Prefer Vite proxy when running through the dev server.
  if (window.location.port && window.location.port !== '8766') {
    return `${proto}//${window.location.host}/ws/neuracle`
  }
  return 'ws://127.0.0.1:8766/v1/stream'
}

function loadSavedConfig(): ChannelConfig {
  const base = defaultChannelConfig()
  try {
    const raw = localStorage.getItem(CFG_STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<ChannelConfig>
    const labels = Array.isArray(parsed.labels)
      ? Array.from({ length: CHANNELS }, (_, i) =>
          String(parsed.labels?.[i] ?? CHANNEL_NAMES[i]).trim() || CHANNEL_NAMES[i]!,
        )
      : base.labels
    return {
      enabled: Array.from({ length: CHANNELS }, (_, i) => Boolean(parsed.enabled?.[i] ?? true)),
      bias: Array.from({ length: CHANNELS }, (_, i) => Boolean(parsed.bias?.[i] ?? i < 5)),
      srb2: Array.from({ length: CHANNELS }, (_, i) => Boolean(parsed.srb2?.[i] ?? true)),
      gains: Array.from({ length: CHANNELS }, (_, i) => {
        const g = Number(parsed.gains?.[i] ?? 24)
        return (VALID_GAINS as readonly number[]).includes(g) ? g : 24
      }),
      labels,
      reference:
        Number(parsed.reference) === REFERENCE_SRB2 ? REFERENCE_SRB2 : REFERENCE_SRB1,
    }
  } catch {
    return base
  }
}

function saveConfig(cfg: ChannelConfig): void {
  try {
    localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* ignore quota */
  }
}

export function AcquisitionDebugPage() {
  const capacity = Math.ceil(RING_SECONDS * FS)
  const supported = webSerialSupported()

  const [device, setDevice] = useState<DeviceKind>(() => {
    try {
      const v = localStorage.getItem(DEVICE_STORAGE_KEY)
      return v === 'neuracle' ? 'neuracle' : 'omni'
    } catch {
      return 'omni'
    }
  })
  const [status, setStatus] = useState<ConnUi>(() =>
    device === 'omni' ? (supported ? 'idle' : 'unsupported') : 'idle',
  )
  const [detail, setDetail] = useState(
    device === 'neuracle'
      ? '连接本机 JellyFish 转发（需先 npm run neuracle-bridge）。协议来自 oi-mi / 博睿康。'
      : supported
        ? '通过 Web Serial 直连 ADS1299（OmniBCI 固件）。'
        : '当前浏览器不支持 Web Serial，请使用 Chrome / Edge。',
  )
  const [cfg, setCfg] = useState<ChannelConfig>(() => loadSavedConfig())
  const [montageId, setMontageId] = useState('custom')
  const [eegMode, setEegMode] = useState(1)
  const [viewFiltered, setViewFiltered] = useState(true)
  const [useNotch, setUseNotch] = useState(true)
  const [yScaleUv, setYScaleUv] = useState(100)
  const [windowSec, setWindowSec] = useState(4)
  const [nChannels, setNChannels] = useState(CHANNELS)
  const [streamLabels, setStreamLabels] = useState<string[]>(() => [...loadSavedConfig().labels])
  const [streamTypes, setStreamTypes] = useState<string[]>([])
  const [visible, setVisible] = useState(() => Array.from({ length: CHANNELS }, () => true))
  const [sampleRate, setSampleRate] = useState(FS)
  const [jfHost, setJfHost] = useState('127.0.0.1')
  const [jfPort, setJfPort] = useState(8712)
  const [neuracleMontage, setNeuracleMontage] = useState<'all' | '59' | 'motor8'>('all')
  const [recording, setRecording] = useState(false)
  const [recBytes, setRecBytes] = useState(0)
  const [featureLatest, setFeatureLatest] = useState<LiveFeatureSnapshot | null>(null)
  const [featureHistory, setFeatureHistory] = useState<LiveFeatureSnapshot[]>([])
  const [enabledFeatures, setEnabledFeatures] = useState<string[]>(() => loadEnabledFeatures())
  const [stats, setStats] = useState({
    samples: 0,
    rateHz: 0,
    crcBad: 0,
    syncDrop: 0,
    invalid: 0,
    seqGaps: 0,
    lastSeq: null as number | null,
    mode: 0,
    queueDepth: 0,
    packetLoss: 0,
    packetCount: 0,
  })
  const [, setTick] = useState(0)

  const transportRef = useRef(new WebSerialTransport())
  const neuracleRef = useRef<NeuracleWsClient | null>(null)
  const parserRef = useRef<AdsFrameParser | null>(null)
  const filterRef = useRef(new LiveIirFilter(CHANNELS))
  const recorderRef = useRef(new BinRecorder())
  const rawRingRef = useRef(makeRing(CHANNELS, capacity))
  const filtRingRef = useRef(makeRing(CHANNELS, capacity))
  const writeHeadRef = useRef(0)
  const filledRef = useRef(0)
  const nChRef = useRef(CHANNELS)
  const lsbRef = useRef(channelLsbUv(loadSavedConfig().gains))
  const lastSeqRef = useRef<number | null>(null)
  const rateWinRef = useRef({ t0: performance.now(), n: 0, samplesBase: 0 })
  const demoTimerRef = useRef<number | null>(null)
  const streamingRef = useRef(false)
  const viewFilteredRef = useRef(viewFiltered)
  const eegModeRef = useRef(eegMode)
  viewFilteredRef.current = viewFiltered
  eegModeRef.current = eegMode
  nChRef.current = nChannels

  const resizeBuffers = useCallback(
    (n: number) => {
      nChRef.current = n
      setNChannels(n)
      filterRef.current.setChannelCount(n)
      filterRef.current.reset()
      rawRingRef.current = makeRing(n, capacity)
      filtRingRef.current = makeRing(n, capacity)
      writeHeadRef.current = 0
      filledRef.current = 0
    },
    [capacity],
  )

  const getSnapshot = useCallback(
    () => ({
      buffers: viewFilteredRef.current ? filtRingRef.current : rawRingRef.current,
      writeHead: writeHeadRef.current,
      filled: filledRef.current,
    }),
    [],
  )

  const pushFrame = useCallback(
    (uv: Float32Array, filtered: Float32Array) => {
      const head = writeHeadRef.current
      const n = nChRef.current
      for (let c = 0; c < n; c++) {
        rawRingRef.current[c]![head] = uv[c] ?? 0
        filtRingRef.current[c]![head] = filtered[c] ?? 0
      }
      writeHeadRef.current = (head + 1) % capacity
      filledRef.current = Math.min(capacity, filledRef.current + 1)
    },
    [capacity],
  )

  const ingestFrames = useCallback(
    (frames: ReturnType<AdsFrameParser['feed']>) => {
      if (!frames.length) return
      let invalid = 0
      let gaps = 0
      let lastMode = 0
      let lastQ = 0
      for (const f of frames) {
        if (lastSeqRef.current !== null) {
          const delta = (f.sequence - lastSeqRef.current) >>> 0
          if (delta > 1 && delta < 1_000_000) gaps += delta - 1
        }
        lastSeqRef.current = f.sequence
        if (!f.valid) invalid += 1
        lastMode = f.mode
        lastQ = f.queueDepth
        const filtered = filterRef.current.processSample(f.uv, f.valid)
        pushFrame(f.uv, filtered)
        recorderRef.current.append(f.raw)
      }

      const now = performance.now()
      rateWinRef.current.n += frames.length
      const elapsed = (now - rateWinRef.current.t0) / 1000
      let rateHz = 0
      if (elapsed >= 0.4) {
        rateHz = rateWinRef.current.n / elapsed
        rateWinRef.current = { t0: now, n: 0, samplesBase: 0 }
      }

      const parser = parserRef.current
      setStats((s) => ({
        samples: s.samples + frames.length,
        rateHz: rateHz || s.rateHz,
        crcBad: parser?.crcBad ?? s.crcBad,
        syncDrop: parser?.syncDrop ?? s.syncDrop,
        invalid: s.invalid + invalid,
        seqGaps: s.seqGaps + gaps,
        lastSeq: lastSeqRef.current,
        mode: lastMode,
        queueDepth: lastQ,
        packetLoss: s.packetLoss,
        packetCount: s.packetCount,
      }))
      if (recorderRef.current.recording) setRecBytes(recorderRef.current.byteLength)
    },
    [pushFrame],
  )

  useEffect(() => {
    const transport = transportRef.current
    parserRef.current = new AdsFrameParser(() => lsbRef.current)
    transport.setHandlers({
      onData: (chunk) => {
        const frames = parserRef.current?.feed(chunk) ?? []
        if (streamingRef.current) ingestFrames(frames)
      },
      onStatus: (s, d) => {
        if (s === 'open') setStatus('open')
        else if (s === 'connecting') setStatus('connecting')
        else if (s === 'error') setStatus('error')
        else if (s === 'unsupported') setStatus('unsupported')
        else if (s === 'idle') {
          streamingRef.current = false
          setStatus((cur) => (cur === 'demo' ? cur : 'idle'))
        }
        if (d) setDetail(d)
      },
    })
    return () => {
      void transport.close()
      neuracleRef.current?.disconnect()
      if (demoTimerRef.current !== null) clearInterval(demoTimerRef.current)
    }
  }, [ingestFrames])

  useEffect(() => {
    if (status !== 'streaming' && status !== 'demo') return
    const id = window.setInterval(() => setTick((t) => t + 1), 250)
    return () => clearInterval(id)
  }, [status])

  const onEnabledFeaturesChange = (ids: string[]) => {
    setEnabledFeatures(ids)
    saveEnabledFeatures(ids)
  }

  // Sliding-window feature analysis on the filtered ring (demo + live).
  useEffect(() => {
    if (status !== 'streaming' && status !== 'demo') {
      setFeatureLatest(null)
      return
    }
    if (!enabledFeatures.length) {
      setFeatureLatest(null)
      return
    }
    const id = window.setInterval(() => {
      const snap = computeLiveFeatures({
        buffers: filtRingRef.current,
        writeHead: writeHeadRef.current,
        filled: filledRef.current,
        sampleRate,
        windowSec: FEATURE_WINDOW_SEC,
        channelMask: visible,
        enabledFeatures,
      })
      if (!snap) return
      setFeatureLatest(snap)
      setFeatureHistory((prev) => {
        const next = [...prev, snap]
        return next.length > FEATURE_HISTORY ? next.slice(-FEATURE_HISTORY) : next
      })
    }, 200)
    return () => clearInterval(id)
  }, [status, sampleRate, visible, enabledFeatures])

  useEffect(() => {
    filterRef.current.configure(DEFAULT_BAND_SOS, DEFAULT_NOTCH_SOS, useNotch)
  }, [useNotch])

  const syncLsb = (next: ChannelConfig) => {
    lsbRef.current = channelLsbUv(next.gains)
  }

  const stopDemo = useCallback(() => {
    if (demoTimerRef.current !== null) {
      clearInterval(demoTimerRef.current)
      demoTimerRef.current = null
    }
  }, [])

  const applyHardwareConfig = async (next: ChannelConfig) => {
    const t = transportRef.current
    if (!t.connected) return
    await t.write(CMD_STOP)
    await sleep(80)
    await t.write(cmdReference(next.reference))
    await sleep(60)
    await t.write(cmdMode(MODE_ITEMS[eegModeRef.current]?.cmd ?? 0x70))
    await sleep(60)
    await t.write(cmdBulkConfig(next))
    await sleep(100)
    syncLsb(next)
  }

  const connect = async () => {
    try {
      stopDemo()
      await transportRef.current.requestAndOpen(BAUD)
      await sleep(700)
      parserRef.current?.reset()
      await transportRef.current.write(CMD_STOP)
      await sleep(80)
      await applyHardwareConfig(cfg)
      setDetail('串口已打开。可改通道参数后点「开始采集」。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/No port selected|user cancelled|NotFoundError/i.test(msg)) {
        setStatus('idle')
        setDetail('已取消端口选择。')
      } else {
        setStatus('error')
        setDetail(`连接失败：${msg}`)
      }
    }
  }

  const resetBuffers = (n = nChRef.current) => {
    parserRef.current?.reset()
    resizeBuffers(n)
    lastSeqRef.current = null
    rateWinRef.current = { t0: performance.now(), n: 0, samplesBase: 0 }
    setStats({
      samples: 0,
      rateHz: 0,
      crcBad: 0,
      syncDrop: 0,
      invalid: 0,
      seqGaps: 0,
      lastSeq: null,
      mode: 0,
      queueDepth: 0,
      packetLoss: 0,
      packetCount: 0,
    })
  }

  const disconnect = async () => {
    stopDemo()
    streamingRef.current = false
    neuracleRef.current?.disconnect()
    neuracleRef.current = null
    try {
      if (transportRef.current.connected) await transportRef.current.write(CMD_STOP)
    } catch {
      /* ignore */
    }
    if (recorderRef.current.recording) {
      recorderRef.current.discard()
      setRecording(false)
      setRecBytes(0)
    }
    await transportRef.current.close()
    setStatus('idle')
    setDetail('已断开。')
  }

  const switchDevice = async (next: DeviceKind) => {
    await disconnect()
    setDevice(next)
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    if (next === 'omni') {
      resizeBuffers(CHANNELS)
      setStreamLabels([...cfg.labels])
      setVisible(Array.from({ length: CHANNELS }, () => true))
      setSampleRate(FS)
      setStatus(supported ? 'idle' : 'unsupported')
      setDetail(
        supported
          ? '通过 Web Serial 直连 ADS1299（OmniBCI 固件）。'
          : '当前浏览器不支持 Web Serial。',
      )
    } else {
      setStatus('idle')
      setDetail('连接本机 JellyFish 转发（需先 npm run neuracle-bridge）。')
    }
  }

  const neuracleChannelNames = (): string[] | null => {
    // null → bridge keeps every forwarded channel (typically 64 incl. ECG/EOG)
    if (neuracleMontage === 'all') return null
    if (neuracleMontage === '59') return [...NEURACLE_59_EEG_CHANNEL_NAMES]
    return [...NEURACLE_DEFAULT_VISIBLE]
  }

  const connectNeuracle = () => {
    stopDemo()
    neuracleRef.current?.disconnect()
    resetBuffers(8)
    setStatus('connecting')
    setDetail(`正在连接桥接 → JellyFish ${jfHost}:${jfPort}…`)

    const client = new NeuracleWsClient({
      url: neuracleWsUrl(),
      host: jfHost,
      port: jfPort,
      sourceSfreq: 250,
      eegChannelNames: neuracleChannelNames(),
      onStatus: (s, d) => {
        if (s === 'connecting') setStatus('connecting')
        else if (s === 'live') setStatus('streaming')
        else if (s === 'error') setStatus('error')
        else if (s === 'closed' || s === 'idle') {
          streamingRef.current = false
          setStatus('idle')
        }
        if (d) setDetail(d)
      },
      onHello: (hello: NeuracleHello) => {
        const names = hello.channels
        resizeBuffers(names.length)
        setStreamLabels(names)
        setStreamTypes(hello.channel_types ?? [])
        setSampleRate(hello.sample_rate)
        // Show every subscribed channel by default (not just motor-8).
        setVisible(names.map(() => true))
        streamingRef.current = true
        recorderRef.current.start()
        setRecording(true)
        setRecBytes(0)
        setFeatureLatest(null)
        setFeatureHistory([])
        setDetail(
          `博睿康 ${hello.module || 'Neuracle'} · ${names.length} 通道 @ ${hello.sample_rate} Hz（转发 ${hello.forwarded_channels}）`,
        )
      },
      onBatch: (batch) => {
        const n = batch.channels
        for (let s = 0; s < batch.samples; s++) {
          const uv = batch.values.subarray(s * n, s * n + n)
          const filtered = filterRef.current.processSample(uv, true)
          pushFrame(uv, filtered)
        }
        const now = performance.now()
        rateWinRef.current.n += batch.samples
        const elapsed = (now - rateWinRef.current.t0) / 1000
        let rateHz = 0
        if (elapsed >= 0.4) {
          rateHz = rateWinRef.current.n / elapsed
          rateWinRef.current = { t0: now, n: 0, samplesBase: 0 }
        }
        setStats((st) => ({
          ...st,
          samples: st.samples + batch.samples,
          rateHz: rateHz || st.rateHz,
          packetLoss: batch.packetLoss,
          packetCount: batch.packetCount,
        }))
        if (recorderRef.current.recording) {
          // store interleaved float32 as raw dump
          const bytes = new Uint8Array(batch.values.buffer, batch.values.byteOffset, batch.values.byteLength)
          recorderRef.current.append(bytes)
          setRecBytes(recorderRef.current.byteLength)
        }
      },
      onError: (message) => setDetail(message),
    })
    neuracleRef.current = client
    client.connect()
  }

  const startStream = async () => {
    const t = transportRef.current
    if (!t.connected) {
      setDetail('请先连接串口。')
      return
    }
    stopDemo()
    resetBuffers(CHANNELS)
    setStreamLabels(cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!))
    setVisible(Array.from({ length: CHANNELS }, () => true))
    setSampleRate(FS)
    try {
      await applyHardwareConfig(cfg)
      await t.write(CMD_STOP)
      await sleep(50)
      parserRef.current?.reset()
      await t.write(CMD_START)
      streamingRef.current = true
      setStatus('streaming')
      recorderRef.current.start()
      setRecording(true)
      setRecBytes(0)
      setFeatureLatest(null)
      setFeatureHistory([])
      setDetail('采集中：原始 48 字节帧写入浏览器内存，停止时下载 BIN。')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStatus('error')
      setDetail(`开始失败：${msg}`)
    }
  }

  const stopStream = async () => {
    streamingRef.current = false
    if (device === 'neuracle') {
      neuracleRef.current?.disconnect()
      neuracleRef.current = null
    } else {
      try {
        if (transportRef.current.connected) await transportRef.current.write(CMD_STOP)
      } catch {
        /* ignore */
      }
    }
    const prefix = device === 'neuracle' ? 'neuracle_eeg' : 'omni_ads1299'
    const saved = recorderRef.current.stopAndDownload(prefix)
    setRecording(false)
    setRecBytes(0)
    setFeatureLatest(null)
    setFeatureHistory([])
    setStatus(transportRef.current.connected ? 'open' : 'idle')
    setDetail(
      saved
        ? `已停止，下载 ${saved.name}（${(saved.bytes / 1024).toFixed(1)} KB）。`
        : '已停止采集。',
    )
  }

  const startDemo = () => {
    void disconnect().then(() => {
      setStatus('demo')
      setDetail('演示模式：合成多频带 EEG，实时滑窗分析频带与评分。')
      resetBuffers(CHANNELS)
      setStreamLabels([...CHANNEL_NAMES])
      setVisible(Array.from({ length: CHANNELS }, () => true))
      setSampleRate(FS)
      setFeatureLatest(null)
      setFeatureHistory([])
      let phase = 0
      let samples = 0
      const t0 = performance.now()
      demoTimerRef.current = window.setInterval(() => {
        const batch = 25
        for (let s = 0; s < batch; s++) {
          const t = (phase + s) / FS
          // Slow envelopes so band powers / scores visibly drift over ~10–20 s.
          const envAlpha = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.07 * t)
          const envBeta = 0.35 + 0.55 * Math.sin(2 * Math.PI * 0.11 * t + 1.2)
          const envTheta = 0.4 + 0.5 * Math.sin(2 * Math.PI * 0.05 * t + 0.6)
          const envDelta = 0.25 + 0.35 * Math.sin(2 * Math.PI * 0.03 * t + 2.1)
          const envGamma = 0.15 + 0.25 * Math.sin(2 * Math.PI * 0.13 * t + 0.3)
          const uv = new Float32Array(CHANNELS)
          for (let c = 0; c < CHANNELS; c++) {
            const phaseCh = c * 0.37
            uv[c] =
              envDelta * 18 * Math.sin(2 * Math.PI * (2.2 + c * 0.05) * t + phaseCh) +
              envTheta * 14 * Math.sin(2 * Math.PI * (6.0 + c * 0.08) * t + phaseCh) +
              envAlpha * 22 * Math.sin(2 * Math.PI * (10.0 + c * 0.12) * t + phaseCh) +
              envBeta * 12 * Math.sin(2 * Math.PI * (20.0 + c * 0.2) * t + phaseCh) +
              envGamma * 6 * Math.sin(2 * Math.PI * (36.0 + c * 0.15) * t + phaseCh) +
              (Math.random() - 0.5) * 5
          }
          pushFrame(uv, filterRef.current.processSample(uv, true))
        }
        phase += batch
        samples += batch
        lastSeqRef.current = samples - 1
        setStats({
          samples,
          rateHz: samples / Math.max(0.001, (performance.now() - t0) / 1000),
          crcBad: 0,
          syncDrop: 0,
          invalid: 0,
          seqGaps: 0,
          lastSeq: samples - 1,
          mode: 4,
          queueDepth: 0,
          packetLoss: 0,
          packetCount: 0,
        })
      }, 100)
    })
  }

  const updateCfg = (patch: Partial<ChannelConfig> | ((c: ChannelConfig) => ChannelConfig)) => {
    setCfg((c) => {
      const next = typeof patch === 'function' ? patch(c) : { ...c, ...patch }
      syncLsb(next)
      saveConfig(next)
      return next
    })
  }

  const applyMontage = (id: string) => {
    const preset = MONTAGE_PRESETS.find((p) => p.id === id)
    if (!preset) {
      setMontageId('custom')
      return
    }
    setMontageId(id)
    updateCfg((c) => ({ ...c, labels: [...preset.names] }))
  }

  const channelLabels =
    device === 'neuracle' || status === 'demo'
      ? streamLabels
      : cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!)

  // Keep Omni labels in sync for waveform when editing omni config
  useEffect(() => {
    if (device === 'omni' && status !== 'demo') {
      setStreamLabels(cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!))
    }
  }, [cfg.labels, device, status])

  const statusLabel =
    status === 'streaming'
      ? '采集中'
      : status === 'open'
        ? '已连接'
        : status === 'connecting'
          ? '连接中'
          : status === 'demo'
            ? '演示'
            : status === 'error'
              ? '错误'
              : status === 'unsupported'
                ? '不支持'
                : '未连接'

  const statusColor =
    status === 'streaming' || status === 'demo'
      ? 'var(--accent-2)'
      : status === 'open'
        ? 'var(--accent)'
        : status === 'error' || status === 'unsupported'
          ? 'var(--danger)'
          : 'var(--muted)'

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/" className="muted text-sm hover:text-[var(--text)]">
            ← 返回首页
          </Link>
          <h1 className="m-0 mt-2 text-2xl font-semibold tracking-tight">采集调试</h1>
          <p className="muted mt-1 max-w-2xl text-sm">
            支持两套硬件：OmniBCI ADS1299（Web Serial 直连）与博睿康 Neuracle（经 JellyFish 转发，协议来自{' '}
            <code className="rounded bg-[#10182b] px-1 py-0.5 text-xs">oi-mi</code>
            ）。通道名可自定义；博睿康默认接入全部转发通道（约 64 导）。
          </p>
        </div>
        <span className="chip" style={{ color: statusColor, borderColor: `${statusColor}66` }}>
          {statusLabel}
        </span>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={`btn ${device === 'omni' ? 'btn-primary' : 'btn-ghost'}`}
          disabled={status === 'streaming' || status === 'connecting'}
          onClick={() => void switchDevice('omni')}
        >
          OmniBCI（USB）
        </button>
        <button
          type="button"
          className={`btn ${device === 'neuracle' ? 'btn-primary' : 'btn-ghost'}`}
          disabled={status === 'streaming' || status === 'connecting'}
          onClick={() => void switchDevice('neuracle')}
        >
          博睿康 Neuracle
        </button>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel title={device === 'neuracle' ? '设备连接（博睿康 / JellyFish）' : '设备连接（Web Serial）'}>
          {device === 'neuracle' ? (
            <>
              <div className="mb-3 grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  <span className="muted mb-1 block">JellyFish Host</span>
                  <input
                    className="input"
                    value={jfHost}
                    disabled={status === 'streaming' || status === 'connecting'}
                    onChange={(e) => setJfHost(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  <span className="muted mb-1 block">Port</span>
                  <input
                    className="input"
                    type="number"
                    value={jfPort}
                    disabled={status === 'streaming' || status === 'connecting'}
                    onChange={(e) => setJfPort(Number(e.target.value) || 8712)}
                  />
                </label>
                <label className="text-sm">
                  <span className="muted mb-1 block">EEG 通道集</span>
                  <select
                    className="select"
                    value={neuracleMontage}
                    disabled={status === 'streaming' || status === 'connecting'}
                    onChange={(e) =>
                      setNeuracleMontage(e.target.value as 'all' | '59' | 'motor8')
                    }
                  >
                    <option value="all">全部转发通道（通常 64，含 ECG/EOG）</option>
                    <option value="59">59 导头皮 EEG（排除心电/眼电）</option>
                    <option value="motor8">仅运动区 8 导</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {status === 'streaming' || status === 'connecting' ? (
                  <button type="button" className="btn btn-danger" onClick={() => void stopStream()}>
                    停止 / 断开
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={connectNeuracle}>
                    连接并开始采集
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={status === 'demo' ? () => void disconnect() : startDemo}
                >
                  {status === 'demo' ? '停止演示' : '演示波形'}
                </button>
              </div>
              <p className="muted mt-3 mb-0 text-xs leading-relaxed">
                先启动 JellyFish 数据转发，再运行{' '}
                <code className="rounded bg-[#10182b] px-1 py-0.5">npm run neuracle-bridge</code>
                （复用 oi-mi 的 <code className="rounded bg-[#10182b] px-1 py-0.5">neuracle_api</code>
                ）。浏览器经 Vite 代理连到桥接。
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {status === 'open' || status === 'streaming' ? (
                  <>
                    {status === 'streaming' ? (
                      <button type="button" className="btn btn-danger" onClick={() => void stopStream()}>
                        停止采集
                      </button>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={() => void startStream()}>
                        开始采集
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void disconnect()}
                      disabled={status === 'streaming'}
                    >
                      断开串口
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void connect()}
                    disabled={!supported || status === 'connecting' || status === 'demo'}
                  >
                    选择串口并连接
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={status === 'demo' ? () => void disconnect() : startDemo}
                >
                  {status === 'demo' ? '停止演示' : '演示波形'}
                </button>
              </div>
              <p className="muted mt-2 mb-0 text-xs">
                波特率 {BAUD}。人体电极须电池供电与电气隔离。
              </p>
            </>
          )}
          <p
            className="muted mt-3 mb-0 text-sm"
            style={{ color: status === 'error' ? 'var(--danger)' : undefined }}
          >
            {detail}
          </p>
        </Panel>

        <Panel title="显示">
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={viewFiltered}
              onChange={(e) => setViewFiltered(e.target.checked)}
            />
            显示滤波后（5–50 Hz）
          </label>
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useNotch}
              onChange={(e) => setUseNotch(e.target.checked)}
            />
            50/100 Hz 陷波
          </label>
          <Slider
            label={`纵轴 ±${yScaleUv} μV`}
            min={20}
            max={500}
            step={10}
            value={yScaleUv}
            onChange={setYScaleUv}
          />
          <div className="mt-3">
            <Slider
              label={`窗口 ${windowSec.toFixed(1)} s`}
              min={1}
              max={10}
              step={0.5}
              value={windowSec}
              onChange={setWindowSec}
            />
          </div>
          {recording && (
            <p className="mt-3 mb-0 text-sm" style={{ color: 'var(--accent-2)' }}>
              录制中 · {(recBytes / 1024).toFixed(1)} KB
            </p>
          )}
        </Panel>
      </div>

      <Panel title="硬件配置" className={`mb-4 ${device !== 'omni' ? 'hidden' : ''}`}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="muted mb-1 block">参考电极</span>
            <select
              className="select"
              value={cfg.reference}
              disabled={status === 'streaming'}
              onChange={(e) => updateCfg({ reference: Number(e.target.value) as ReferenceMode })}
            >
              <option value={REFERENCE_SRB1}>SRB1 全局参考（信号接 INxP）</option>
              <option value={REFERENCE_SRB2}>SRB2 公共参考（信号接 INxN）</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block">工作模式</span>
            <select
              className="select"
              value={eegMode}
              disabled={status === 'streaming'}
              onChange={(e) => setEegMode(Number(e.target.value))}
            >
              {MODE_ITEMS.map((m, i) => (
                <option key={m.label} value={i}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block">全局 PGA</span>
            <select
              className="select"
              value={cfg.gains[0]}
              disabled={status === 'streaming'}
              onChange={(e) => {
                const g = Number(e.target.value)
                updateCfg((c) => ({
                  ...c,
                  gains: Array.from({ length: CHANNELS }, () => g),
                }))
              }}
            >
              {VALID_GAINS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="muted mb-1 block">通道名预设</span>
            <select
              className="select"
              value={montageId}
              onChange={(e) => applyMontage(e.target.value)}
            >
              <option value="custom">自定义</option>
              {MONTAGE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={status !== 'open'}
            onClick={() =>
              void applyHardwareConfig(cfg).then(() => setDetail('已下发 A5/A8 配置。'))
            }
          >
            应用配置到设备
          </button>
          <span className="muted text-xs">
            通道名仅用于显示/日志，不写入固件；启用、BIAS、Gain 会下发到 ADS1299。设置会保存在本机浏览器。
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="muted text-left">
                <th className="pb-2 font-medium">硬件</th>
                <th className="pb-2 font-medium">自定义名称</th>
                <th className="pb-2 font-medium">启用</th>
                <th className="pb-2 font-medium">BIAS</th>
                <th className="pb-2 font-medium">SRB2</th>
                <th className="pb-2 font-medium">Gain</th>
              </tr>
            </thead>
            <tbody>
              {CHANNEL_NAMES.map((hwName, i) => (
                <tr key={hwName} className="border-t border-[var(--border)]">
                  <td className="py-1.5 font-mono text-xs" style={{ color: CHANNEL_COLORS[i] }}>
                    {hwName}
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      className="input py-1"
                      style={{ width: 110 }}
                      value={cfg.labels[i] ?? ''}
                      placeholder={hwName}
                      maxLength={16}
                      onChange={(e) => {
                        setMontageId('custom')
                        updateCfg((c) => {
                          const labels = [...c.labels]
                          labels[i] = e.target.value
                          return { ...c, labels }
                        })
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={cfg.enabled[i]}
                      disabled={status === 'streaming'}
                      onChange={(e) =>
                        updateCfg((c) => {
                          const enabled = [...c.enabled]
                          enabled[i] = e.target.checked
                          return { ...c, enabled }
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={cfg.bias[i]}
                      disabled={status === 'streaming'}
                      onChange={(e) =>
                        updateCfg((c) => {
                          const bias = [...c.bias]
                          bias[i] = e.target.checked
                          return { ...c, bias }
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={cfg.srb2[i]}
                      disabled={status === 'streaming' || cfg.reference !== REFERENCE_SRB2}
                      onChange={(e) =>
                        updateCfg((c) => {
                          const srb2 = [...c.srb2]
                          srb2[i] = e.target.checked
                          return { ...c, srb2 }
                        })
                      }
                    />
                  </td>
                  <td>
                    <select
                      className="select py-1"
                      style={{ width: 80 }}
                      value={cfg.gains[i]}
                      disabled={status === 'streaming'}
                      onChange={(e) =>
                        updateCfg((c) => {
                          const gains = [...c.gains]
                          gains[i] = Number(e.target.value)
                          return { ...c, gains }
                        })
                      }
                    >
                      {VALID_GAINS.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <FeaturePanel
        latest={featureLatest}
        history={featureHistory}
        analyzing={status === 'streaming' || status === 'demo'}
        enabledIds={enabledFeatures}
        onEnabledChange={onEnabledFeaturesChange}
      />

      <Panel
        title="实时波形"
        className="mb-4"
        actions={
          <div className="flex flex-wrap gap-1.5">
            {channelLabels.map((name, i) => (
              <button
                key={`${CHANNEL_NAMES[i]}-${name}`}
                type="button"
                className="chip"
                style={{
                  color: visible[i] ? CHANNEL_COLORS[i % CHANNEL_COLORS.length] : 'var(--muted)',
                  borderColor: visible[i]
                    ? `${CHANNEL_COLORS[i % CHANNEL_COLORS.length]}88`
                    : 'var(--border)',
                  opacity: visible[i] ? 1 : 0.45,
                  cursor: 'pointer',
                }}
                onClick={() =>
                  setVisible((v) => {
                    const n = [...v]
                    n[i] = !n[i]
                    return n
                  })
                }
              >
                {name}
              </button>
            ))}
          </div>
        }
      >
        <WaveformCanvas
          getSnapshot={getSnapshot}
          channelNames={channelLabels}
          visibleChannels={visible}
          yScaleUv={yScaleUv}
          windowSec={windowSec}
          sampleRate={sampleRate}
          height={Math.max(
            320,
            Math.min(56, Math.floor(720 / Math.max(1, visible.filter(Boolean).length))) *
              Math.max(1, visible.filter(Boolean).length),
          )}
        />
      </Panel>

      {device === 'neuracle' && streamLabels.length > 0 && (
        <Panel title={`通道显示（${visible.filter(Boolean).length}/${streamLabels.length}）`} className="mb-4">
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setVisible(streamLabels.map(() => true))}
            >
              全部显示
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const want = new Set(
                  NEURACLE_DEFAULT_VISIBLE.map((n) => n.toUpperCase()),
                )
                setVisible(
                  streamLabels.map((n) =>
                    want.has(n.replace(/\s+/g, '').toUpperCase()),
                  ),
                )
              }}
            >
              仅运动区
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                setVisible(
                  streamLabels.map((_, i) => {
                    const t = (streamTypes[i] || '').toUpperCase()
                    return !t || t === 'EEG'
                  }),
                )
              }
            >
              仅 EEG
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setVisible(streamLabels.map(() => false))}
            >
              全部隐藏
            </button>
          </div>
          <p className="muted mt-0 mb-3 text-xs">
            默认接入 JellyFish 全部转发通道（常见 64 导）。点芯片可开关；多通道时行高自动压缩。
          </p>
          <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
            {streamLabels.map((name, i) => (
              <button
                key={`${name}-${i}`}
                type="button"
                className="chip"
                style={{
                  color: visible[i] ? CHANNEL_COLORS[i % CHANNEL_COLORS.length] : 'var(--muted)',
                  borderColor: visible[i]
                    ? `${CHANNEL_COLORS[i % CHANNEL_COLORS.length]}88`
                    : 'var(--border)',
                  opacity: visible[i] ? 1 : 0.4,
                  cursor: 'pointer',
                }}
                onClick={() =>
                  setVisible((v) => {
                    const n = v.length === streamLabels.length ? [...v] : streamLabels.map(() => false)
                    n[i] = !n[i]
                    return n
                  })
                }
              >
                {name}
              </button>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="吞吐 / 质量">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="muted">实测速率</dt>
            <dd className="m-0">{stats.rateHz ? `${stats.rateHz.toFixed(1)} Hz` : '—'}</dd>
            <dt className="muted">累计样本</dt>
            <dd className="m-0">{stats.samples.toLocaleString()}</dd>
            {device === 'omni' ? (
              <>
                <dt className="muted">CRC 错误</dt>
                <dd className="m-0">{stats.crcBad}</dd>
                <dt className="muted">同步丢弃</dt>
                <dd className="m-0">{stats.syncDrop}</dd>
                <dt className="muted">invalid 帧</dt>
                <dd className="m-0">{stats.invalid}</dd>
                <dt className="muted">sequence gaps</dt>
                <dd className="m-0">{stats.seqGaps}</dd>
                <dt className="muted">末序号</dt>
                <dd className="m-0 font-mono">{stats.lastSeq ?? '—'}</dd>
                <dt className="muted">固件 mode</dt>
                <dd className="m-0">{MODE_NAMES[stats.mode] ?? stats.mode}</dd>
                <dt className="muted">queue depth</dt>
                <dd className="m-0">{stats.queueDepth}</dd>
              </>
            ) : (
              <>
                <dt className="muted">通道数</dt>
                <dd className="m-0">{nChannels}</dd>
                <dt className="muted">采样率</dt>
                <dd className="m-0">{sampleRate} Hz</dd>
                <dt className="muted">JellyFish 包</dt>
                <dd className="m-0">{stats.packetCount}</dd>
                <dt className="muted">packet loss</dt>
                <dd className="m-0">{stats.packetLoss}</dd>
              </>
            )}
          </dl>
        </Panel>
        <Panel title="说明">
          <ul className="muted m-0 list-disc space-y-1.5 pl-4 text-sm">
            {device === 'neuracle' ? (
              <>
                <li>
                  协议来自 oi-mi <code>collect/neuracle_api.py</code>（博睿康 JellyFish 转发）。
                </li>
                <li>
                  默认接入 JellyFish <strong>全部转发通道</strong>（常见 64 导，含 ECG/EOG）；也可选
                  59 导头皮或运动区 8 导。
                </li>
                <li>
                  需本机跑 <code>npm run neuracle-bridge</code>，并把 JellyFish 转到 8712。
                </li>
                <li>通道面板可「全部显示 / 仅运动区 / 仅 EEG」；多通道时波形行高自动压缩。</li>
              </>
            ) : (
              <>
                <li>帧格式：A5 5A · 8×24-bit BE · CRC16-CCITT，与原版 GUI / 固件一致。</li>
                <li>
                  开始采集发 <code>b</code>，停止发 <code>s</code>；通道用原子命令{' '}
                  <code>A5</code>。
                </li>
                <li>滤波在浏览器内实时做（带通 + 可选陷波），BIN 存原始帧。</li>
                <li>需 Chrome/Edge + localhost；首次连接会弹出串口选择框。</li>
              </>
            )}
          </ul>
        </Panel>
      </div>
    </div>
  )
}
