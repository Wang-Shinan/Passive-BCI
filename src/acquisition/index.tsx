import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { DEFAULT_BAND_SOS, DEFAULT_NOTCH_SOS } from './filter/iir'
import { designBandpassSos, designNotchCascade } from './filter/design'
import {
  NEURACLE_59_EEG_CHANNEL_NAMES,
  NeuracleWsClient,
  type NeuracleHello,
} from './neuracle/client'
import { BcigoWsClient, type BcigoHello } from './bcigo/client'
import {
  CMD_START,
  CMD_STOP,
  cmdBulkConfig,
  cmdLeadOff,
  cmdMode,
  cmdReference,
} from './protocol/commands'
import {
  ADC_SATURATION_FRACTION,
  BAUD,
  CHANNEL_NAMES,
  CHANNELS,
  FRAME_BYTES,
  FS,
  MODE_ITEMS,
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
import { webSerialSupported } from './transport/webSerial'
import { WaveformCanvas } from './WaveformCanvas'
import { FftCanvas } from './FftCanvas'
import { ImpedancePanel } from './ImpedancePanel'
import { FeaturePanel } from './FeaturePanel'
import { ChannelRail, ChannelSettingsDialog } from './ChannelRail'
import { ensureBridge } from './bridgeApi'
import {
  acqRuntime,
  beginRawBridgeStream,
  ingestBridgeToHub,
  setAcquisitionUi,
  waitConfigAck,
} from './runtime'
import {
  LIVE_CATCHUP_THRESHOLD_S,
  liveLagSec,
  resetCatchup,
  setCatchupClock,
  setFirmwareQueueDepth,
} from './liveCatchup'
import { liveEegHub, persistHiddenFromMask, visibleMaskForNames } from '../lib/eeg/liveHub'
import {
  copyLatestChannel,
  copyLatestValid,
  estimateLeadOffKohm,
  impedanceSeriesDefaultKohm,
  leadOffAckMatches,
  leadOffOffAckMatches,
  rowFromKohm,
  type ImpedanceRowState,
} from './analysis/impedance'
import './acquisition.css'
import {
  computeLiveFeatures,
  loadEnabledFeatures,
  saveEnabledFeatures,
  type LiveFeatureSnapshot,
} from '../lib/features'
import { ModelServicePanel } from '../lib/model-runtime'
import { formatRecordBytes, type RecordMeta, type RecordSinkKind } from './session/recorder'

const RING_SECONDS = 12
const FEATURE_HISTORY = 60
const CFG_STORAGE_KEY = 'passive-bci.acquisition.channel-config'
const DEVICE_STORAGE_KEY = 'passive-bci.acquisition.device'

const EMPTY_STATS = {
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
  saturation: 0,
}

type DeviceKind = 'omni' | 'neuracle' | 'bcigo'
type ConnUi = 'idle' | 'connecting' | 'open' | 'streaming' | 'error' | 'unsupported' | 'demo'
type ViewMode = 'wave' | 'single' | 'psd' | 'impedance'

function makeRing(nChannels: number, capacity: number): Float32Array[] {
  return Array.from({ length: nChannels }, () => new Float32Array(capacity))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isBridgeDevice(d: DeviceKind): boolean {
  return d === 'neuracle' || d === 'bcigo'
}

function recordPrefix(d: DeviceKind): string {
  return d === 'neuracle' ? 'neuracle_eeg' : d === 'bcigo' ? 'bcigo_eeg' : 'omni_ads1299'
}

function streamingRecordDetail(d: DeviceKind, sink: RecordSinkKind): string {
  const dest =
    sink === 'disk' ? '边采边写入项目 recordings/ 目录' : '暂存在浏览器内存，停止时下载 BIN'
  if (d === 'bcigo') return `采集中：强脑 EEG ${dest}。`
  if (d === 'neuracle') return `采集中：博睿康转发数据 ${dest}。`
  return `采集中：原始 48 字节帧 ${dest}。`
}

function savedRecordDetail(
  saved: { name: string; bytes: number; sink: RecordSinkKind; path?: string; rel?: string } | null,
  stillLinked: boolean,
): string {
  const linked = stillLinked ? '设备仍连接，可再次开始。' : ''
  if (!saved) return stillLinked ? '已停止采集；设备仍连接。' : '已停止采集。'
  const size = formatRecordBytes(saved.bytes)
  if (saved.sink === 'disk') {
    const where = saved.rel || saved.path || saved.name
    return `已停止采集，已写入 ${where}（${size}）。${linked}`
  }
  return `已停止采集，下载 ${saved.name}（${size}）。${linked}`
}

function idleImpedanceRows(
  names: string[],
  selected: boolean[],
  enabled: boolean[],
  idleText = '等待检测',
): ImpedanceRowState[] {
  return names.map((_, i) =>
    rowFromKohm(null, Boolean(selected[i]), enabled[i] !== false, idleText),
  )
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

function bcigoWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8767/v1/stream'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  if (window.location.port && window.location.port !== '8767') {
    return `${proto}//${window.location.host}/ws/bcigo`
  }
  return 'ws://127.0.0.1:8767/v1/stream'
}

function deviceDetail(d: DeviceKind, supported: boolean): string {
  if (d === 'neuracle') {
    return '连接博睿康 JellyFish 转发（点连接会自动启动本机桥接）。'
  }
  if (d === 'bcigo') {
    return '连接强脑 BCIGo Wi‑Fi（点连接会自动启动本机桥接；基于 bcigo-sdk）。'
  }
  return supported
    ? '通过 Web Serial 直连 ADS1299（OmniBCI 固件）。'
    : '当前浏览器不支持 Web Serial，请使用 Chrome / Edge。'
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
    if (liveEegHub.meta.device === 'omni' || liveEegHub.meta.device === 'neuracle' || liveEegHub.meta.device === 'bcigo') {
      return liveEegHub.meta.device
    }
    try {
      const v = localStorage.getItem(DEVICE_STORAGE_KEY)
      if (v === 'neuracle' || v === 'bcigo' || v === 'omni') return v
      return 'omni'
    } catch {
      return 'omni'
    }
  })
  const [status, setStatus] = useState<ConnUi>(() => {
    if (acqRuntime.status !== 'idle') return acqRuntime.status
    return device === 'omni' ? (supported ? 'idle' : 'unsupported') : 'idle'
  })
  const [detail, setDetail] = useState(() => liveEegHub.meta.detail || deviceDetail(device, supported))
  const [cfg, setCfg] = useState<ChannelConfig>(() => loadSavedConfig())
  const [montageId, setMontageId] = useState('custom')
  const [eegMode, setEegMode] = useState(1)
  const [viewFiltered, setViewFiltered] = useState(true)
  const [useNotch, setUseNotch] = useState(true)
  const [bandLoHz, setBandLoHz] = useState(5)
  const [bandHiHz, setBandHiHz] = useState(50)
  const [yScaleUv, setYScaleUv] = useState(100)
  const [windowSec, setWindowSec] = useState(10)
  const [featureWindowSec, setFeatureWindowSec] = useState(1)
  const [viewMode, setViewMode] = useState<ViewMode>('wave')
  const [singleChannel, setSingleChannel] = useState(0)
  const [channelDialog, setChannelDialog] = useState<number | null>(null)
  const [nChannels, setNChannels] = useState(() =>
    liveEegHub.meta.channelNames.length || CHANNELS,
  )
  const [streamLabels, setStreamLabels] = useState<string[]>(() =>
    liveEegHub.meta.channelNames.length
      ? [...liveEegHub.meta.channelNames]
      : [...loadSavedConfig().labels],
  )
  const [streamTypes, setStreamTypes] = useState<string[]>([])
  const [visible, setVisible] = useState(() => {
    const names = liveEegHub.meta.channelNames
    if (names.length) return visibleMaskForNames(names)
    const n = CHANNELS
    return Array.from({ length: n }, () => true)
  })
  const [sampleRate, setSampleRate] = useState(() => liveEegHub.meta.sampleRate || FS)
  const [jfHost, setJfHost] = useState('127.0.0.1')
  const [jfPort, setJfPort] = useState(8712)
  const [neuracleMontage, setNeuracleMontage] = useState<'all' | '59' | 'motor8'>('all')
  const [bcigoHost, setBcigoHost] = useState('')
  const [bcigoPort, setBcigoPort] = useState<number | ''>('')
  const [bcigoSampleRate, setBcigoSampleRate] = useState(250)
  const [bcigoGain, setBcigoGain] = useState(6)
  const [bcigoSignal, setBcigoSignal] = useState<'normal' | 'test' | 'shorted' | 'mvdd'>('normal')
  const [impedanceOpen, setImpedanceOpen] = useState(false)
  const [impedanceMeasuring, setImpedanceMeasuring] = useState(false)
  const [impedanceSelected, setImpedanceSelected] = useState<boolean[]>(() => [...loadSavedConfig().enabled])
  const [impedanceSeriesKohm, setImpedanceSeriesKohm] = useState(() =>
    impedanceSeriesDefaultKohm(loadSavedConfig().reference),
  )
  const [impedanceRows, setImpedanceRows] = useState<ImpedanceRowState[]>([])
  const [impedanceDetail, setImpedanceDetail] = useState('')
  const [recording, setRecording] = useState(false)
  const [recBytes, setRecBytes] = useState(0)
  const [recSink, setRecSink] = useState<RecordSinkKind | null>(null)
  const [featureLatest, setFeatureLatest] = useState<LiveFeatureSnapshot | null>(null)
  const [featureHistory, setFeatureHistory] = useState<LiveFeatureSnapshot[]>([])
  const [enabledFeatures, setEnabledFeatures] = useState<string[]>(() => loadEnabledFeatures())
  const [stats, setStats] = useState(() => ({ ...EMPTY_STATS }))
  const statsRef = useRef({ ...EMPTY_STATS })

  const transportRef = useRef(acqRuntime.transport)
  const neuracleRef = useRef<NeuracleWsClient | null>(acqRuntime.neuracle)
  const bcigoRef = useRef<BcigoWsClient | null>(acqRuntime.bcigo)
  const parserRef = useRef<AdsFrameParser | null>(acqRuntime.parser)
  const filterRef = useRef(acqRuntime.filter)
  const recorderRef = useRef(acqRuntime.recorder)
  const rawRingRef = useRef(makeRing(nChannels, capacity))
  const filtRingRef = useRef(makeRing(nChannels, capacity))
  const validRingRef = useRef(new Uint8Array(capacity))
  const writeHeadRef = useRef(0)
  const filledRef = useRef(0)
  const nChRef = useRef(nChannels)
  const lsbRef = useRef(acqRuntime.lsb)
  const lastSeqRef = useRef<number | null>(null)
  const rateWinRef = useRef({ t0: performance.now(), n: 0, samplesBase: 0 })
  const demoTimerRef = useRef<number | null>(null)
  const streamingRef = useRef(acqRuntime.streaming)
  const cfgRef = useRef(cfg)
  const impedanceMaskRef = useRef(0)
  const impedanceSelectedRef = useRef(impedanceSelected)
  const impedanceSeriesRef = useRef(impedanceSeriesKohm)
  const impedanceSdkRef = useRef(false)
  const ingestBridgeBatchRef = useRef<(batch: {
    values: Float32Array
    samples: number
    channels: number
    packetLoss: number
    packetCount: number
  }) => void>(() => {})
  const viewFilteredRef = useRef(viewFiltered)
  const eegModeRef = useRef(eegMode)
  viewFilteredRef.current = viewFiltered
  eegModeRef.current = eegMode
  nChRef.current = nChannels
  cfgRef.current = cfg
  impedanceSelectedRef.current = impedanceSelected
  impedanceSeriesRef.current = impedanceSeriesKohm

  const resizeBuffers = useCallback(
    (n: number) => {
      nChRef.current = n
      setNChannels(n)
      filterRef.current.setChannelCount(n)
      filterRef.current.reset()
      rawRingRef.current = makeRing(n, capacity)
      filtRingRef.current = makeRing(n, capacity)
      validRingRef.current = new Uint8Array(capacity)
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
    (uv: Float32Array, filtered: Float32Array, valid = true) => {
      const head = writeHeadRef.current
      const n = nChRef.current
      for (let c = 0; c < n; c++) {
        rawRingRef.current[c]![head] = uv[c] ?? 0
        filtRingRef.current[c]![head] = filtered[c] ?? 0
      }
      validRingRef.current[head] = valid ? 1 : 0
      writeHeadRef.current = (head + 1) % capacity
      filledRef.current = Math.min(capacity, filledRef.current + 1)
      if (
        !acqRuntime.impedanceActive &&
        (streamingRef.current || acqRuntime.streaming || acqRuntime.status === 'demo')
      ) {
        liveEegHub.pushFrame(uv)
      }
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
      let sat = 0
      const satLim = ADC_SATURATION_FRACTION * ((1 << 23) - 1)
      const enabled = cfgRef.current.enabled
      for (const f of frames) {
        if (lastSeqRef.current !== null) {
          const delta = (f.sequence - lastSeqRef.current) >>> 0
          if (delta > 1 && delta < 1_000_000) gaps += delta - 1
        }
        lastSeqRef.current = f.sequence
        if (!f.valid) invalid += 1
        lastMode = f.mode
        lastQ = f.queueDepth
        for (let ch = 0; ch < f.rawCounts.length; ch++) {
          if (enabled[ch] === false) continue
          if (Math.abs(f.rawCounts[ch]!) > satLim) sat += 1
        }
        const filtered = filterRef.current.processSample(f.uv, f.valid)
        pushFrame(f.uv, filtered, f.valid)
        if (recorderRef.current.recording && !acqRuntime.impedanceActive) {
          recorderRef.current.append(f.raw)
        }
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
      const s = statsRef.current
      s.samples += frames.length
      if (rateHz) s.rateHz = rateHz
      s.crcBad = parser?.crcBad ?? s.crcBad
      s.syncDrop = parser?.syncDrop ?? s.syncDrop
      s.invalid += invalid
      s.seqGaps += gaps
      s.lastSeq = lastSeqRef.current
      s.mode = lastMode
      s.queueDepth = lastQ
      s.saturation += sat
      setFirmwareQueueDepth(lastQ)
    },
    [pushFrame],
  )

  useEffect(() => {
    neuracleRef.current = acqRuntime.neuracle
    bcigoRef.current = acqRuntime.bcigo
    if (!acqRuntime.parser) {
      acqRuntime.parser = new AdsFrameParser(() => acqRuntime.lsb)
    }
    parserRef.current = acqRuntime.parser
    streamingRef.current = acqRuntime.streaming

    setAcquisitionUi({
      onSerialData: (chunk) => {
        const frames = parserRef.current?.feed(chunk) ?? []
        if (streamingRef.current) ingestFrames(frames)
      },
      onSerialStatus: (s, d) => {
        if (s === 'open') {
          acqRuntime.status = 'open'
          setStatus('open')
          liveEegHub.markOpen(d)
        } else if (s === 'connecting') {
          acqRuntime.status = 'connecting'
          setStatus('connecting')
          liveEegHub.markConnecting(d)
        } else if (s === 'error') {
          acqRuntime.streaming = false
          streamingRef.current = false
          acqRuntime.status = 'error'
          setStatus('error')
          liveEegHub.markError(d)
        } else if (s === 'unsupported') {
          setStatus('unsupported')
        } else if (s === 'idle') {
          streamingRef.current = false
          acqRuntime.streaming = false
          setStatus((cur) => {
            if (cur === 'demo') return cur
            acqRuntime.status = 'idle'
            liveEegHub.markIdle(d)
            return 'idle'
          })
        }
        if (d) setDetail(d)
      },
      onBridgeBatch: (batch) => ingestBridgeBatchRef.current(batch),
    })
    return () => {
      setAcquisitionUi(null)
      if (demoTimerRef.current !== null) {
        clearInterval(demoTimerRef.current)
        demoTimerRef.current = null
        if (acqRuntime.status === 'demo') {
          acqRuntime.streaming = false
          acqRuntime.status = 'idle'
          liveEegHub.markIdle()
        }
      }
    }
  }, [ingestFrames])

  useEffect(() => {
    if (status !== 'streaming' && status !== 'demo') return
    const id = window.setInterval(() => {
      setStats({ ...statsRef.current })
      if (recorderRef.current.recording) {
        setRecBytes(recorderRef.current.byteLength)
      }
    }, 250)
    return () => clearInterval(id)
  }, [status])

  const onEnabledFeaturesChange = (ids: string[]) => {
    setEnabledFeatures(ids)
    saveEnabledFeatures(ids)
  }

  // Sliding-window feature analysis on the raw ring (band scores need θ/δ).
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
        buffers: rawRingRef.current,
        writeHead: writeHeadRef.current,
        filled: filledRef.current,
        sampleRate,
        windowSec: featureWindowSec,
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
  }, [status, sampleRate, visible, enabledFeatures, featureWindowSec])

  useEffect(() => {
    liveEegHub.setChannelMask(visible)
  }, [visible])

  useEffect(() => {
    const lo = Math.min(bandLoHz, bandHiHz - 0.5)
    const hi = Math.max(bandHiHz, lo + 0.5)
    const band = designBandpassSos(lo, hi, sampleRate)
    const notch = designNotchCascade(sampleRate, 50)
    filterRef.current.configure(band.length ? band : DEFAULT_BAND_SOS, notch.length ? notch : DEFAULT_NOTCH_SOS, useNotch)
  }, [useNotch, bandLoHz, bandHiHz, sampleRate])

  const syncLsb = (next: ChannelConfig) => {
    const lsb = channelLsbUv(next.gains)
    lsbRef.current = lsb
    acqRuntime.lsb = lsb
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
      acqRuntime.device = 'omni'
      acqRuntime.status = 'open'
      setCatchupClock(FS, FRAME_BYTES)
      const msg = '串口已打开。可改通道参数后点「开始采集」。'
      liveEegHub.configure({
        device: 'omni',
        sampleRate: FS,
        channelNames: cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!),
        detail: msg,
      })
      liveEegHub.markOpen(msg)
      setDetail(msg)
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
    resetCatchup()
    statsRef.current = { ...EMPTY_STATS }
    setStats({ ...EMPTY_STATS })
  }

  const disconnect = async () => {
    stopDemo()
    streamingRef.current = false
    try {
      bcigoRef.current?.stopImpedance()
    } catch {
      /* ignore */
    }
    if (acqRuntime.impedanceActive) {
      try {
        if (transportRef.current.connected) {
          await transportRef.current.write(CMD_STOP)
          await sleep(50)
          await transportRef.current.write(cmdLeadOff(0))
        }
      } catch {
        /* ignore */
      }
    }
    acqRuntime.impedanceActive = false
    setImpedanceMeasuring(false)
    resetCatchup()
    neuracleRef.current?.disconnect()
    neuracleRef.current = null
    acqRuntime.neuracle = null
    bcigoRef.current?.disconnect()
    bcigoRef.current = null
    acqRuntime.bcigo = null
    acqRuntime.streaming = false
    acqRuntime.status = 'idle'
    liveEegHub.markIdle('已断开。')
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
      setCatchupClock(FS, FRAME_BYTES)
      setStatus(supported ? 'idle' : 'unsupported')
      setDetail(deviceDetail('omni', supported))
    } else {
      setStatus('idle')
      setDetail(deviceDetail(next, supported))
    }
  }

  const neuracleChannelNames = (): string[] | null => {
    // null → bridge keeps every forwarded channel (typically 64 incl. ECG/EOG)
    if (neuracleMontage === 'all') return null
    if (neuracleMontage === '59') return [...NEURACLE_59_EEG_CHANNEL_NAMES]
    return [...NEURACLE_DEFAULT_VISIBLE]
  }

  const connectNeuracle = () => {
    void (async () => {
      stopDemo()
      neuracleRef.current?.disconnect()
      bcigoRef.current?.disconnect()
      bcigoRef.current = null
      acqRuntime.bcigo = null
      acqRuntime.device = 'neuracle'
      resetBuffers(8)
      acqRuntime.status = 'connecting'
      liveEegHub.configure({ device: 'neuracle' })
      liveEegHub.markConnecting('正在自动启动本机 Neuracle 桥接…')
      setStatus('connecting')
      setDetail('正在自动启动本机 Neuracle 桥接…')
      try {
        const ensured = await ensureBridge('neuracle')
        setDetail(
          `${ensured.message ?? '桥接就绪'} → JellyFish ${jfHost}:${jfPort}…`,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatus('error')
        setDetail(msg)
        return
      }

      const client = new NeuracleWsClient({
        url: neuracleWsUrl(),
        host: jfHost,
        port: jfPort,
        sourceSfreq: 250,
        eegChannelNames: neuracleChannelNames(),
        onStatus: (s, d) => {
          if (s === 'connecting') {
            acqRuntime.status = 'connecting'
            setStatus('connecting')
            liveEegHub.markConnecting(d)
          } else if (s === 'live') {
            setStatus((cur) => {
              const next = cur === 'streaming' ? 'streaming' : 'open'
              acqRuntime.status = next
              if (next === 'open') liveEegHub.markOpen(d)
              return next
            })
          } else if (s === 'error') {
            acqRuntime.status = 'error'
            acqRuntime.streaming = false
            streamingRef.current = false
            setStatus('error')
            liveEegHub.markError(d)
          } else if (s === 'closed' || s === 'idle') {
            streamingRef.current = false
            acqRuntime.streaming = false
            acqRuntime.status = 'idle'
            acqRuntime.neuracle = null
            setStatus('idle')
            liveEegHub.markIdle(d ?? '连接已断开')
          }
          if (d) setDetail(d)
        },
        onHello: (hello: NeuracleHello) => {
          const names = hello.channels
          resizeBuffers(names.length)
          setStreamLabels(names)
          setStreamTypes(hello.channel_types ?? [])
          setSampleRate(hello.sample_rate)
          setCatchupClock(hello.sample_rate)
          setVisible(visibleMaskForNames(names))
          streamingRef.current = false
          acqRuntime.streaming = false
          setFeatureLatest(null)
          setFeatureHistory([])
          acqRuntime.status = 'open'
          acqRuntime.device = 'neuracle'
          setStatus('open')
          liveEegHub.configure({
            device: 'neuracle',
            sampleRate: hello.sample_rate,
            channelNames: names,
            detail: `已连接博睿康 ${hello.module || 'Neuracle'}`,
          })
          liveEegHub.markOpen(
            `已连接博睿康 ${hello.module || 'Neuracle'} · ${names.length} 通道 @ ${hello.sample_rate} Hz。点击「开始采集」。`,
          )
          setDetail(
            `已连接博睿康 ${hello.module || 'Neuracle'} · ${names.length} 通道 @ ${hello.sample_rate} Hz。点击「开始采集」。`,
          )
        },
        onBatch: ingestBridgeToHub,
        onError: (message) => setDetail(message),
      })
      neuracleRef.current = client
      acqRuntime.neuracle = client
      client.connect()
    })()
  }

  const ingestBridgeBatch = (batch: {
    values: Float32Array
    samples: number
    channels: number
    packetLoss: number
    packetCount: number
  }) => {
    if (!streamingRef.current) {
      const st = statsRef.current
      st.packetLoss = batch.packetLoss
      st.packetCount = batch.packetCount
      return
    }
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
    const st = statsRef.current
    st.samples += batch.samples
    if (rateHz) st.rateHz = rateHz
    st.packetLoss = batch.packetLoss
    st.packetCount = batch.packetCount
    if (recorderRef.current.recording && !acqRuntime.impedanceActive) {
      const bytes = new Uint8Array(batch.values.buffer, batch.values.byteOffset, batch.values.byteLength)
      recorderRef.current.append(bytes)
    }
  }
  ingestBridgeBatchRef.current = ingestBridgeBatch

  const connectBcigo = () => {
    void (async () => {
      stopDemo()
      bcigoRef.current?.disconnect()
      neuracleRef.current?.disconnect()
      neuracleRef.current = null
      acqRuntime.neuracle = null
      acqRuntime.device = 'bcigo'
      resetBuffers(32)
      acqRuntime.status = 'connecting'
      liveEegHub.configure({ device: 'bcigo' })
      liveEegHub.markConnecting('正在自动启动本机强脑桥接…')
      setStatus('connecting')
      setDetail('正在自动启动本机强脑桥接…')
      try {
        const ensured = await ensureBridge('bcigo')
        const hostHint = bcigoHost.trim()
          ? `${bcigoHost.trim()}${bcigoPort ? `:${bcigoPort}` : ''}`
          : 'mDNS 自动发现'
        setDetail(`${ensured.message ?? '桥接就绪'} → ${hostHint}…`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setStatus('error')
        setDetail(msg)
        return
      }

      const client = new BcigoWsClient({
        url: bcigoWsUrl(),
        host: bcigoHost.trim() || undefined,
        port: bcigoPort === '' ? null : Number(bcigoPort),
        sampleRate: bcigoSampleRate,
        gain: bcigoGain,
        signal: bcigoSignal,
        onStatus: (s, d) => {
          if (s === 'connecting') {
            acqRuntime.status = 'connecting'
            setStatus('connecting')
            liveEegHub.markConnecting(d)
          } else if (s === 'live') {
            setStatus((cur) => {
              const next = cur === 'streaming' ? 'streaming' : 'open'
              acqRuntime.status = next
              if (next === 'open') liveEegHub.markOpen(d)
              return next
            })
          } else if (s === 'error') {
            acqRuntime.status = 'error'
            acqRuntime.streaming = false
            streamingRef.current = false
            setStatus('error')
            liveEegHub.markError(d)
          } else if (s === 'closed' || s === 'idle') {
            streamingRef.current = false
            acqRuntime.streaming = false
            acqRuntime.status = 'idle'
            acqRuntime.bcigo = null
            setStatus('idle')
            liveEegHub.markIdle(d ?? '连接已断开')
          }
          if (d) setDetail(d)
        },
        onHello: (hello: BcigoHello) => {
          const names = hello.channels
          resizeBuffers(names.length)
          setStreamLabels(names)
          setStreamTypes(hello.channel_types ?? [])
          setSampleRate(hello.sample_rate)
          setCatchupClock(hello.sample_rate)
          setVisible(visibleMaskForNames(names))
          streamingRef.current = false
          acqRuntime.streaming = false
          setFeatureLatest(null)
          setFeatureHistory([])
          acqRuntime.status = 'open'
          acqRuntime.device = 'bcigo'
          setStatus('open')
          const readyNote =
            hello.data_ready === false ? '（暂无样本，可关官方 App 后重试）' : ''
          const msg = `已连接强脑 ${hello.module || 'BCIGo'} · ${names.length} 通道 @ ${hello.sample_rate} Hz${readyNote}。点击「开始采集」。`
          liveEegHub.configure({
            device: 'bcigo',
            sampleRate: hello.sample_rate,
            channelNames: names,
            detail: msg,
          })
          liveEegHub.markOpen(msg)
          setDetail(msg)
        },
        onBatch: ingestBridgeToHub,
        onImpedance: (imp) => {
          impedanceSdkRef.current = true
          setImpedanceRows(
            imp.valuesKohm.map((k) => rowFromKohm(k, true, true, '稳定中…')),
          )
          setImpedanceDetail(`阻抗包 #${imp.packetCount}`)
        },
        onImpedanceStatus: (active, message) => {
          acqRuntime.impedanceActive = active
          setImpedanceMeasuring(active)
          if (message) setImpedanceDetail(message)
        },
        onError: (message) => setDetail(message),
      })
      bcigoRef.current = client
      acqRuntime.bcigo = client
      client.connect()
    })()
  }

  const startStream = async () => {
    stopDemo()
    if (acqRuntime.impedanceActive) {
      await stopImpedanceMeasure(true)
    }
    if (device === 'neuracle' || device === 'bcigo') {
      const linked =
        device === 'neuracle' ? Boolean(neuracleRef.current) : Boolean(bcigoRef.current)
      if (!linked || (status !== 'open' && status !== 'streaming')) {
        setDetail('请先连接设备。')
        return
      }
      if (status === 'streaming') return
      writeHeadRef.current = 0
      filledRef.current = 0
      filterRef.current.reset()
      rateWinRef.current = { t0: performance.now(), n: 0, samplesBase: 0 }
      beginRawBridgeStream()
      streamingRef.current = true
      acqRuntime.streaming = true
      acqRuntime.status = 'streaming'
      acqRuntime.device = device
      recorderRef.current.start()
      setRecording(true)
      setRecBytes(0)
      setFeatureLatest(null)
      setFeatureHistory([])
      resetCatchup()
      setCatchupClock(sampleRate)
      statsRef.current = { ...statsRef.current, samples: 0, rateHz: 0 }
      setStats({ ...statsRef.current })
      setStatus('streaming')
      const streamDetail =
        device === 'bcigo'
          ? '采集中：强脑 EEG 写入浏览器内存，停止时下载 BIN。'
          : '采集中：博睿康转发数据写入浏览器内存，停止时下载 BIN。'
      liveEegHub.configure({
        device,
        sampleRate,
        channelNames: streamLabels.length ? streamLabels : liveEegHub.meta.channelNames,
        detail: streamDetail,
      })
      liveEegHub.markStreaming(streamDetail)
      setDetail(streamDetail)
      return
    }

    const t = transportRef.current
    if (!t.connected) {
      setDetail('请先连接串口。')
      return
    }
    resetBuffers(CHANNELS)
    setStreamLabels(cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!))
    setVisible(Array.from({ length: CHANNELS }, () => true))
    setSampleRate(FS)
    setCatchupClock(FS, FRAME_BYTES)
    try {
      await applyHardwareConfig(cfg)
      await t.write(CMD_STOP)
      await sleep(50)
      parserRef.current?.reset()
      await t.write(CMD_START)
      streamingRef.current = true
      acqRuntime.streaming = true
      acqRuntime.status = 'streaming'
      acqRuntime.device = 'omni'
      setStatus('streaming')
      liveEegHub.configure({
        device: 'omni',
        sampleRate: FS,
        channelNames: cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!),
        detail: '采集中：原始 48 字节帧写入浏览器内存，停止时下载 BIN。',
      })
      liveEegHub.markStreaming('采集中：原始 48 字节帧写入浏览器内存，停止时下载 BIN。')
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
    if (acqRuntime.impedanceActive || impedanceMeasuring) {
      await stopImpedanceMeasure(true)
    }
    streamingRef.current = false
    acqRuntime.streaming = false
    resetCatchup()
    if (device === 'omni') {
      try {
        if (transportRef.current.connected) await transportRef.current.write(CMD_STOP)
      } catch {
        /* ignore */
      }
    }
    // 桥接设备：停止采集但保持连接（对齐 OmniBCI「停止」≠「断开」）
    const prefix =
      device === 'neuracle' ? 'neuracle_eeg' : device === 'bcigo' ? 'bcigo_eeg' : 'omni_ads1299'
    const saved = recorderRef.current.stopAndDownload(prefix)
    setRecording(false)
    setRecBytes(0)
    setFeatureLatest(null)
    setFeatureHistory([])
    const stillLinked =
      device === 'omni'
        ? transportRef.current.connected
        : device === 'neuracle'
          ? Boolean(neuracleRef.current)
          : Boolean(bcigoRef.current)
    const nextStatus = stillLinked ? 'open' : 'idle'
    acqRuntime.status = nextStatus
    setStatus(nextStatus)
    const stopDetail = saved
      ? `已停止采集，下载 ${saved.name}（${(saved.bytes / 1024).toFixed(1)} KB）。${stillLinked ? '设备仍连接，可再次开始。' : ''}`
      : stillLinked
        ? '已停止采集；设备仍连接。'
        : '已停止采集。'
    if (stillLinked) liveEegHub.markOpen(stopDetail)
    else liveEegHub.markIdle(stopDetail)
    setDetail(stopDetail)
  }

  const startDemo = () => {
    void disconnect().then(() => {
      acqRuntime.status = 'demo'
      acqRuntime.streaming = true
      streamingRef.current = true
      setStatus('demo')
      setDetail('演示模式：合成多频带 EEG，实时滑窗分析频带与评分。')
      resetBuffers(CHANNELS)
      setStreamLabels([...CHANNEL_NAMES])
      setVisible(Array.from({ length: CHANNELS }, () => true))
      setSampleRate(FS)
      setCatchupClock(FS, FRAME_BYTES)
      liveEegHub.configure({
        device: 'demo',
        sampleRate: FS,
        channelNames: [...CHANNEL_NAMES],
        detail: '演示模式：合成多频带 EEG，实时滑窗分析频带与评分。',
      })
      liveEegHub.markStreaming('演示模式：合成多频带 EEG，实时滑窗分析频带与评分。')
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
        statsRef.current = {
          ...EMPTY_STATS,
          samples,
          rateHz: samples / Math.max(0.001, (performance.now() - t0) / 1000),
          lastSeq: samples - 1,
          mode: 4,
        }
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
    isBridgeDevice(device) || status === 'demo'
      ? streamLabels
      : cfg.labels.map((l, i) => l.trim() || CHANNEL_NAMES[i]!)

  useEffect(() => {
    if (channelLabels.length === visible.length) persistHiddenFromMask(channelLabels, visible)
  }, [visible, channelLabels])

  const impedanceHardware = device === 'omni' && status !== 'demo' ? 'omni' : device === 'bcigo' ? 'bcigo' : 'none'

  const finalizeBinIfRecording = () => {
    if (!recorderRef.current.recording) return
    const prefix =
      device === 'neuracle' ? 'neuracle_eeg' : device === 'bcigo' ? 'bcigo_eeg' : 'omni_ads1299'
    const saved = recorderRef.current.stopAndDownload(prefix)
    setRecording(false)
    setRecBytes(0)
    if (saved) {
      setDetail(`已结束 EEG 记录 ${saved.name}，避免把导联激励写入 BIN。`)
    }
  }

  const openImpedanceDialog = () => {
    const enabled =
      device === 'omni' && status !== 'demo'
        ? cfg.enabled
        : channelLabels.map(() => true)
    const selected = channelLabels.map((_, i) => Boolean(enabled[i]) && impedanceSelected[i] !== false)
    setImpedanceSelected(selected)
    if (device === 'omni') setImpedanceSeriesKohm(impedanceSeriesDefaultKohm(cfg.reference))
    setImpedanceRows(idleImpedanceRows(channelLabels, selected, enabled))
    setImpedanceOpen(true)
    setViewMode('impedance')
  }

  const stopImpedanceMeasure = async (silent = false) => {
    const wasActive = acqRuntime.impedanceActive || impedanceMeasuring
    if (!wasActive) {
      if (!silent) setImpedanceDetail('已停止阻抗检测')
      return
    }
    let error: string | null = null
    try {
      if (device === 'bcigo') {
        bcigoRef.current?.stopImpedance()
      } else if (device === 'omni' && transportRef.current.connected) {
        await transportRef.current.write(CMD_STOP)
        streamingRef.current = false
        acqRuntime.streaming = false
        await sleep(80)
        await transportRef.current.write(cmdLeadOff(0))
        const ack = await waitConfigAck(0xa9)
        if (!leadOffOffAckMatches(ack)) error = 'ADS1299 未确认 LOFF 已关闭'
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      acqRuntime.impedanceActive = false
      impedanceMaskRef.current = 0
      impedanceSdkRef.current = false
      streamingRef.current = false
      acqRuntime.streaming = false
      setImpedanceMeasuring(false)
      const linked =
        device === 'omni'
          ? transportRef.current.connected
          : device === 'bcigo'
            ? Boolean(bcigoRef.current)
            : Boolean(neuracleRef.current)
      const next = linked ? 'open' : 'idle'
      acqRuntime.status = next
      setStatus(next)
    }
    if (error) {
      const msg = `阻抗检测已停止，但关闭确认失败：${error}`
      if (!silent) setImpedanceDetail(msg)
      setDetail(msg)
    } else {
      const msg = device === 'omni' ? '阻抗检测已停止，LOFF 激励已由 ADS1299 读回确认关闭。' : '已停止阻抗检测'
      setImpedanceDetail(msg)
      if (!silent) setDetail(msg)
    }
  }

  const startImpedanceMeasure = async () => {
    setViewMode('impedance')
    setImpedanceOpen(true)
    if (device === 'neuracle' || status === 'demo') {
      setImpedanceDetail('当前设备没有 ADS1299 A9 交流导联脱落，无法测量电极阻抗。')
      return
    }
    const enabled =
      device === 'omni' ? cfgRef.current.enabled : channelLabels.map(() => true)
    const selected = impedanceSelectedRef.current
    let mask = 0
    let nSel = 0
    for (let ch = 0; ch < channelLabels.length; ch++) {
      if (selected[ch] && enabled[ch] !== false) {
        nSel += 1
        if (ch < 32) mask |= 1 << ch
      }
    }
    if (nSel === 0) {
      setImpedanceDetail('请至少勾选一个已启用通道。')
      return
    }

    if (device === 'bcigo') {
      if (!bcigoRef.current || (status !== 'open' && status !== 'streaming')) {
        setImpedanceDetail('请先连接强脑设备。')
        return
      }
      finalizeBinIfRecording()
      streamingRef.current = false
      acqRuntime.streaming = false
      acqRuntime.impedanceActive = true
      impedanceMaskRef.current = mask
      impedanceSdkRef.current = false
      acqRuntime.status = 'open'
      setStatus('open')
      setImpedanceMeasuring(true)
      setImpedanceDetail('正在切换到阻抗检测…')
      setDetail('阻抗检测中（强脑 Lead-Off 6 nA @ 31.25 Hz）。')
      bcigoRef.current.startImpedance()
      return
    }

    const t = transportRef.current
    if (!t.connected) {
      setImpedanceDetail('请先连接串口。')
      return
    }
    const mode = MODE_ITEMS[eegModeRef.current]?.mode ?? 1
    if (mode > 2) {
      setImpedanceDetail('请先切换到 EEG 模式；短路或内部测试模式不能测量电极阻抗。')
      return
    }
    try {
      if (streamingRef.current || recorderRef.current.recording) {
        await t.write(CMD_STOP)
        streamingRef.current = false
        acqRuntime.streaming = false
        finalizeBinIfRecording()
        await sleep(80)
      }
      parserRef.current?.reset()
      await t.write(cmdLeadOff(mask))
      const ack = await waitConfigAck(0xa9)
      const srb2 = cfgRef.current.reference === REFERENCE_SRB2
      if (!leadOffAckMatches(ack, mask, srb2)) {
        throw new Error('固件未确认 LOFF 寄存器。请烧录本版本配套固件后重试。')
      }
      resetBuffers(CHANNELS)
      filterRef.current.reset()
      await t.write(CMD_START)
      streamingRef.current = true
      acqRuntime.streaming = true
      acqRuntime.impedanceActive = true
      acqRuntime.status = 'streaming'
      setStatus('streaming')
      impedanceMaskRef.current = mask
      impedanceSdkRef.current = false
      setImpedanceMeasuring(true)
      const side = srb2 ? 'INxN / LOFF_SENSN' : 'INxP / LOFF_SENSP'
      const msg = `阻抗检测中：mask=0x${mask.toString(16).padStart(2, '0')}，激励端 ${side}。`
      setImpedanceDetail(msg)
      setDetail(msg)
    } catch (err) {
      try {
        if (t.connected) {
          await t.write(CMD_STOP)
          await sleep(50)
          await t.write(cmdLeadOff(0))
          await waitConfigAck(0xa9)
        }
      } catch {
        /* ignore */
      }
      acqRuntime.impedanceActive = false
      impedanceMaskRef.current = 0
      streamingRef.current = false
      acqRuntime.streaming = false
      setImpedanceMeasuring(false)
      const msg = err instanceof Error ? err.message : String(err)
      setImpedanceDetail(`阻抗检测启动失败：${msg}`)
      setDetail(`阻抗检测启动失败：${msg}`)
    }
  }

  useEffect(() => {
    if (device !== 'omni') return
    setImpedanceSeriesKohm(impedanceSeriesDefaultKohm(cfg.reference))
  }, [cfg.reference, device])

  useEffect(() => {
    if (!impedanceMeasuring) return
    const tick = () => {
      if (impedanceSdkRef.current) return
      const n = nChRef.current
      const fs = sampleRate
      const take = Math.min(filledRef.current, Math.max(fs, fs * 4))
      const selected = impedanceSelectedRef.current
      const enabled = device === 'omni' ? cfgRef.current.enabled : selected.map(() => true)
      const series = device === 'omni' ? impedanceSeriesRef.current : 0
      const rows: ImpedanceRowState[] = []
      for (let ch = 0; ch < n; ch++) {
        const on = selected[ch] !== false && enabled[ch] !== false
        if (!on) {
          rows.push(rowFromKohm(null, Boolean(selected[ch]), enabled[ch] !== false))
          continue
        }
        if (filledRef.current < fs) {
          rows.push(rowFromKohm(null, true, true, '稳定中…'))
          continue
        }
        const buf = rawRingRef.current[ch]
        if (!buf) {
          rows.push(rowFromKohm(null, true, true, '数据不足'))
          continue
        }
        const y = copyLatestChannel(buf, writeHeadRef.current, filledRef.current, take)
        const v = copyLatestValid(validRingRef.current, writeHeadRef.current, filledRef.current, take)
        const est = estimateLeadOffKohm(y, v, series, fs)
        rows.push({
          selected: true,
          enabled: true,
          kohm: est.kohm,
          text: est.label,
          quality: est.quality,
          color: est.color,
        })
      }
      setImpedanceRows(rows)
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => clearInterval(id)
  }, [impedanceMeasuring, device, sampleRate])

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

  const deviceLinked = status === 'open' || status === 'streaming'
  const deviceBusy = status === 'connecting' || status === 'streaming'

  const connectDevice = () => {
    if (device === 'omni') void connect()
    else if (device === 'neuracle') connectNeuracle()
    else connectBcigo()
  }

  const plotVisible =
    viewMode === 'single'
      ? channelLabels.map((_, i) => i === Math.min(singleChannel, Math.max(0, channelLabels.length - 1)))
      : visible
  const filterLabel = viewFiltered
    ? `${bandLoHz}–${bandHiHz} Hz${useNotch ? ' + 50/100 Hz 谐波陷波' : ''}`
    : '未滤波（不修改记录数据）'
  const lagSec = liveLagSec()
  const catchingUp = lagSec > LIVE_CATCHUP_THRESHOLD_S

  return (
    <div className="acq-omni">
      <div className="acq-toolbar">
        <Link to="/" className="acq-home">
          ← 首页
        </Link>
        <div className="acq-brand">
          <strong>全域智能</strong>
          <span>脑电测试 · EEG</span>
        </div>
        <label className="acq-check">
          <input
            type="checkbox"
            checked={viewFiltered}
            onChange={(e) => setViewFiltered(e.target.checked)}
          />
          滤波后
        </label>
        <label className="acq-field">
          时间窗
          <input
            className="input"
            type="number"
            min={1}
            max={60}
            step={1}
            value={windowSec}
            onChange={(e) => setWindowSec(Math.max(1, Number(e.target.value) || 10))}
          />
          <span className="muted">s</span>
        </label>
        <label className="acq-field">
          灵敏度
          <input
            className="input"
            type="number"
            min={1}
            max={device === 'bcigo' ? 100000 : 10000}
            step={10}
            value={yScaleUv}
            onChange={(e) => setYScaleUv(Math.max(1, Number(e.target.value) || 100))}
          />
          <span className="muted">uV/cm</span>
        </label>
        <button
          type="button"
          className="btn"
          onClick={status === 'demo' ? () => void disconnect() : startDemo}
        >
          {status === 'demo' ? '停止演示' : '演示波形'}
        </button>
        {recording ? (
          <span className="chip" style={{ color: 'var(--accent-2)' }}>
            录制 {(recBytes / 1024).toFixed(1)} KB
          </span>
        ) : null}
      </div>

      <section className="acq-group">
        <div className="acq-group-title">
          {device === 'omni' ? '串口控制' : device === 'neuracle' ? 'JellyFish 控制' : 'Wi‑Fi 控制'}
        </div>
        <div className="acq-bar">
          <label className="acq-field">
            设备
            <select
              className="select"
              value={device}
              disabled={deviceBusy}
              onChange={(e) => void switchDevice(e.target.value as DeviceKind)}
            >
              <option value="omni">OmniBCI USB</option>
              <option value="neuracle">博睿康 Neuracle</option>
              <option value="bcigo">强脑 BCIGo</option>
            </select>
          </label>
          {device === 'neuracle' ? (
            <>
              <label className="acq-field">
                Host
                <input
                  className="input"
                  value={jfHost}
                  disabled={deviceBusy}
                  onChange={(e) => setJfHost(e.target.value)}
                />
              </label>
              <label className="acq-field">
                Port
                <input
                  className="input"
                  type="number"
                  value={jfPort}
                  disabled={deviceBusy}
                  onChange={(e) => setJfPort(Number(e.target.value) || 8712)}
                />
              </label>
              <label className="acq-field">
                通道
                <select
                  className="select"
                  value={neuracleMontage}
                  disabled={deviceBusy}
                  onChange={(e) => setNeuracleMontage(e.target.value as 'all' | '59' | 'motor8')}
                >
                  <option value="all">全部转发</option>
                  <option value="59">59 导头皮</option>
                  <option value="motor8">运动区 8 导</option>
                </select>
              </label>
            </>
          ) : null}
          {device === 'bcigo' ? (
            <>
              <label className="acq-field">
                Host
                <input
                  className="input"
                  placeholder="空=mDNS"
                  value={bcigoHost}
                  disabled={deviceBusy}
                  onChange={(e) => setBcigoHost(e.target.value)}
                />
              </label>
              <label className="acq-field">
                Port
                <input
                  className="input"
                  type="number"
                  placeholder="自动"
                  value={bcigoPort}
                  disabled={deviceBusy}
                  onChange={(e) => {
                    const v = e.target.value
                    setBcigoPort(v === '' ? '' : Number(v) || '')
                  }}
                />
              </label>
              <label className="acq-field">
                采样率
                <select
                  className="select"
                  value={bcigoSampleRate}
                  disabled={deviceBusy}
                  onChange={(e) => setBcigoSampleRate(Number(e.target.value) || 250)}
                >
                  <option value={250}>250</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                </select>
              </label>
              <label className="acq-field">
                Gain
                <select
                  className="select"
                  value={bcigoGain}
                  disabled={deviceBusy}
                  onChange={(e) => setBcigoGain(Number(e.target.value) || 6)}
                >
                  {[1, 2, 4, 6, 8, 12, 24].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <label className="acq-field">
                信号
                <select
                  className="select"
                  value={bcigoSignal}
                  disabled={deviceBusy}
                  onChange={(e) =>
                    setBcigoSignal(e.target.value as 'normal' | 'test' | 'shorted' | 'mvdd')
                  }
                >
                  <option value="normal">NORMAL</option>
                  <option value="test">TEST</option>
                  <option value="shorted">SHORTED</option>
                  <option value="mvdd">MVDD</option>
                </select>
              </label>
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={deviceBusy || deviceLinked || status === 'demo' || (device === 'omni' && !supported)}
            onClick={connectDevice}
          >
            {device === 'omni' ? '打开串口' : '连接'}
          </button>
          <button type="button" className="btn btn-primary" disabled={status !== 'open' && !impedanceMeasuring} onClick={() => void startStream()}>
            开始采集
          </button>
          <button type="button" className="btn" disabled={status !== 'streaming'} onClick={() => void stopStream()}>
            停止
          </button>
          <button
            type="button"
            className="btn"
            disabled={!deviceLinked || status === 'streaming'}
            onClick={() => void disconnect()}
          >
            {device === 'omni' ? '断开串口' : '断开'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={openImpedanceDialog}
          >
            阻抗检测
          </button>
          {device === 'omni' ? (
            <>
              <label className="acq-field">
                参考
                <select
                  className="select"
                  value={cfg.reference}
                  disabled={status === 'streaming'}
                  onChange={(e) => updateCfg({ reference: Number(e.target.value) as ReferenceMode })}
                >
                  <option value={REFERENCE_SRB1}>SRB1（信号 INxP）</option>
                  <option value={REFERENCE_SRB2}>SRB2（信号 INxN）</option>
                </select>
              </label>
              <button
                type="button"
                className="btn"
                disabled={status !== 'open'}
                onClick={() =>
                  void applyHardwareConfig(cfg).then(() => setDetail('已下发参考 / 通道配置。'))
                }
              >
                应用参考
              </button>
            </>
          ) : null}
          <span className="acq-status">{detail}</span>
        </div>
      </section>

      <section className="acq-group">
        <div className="acq-group-title">滤波设置</div>
        <div className="acq-bar">
          <label className="acq-field">
            高通
            <input
              className="input"
              type="number"
              min={0.1}
              max={30}
              step={0.5}
              value={bandLoHz}
              onChange={(e) => setBandLoHz(Math.min(Number(e.target.value) || 0.5, bandHiHz - 0.5))}
            />
            <span className="muted">Hz</span>
          </label>
          <label className="acq-field">
            低通
            <input
              className="input"
              type="number"
              min={10}
              max={Math.max(20, Math.floor(sampleRate / 2) - 1)}
              step={1}
              value={bandHiHz}
              onChange={(e) => setBandHiHz(Math.max(Number(e.target.value) || 50, bandLoHz + 0.5))}
            />
            <span className="muted">Hz</span>
          </label>
          <label className="acq-check">
            <input type="checkbox" checked={useNotch} onChange={(e) => setUseNotch(e.target.checked)} />
            50/100 Hz 谐波陷波
          </label>
          {isBridgeDevice(device) ? (
            <>
              <button type="button" className="btn" onClick={() => setVisible(channelLabels.map(() => true))}>
                全部显示
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setVisible(
                    channelLabels.map((n) =>
                      NEURACLE_DEFAULT_VISIBLE.map((x) => x.toUpperCase()).includes(
                        n.replace(/\s+/g, '').toUpperCase(),
                      ),
                    ),
                  )
                }
              >
                仅运动区
              </button>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setVisible(
                    channelLabels.map((_, i) => {
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
                className="btn"
                onClick={() =>
                  setVisible((v) => {
                    const n = v.length === channelLabels.length ? [...v] : channelLabels.map(() => true)
                    channelLabels.forEach((name, i) => {
                      if (name.replace(/\s+/g, '').toUpperCase() === 'FT10') n[i] = false
                    })
                    return n
                  })
                }
              >
                关闭 FT10
              </button>
            </>
          ) : null}
        </div>
      </section>

      <div className="acq-tabs" role="tablist" aria-label="视图">
        {(
          [
            ['wave', '波形'],
            ['single', '单通道放大'],
            ['psd', '频谱 PSD'],
            ['impedance', '阻抗检测'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={viewMode === id}
            className={`acq-tab${viewMode === id ? ' is-active' : ''}`}
            onClick={() => setViewMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="acq-stage">
        {viewMode === 'wave' || viewMode === 'single' ? (
          <>
            {viewFiltered ? (
              <div className="acq-banner">━ 滤波显示副本（不修改原始数据） · {filterLabel}</div>
            ) : (
              <div className="acq-banner">━ 原始未滤波显示 · BIN 仍写原始样本</div>
            )}
            {viewMode === 'single' ? (
              <div className="acq-bar" style={{ padding: '6px 8px', borderBottom: '1px solid #d8dde3' }}>
                <label className="acq-field">
                  放大通道
                  <select
                    className="select"
                    value={Math.min(singleChannel, Math.max(0, channelLabels.length - 1))}
                    onChange={(e) => setSingleChannel(Number(e.target.value))}
                  >
                    {channelLabels.map((name, i) => (
                      <option key={`${name}-${i}`} value={i}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="acq-status" style={{ fontWeight: 600 }}>
                  {channelLabels[singleChannel] ?? `CH${singleChannel + 1}`} | {statusLabel}
                </span>
                <button type="button" className="btn" onClick={() => setViewMode('wave')}>
                  返回多通道
                </button>
              </div>
            ) : null}
            <div className="acq-wave-row">
              {viewMode === 'wave' ? (
                <ChannelRail
                  names={channelLabels}
                  visible={visible}
                  yScaleUv={yScaleUv}
                  omniCfg={device === 'omni' && status !== 'demo' ? cfg : undefined}
                  onToggle={(i) =>
                    setVisible((v) => {
                      const n = v.length === channelLabels.length ? [...v] : channelLabels.map(() => true)
                      n[i] = !n[i]
                      return n
                    })
                  }
                  onOpen={(i) => {
                    if (device === 'omni' && status !== 'demo') setChannelDialog(i)
                    else {
                      setVisible((v) => {
                        const n = v.length === channelLabels.length ? [...v] : channelLabels.map(() => true)
                        n[i] = !n[i]
                        return n
                      })
                    }
                  }}
                />
              ) : null}
              <div className="acq-plot">
                <WaveformCanvas
                  getSnapshot={getSnapshot}
                  channelNames={channelLabels}
                  visibleChannels={plotVisible}
                  yScaleUv={yScaleUv}
                  windowSec={windowSec}
                  sampleRate={sampleRate}
                  fill
                  theme="omni"
                  showChannelLabels={viewMode === 'single'}
                  onChannelDblClick={(i) => {
                    setSingleChannel(i)
                    setViewMode('single')
                  }}
                />
              </div>
            </div>
          </>
        ) : viewMode === 'psd' ? (
          <div className="acq-plot">
            <FftCanvas
              getSnapshot={getSnapshot}
              channelNames={channelLabels}
              visibleChannels={visible}
              windowSec={windowSec}
              sampleRate={sampleRate}
              fMaxHz={Math.min(65, Math.floor(sampleRate / 2))}
              fill
              theme="omni"
            />
          </div>
        ) : (
          <div style={{ padding: 12, overflow: 'auto' }}>
            <ImpedancePanel
              hardware={impedanceHardware}
              channelNames={channelLabels}
              rows={
                impedanceRows.length === channelLabels.length
                  ? impedanceRows
                  : idleImpedanceRows(
                      channelLabels,
                      impedanceSelected,
                      device === 'omni' ? cfg.enabled : channelLabels.map(() => true),
                    )
              }
              measuring={impedanceMeasuring}
              seriesKohm={impedanceSeriesKohm}
              onSeriesKohm={setImpedanceSeriesKohm}
              detail={impedanceDetail}
              onStart={() => void startImpedanceMeasure()}
              onStop={() => void stopImpedanceMeasure()}
              onToggle={(i, selected) =>
                setImpedanceSelected((prev) => {
                  const n = prev.length === channelLabels.length ? [...prev] : channelLabels.map(() => true)
                  n[i] = selected
                  return n
                })
              }
            />
          </div>
        )}
      </div>

      <details className="acq-extra">
        <summary>特征监控 / 工作模式（实验页共用勾选）</summary>
        {device === 'omni' ? (
          <div className="acq-bar" style={{ marginBottom: 8 }}>
            <label className="acq-field">
              工作模式
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
            <label className="acq-field">
              全局 PGA
              <select
                className="select"
                value={cfg.gains[0]}
                disabled={status === 'streaming'}
                onChange={(e) => {
                  const g = Number(e.target.value)
                  updateCfg((c) => ({ ...c, gains: Array.from({ length: CHANNELS }, () => g) }))
                }}
              >
                {VALID_GAINS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="acq-field">
              通道名预设
              <select className="select" value={montageId} onChange={(e) => applyMontage(e.target.value)}>
                <option value="custom">自定义</option>
                {MONTAGE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="acq-field">
              特征滑窗
              <input
                className="input"
                type="number"
                min={0.5}
                max={4}
                step={0.25}
                value={featureWindowSec}
                onChange={(e) => setFeatureWindowSec(Number(e.target.value) || 1)}
              />
              <span className="muted">s</span>
            </label>
          </div>
        ) : (
          <div className="acq-bar" style={{ marginBottom: 8 }}>
            <label className="acq-field">
              特征滑窗
              <input
                className="input"
                type="number"
                min={0.5}
                max={4}
                step={0.25}
                value={featureWindowSec}
                onChange={(e) => setFeatureWindowSec(Number(e.target.value) || 1)}
              />
              <span className="muted">s</span>
            </label>
          </div>
        )}
        <FeaturePanel
          latest={featureLatest}
          history={featureHistory}
          analyzing={status === 'streaming' || status === 'demo'}
          enabledIds={enabledFeatures}
          onEnabledChange={onEnabledFeaturesChange}
        />
      </details>

      <ModelServicePanel />

      <div className="acq-statusbar">
        <span>
          状态 <strong>{statusLabel}</strong>
        </span>
        <span>
          速率 <strong>{stats.rateHz ? `${stats.rateHz.toFixed(1)} Hz` : '—'}</strong>
        </span>
        <span>
          样本 <strong>{stats.samples.toLocaleString()}</strong>
        </span>
        <span>
          通道 <strong>{nChannels}</strong>
        </span>
        <span>
          滤波 <strong>{filterLabel}</strong>
        </span>
        <span>
          积压 <strong>{lagSec > 0.005 ? `${lagSec.toFixed(2)} s` : '0'}</strong>
        </span>
        {catchingUp ? <span className="acq-catchup">追帧中</span> : null}
        {device === 'omni' ? (
          <>
            <span>CRC {stats.crcBad}</span>
            <span>gaps {stats.seqGaps}</span>
            <span>Q {stats.queueDepth}</span>
            <span>
              饱和{' '}
              <strong>
                {stats.samples
                  ? `${((100 * stats.saturation) / Math.max(1, stats.samples * Math.max(1, cfg.enabled.filter(Boolean).length))).toFixed(4)}%`
                  : '—'}
              </strong>
            </span>
          </>
        ) : (
          <span>
            包 {stats.packetCount} · loss {stats.packetLoss}
          </span>
        )}
      </div>

      {impedanceOpen ? (
        <ImpedancePanel
          dialog
          hardware={impedanceHardware}
          channelNames={channelLabels}
          rows={
            impedanceRows.length === channelLabels.length
              ? impedanceRows
              : idleImpedanceRows(
                  channelLabels,
                  impedanceSelected,
                  device === 'omni' ? cfg.enabled : channelLabels.map(() => true),
                )
          }
          measuring={impedanceMeasuring}
          seriesKohm={impedanceSeriesKohm}
          onSeriesKohm={setImpedanceSeriesKohm}
          detail={impedanceDetail}
          onStart={() => void startImpedanceMeasure()}
          onStop={() => void stopImpedanceMeasure()}
          onToggle={(i, selected) =>
            setImpedanceSelected((prev) => {
              const n = prev.length === channelLabels.length ? [...prev] : channelLabels.map(() => true)
              n[i] = selected
              return n
            })
          }
          onClose={() => {
            setImpedanceOpen(false)
            if (acqRuntime.impedanceActive || impedanceMeasuring) void stopImpedanceMeasure(true)
          }}
        />
      ) : null}

      {channelDialog != null && device === 'omni' ? (
        <ChannelSettingsDialog
          index={channelDialog}
          name={channelLabels[channelDialog] ?? `CH${channelDialog + 1}`}
          cfg={cfg}
          reference={cfg.reference}
          streaming={status === 'streaming'}
          onClose={() => setChannelDialog(null)}
          onChange={updateCfg}
          onApply={(next) =>
            void applyHardwareConfig(next).then(() => setDetail('已下发通道配置。'))
          }
        />
      ) : null}
    </div>
  )
}
