import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { liveEegHub } from '../../lib/eeg/liveHub'
import { useLiveEeg } from '../../lib/eeg/useLiveEeg'
import {
  TETRIS_LIVE_STEP_SEC,
  LIVE_PREDICTION_MAX_AGE_MS,
  ensureModelService,
  modelRuntimeHub,
  modelServiceStatus,
  reveLiveHopMatches,
  useTemporalFilter,
} from '../../lib/model-runtime'
import { Slider } from '../../lib/ui/Slider'
import {
  SMR_WINDOW_SEC,
  alphaPower,
  copyRecentSamples,
  laplacianTrace,
  resolveLaplacianMontage,
  smrFeatures,
  type TrialOutcome,
} from '../smr-adapt/smrControl'
import {
  RunningNorm,
  UD_CENTER_Y,
  UD_REST_SEC,
  UD_TICK_SEC,
  applyDeadzone,
  clampGain,
  decayToward,
  keyboardZV,
  loadGain,
  mixControl,
  nextTarget,
  pushTrail,
  resolveUdTarget,
  saveGain,
  stepUdY,
  udBars,
  udIntent,
  type UdDir,
} from './engine'
import './smrUd.css'

function snapCenter(yRef: { current: number }, setY: (y: number) => void, setTrail: (y: number[]) => void) {
  yRef.current = UD_CENTER_Y
  setY(UD_CENTER_Y)
  setTrail([UD_CENTER_Y])
}

export function SmrUdPage() {
  const [y, setY] = useState(UD_CENTER_Y)
  const [trail, setTrail] = useState<number[]>([UD_CENTER_Y])
  const [zV, setZV] = useState(0)
  const [target, setTarget] = useState<UdDir>(() => nextTarget(null, Math.random))
  const [flash, setFlash] = useState<TrialOutcome | null>(null)
  const [resting, setResting] = useState(false)
  const [gain, setGain] = useState(loadGain)
  const { filterRef: temporalFilterRef } = useTemporalFilter(TETRIS_LIVE_STEP_SEC)
  const yRef = useRef(UD_CENTER_Y)
  const zRef = useRef(0)
  const keysRef = useRef({ up: false, down: false })
  const targetRef = useRef<UdDir>(target)
  const startedAtRef = useRef(performance.now())
  const restUntilRef = useRef(0)
  const restingRef = useRef(false)
  const gainRef = useRef(gain)
  const flashTimerRef = useRef(0)
  const vertNorm = useRef(new RunningNorm())
  const rngRef = useRef(Math.random)
  const eeg = useLiveEeg()

  targetRef.current = target
  gainRef.current = gain
  restingRef.current = resting

  useEffect(() => {
    saveGain(gain)
  }, [gain])

  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      try {
        const status = await modelServiceStatus(ac.signal)
        if (ac.signal.aborted) return
        if (status.running && status.task === 'smr_control') {
          const hopOk = reveLiveHopMatches(status.stepSec, TETRIS_LIVE_STEP_SEC)
          if (hopOk) {
            modelRuntimeHub.setEnabled(true)
            modelRuntimeHub.connect()
            if (status.owned) return
          }
        }
        await ensureModelService({
          backend: 'reve',
          task: 'smr_control',
          stepSec: TETRIS_LIVE_STEP_SEC,
          force: Boolean(
            status.running &&
              (!status.owned ||
                status.task !== 'smr_control' ||
                !reveLiveHopMatches(status.stepSec, TETRIS_LIVE_STEP_SEC)),
          ),
          signal: ac.signal,
        })
        if (ac.signal.aborted) return
        modelRuntimeHub.setEnabled(true)
        modelRuntimeHub.connect()
      } catch {
        if (ac.signal.aborted) return
      }
    })()
    return () => ac.abort()
  }, [])

  const montage = useMemo(
    () => resolveLaplacianMontage(eeg.meta.channelNames),
    [eeg.meta.channelNames],
  )
  const live = eeg.live

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (event.code === 'ArrowUp' || event.code === 'KeyW') {
        event.preventDefault()
        keysRef.current.up = true
      }
      if (event.code === 'ArrowDown' || event.code === 'KeyS') {
        event.preventDefault()
        keysRef.current.down = true
      }
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.code === 'ArrowUp' || event.code === 'KeyW') keysRef.current.up = false
      if (event.code === 'ArrowDown' || event.code === 'KeyS') keysRef.current.down = false
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  useEffect(() => {
    const spawnNext = (outcome: TrialOutcome) => {
      snapCenter(yRef, setY, setTrail)
      const next = nextTarget(targetRef.current, rngRef.current)
      targetRef.current = next
      setTarget(next)
      restingRef.current = true
      restUntilRef.current = performance.now() + UD_REST_SEC * 1000
      setResting(true)
      setFlash(outcome)
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => setFlash(null), 280)
    }

    const id = window.setInterval(() => {
      const now = performance.now()
      const pred = modelRuntimeHub.latestObservation(LIVE_PREDICTION_MAX_AGE_MS)
      let neural = decayToward(zRef.current, UD_TICK_SEC)
      if (pred && pred.probabilities.length === pred.class_names.length) {
        const decision = temporalFilterRef.current.observePrediction(pred)
        neural = udBars(decision.classNames, decision.probabilities).zV
      } else if (live && montage) {
        const { buffers, writeHead, filled, sampleRate } = liveEegHub.ring
        const n = Math.round(sampleRate * SMR_WINDOW_SEC)
        const c3 = copyRecentSamples(buffers[montage.c3]!, writeHead, filled, n)
        const c4 = copyRecentSamples(buffers[montage.c4]!, writeHead, filled, n)
        if (c3.length >= 20 && c4.length >= 20) {
          const nC3 = montage.neighborsC3.map((idx) =>
            copyRecentSamples(buffers[idx]!, writeHead, filled, n),
          )
          const nC4 = montage.neighborsC4.map((idx) =>
            copyRecentSamples(buffers[idx]!, writeHead, filled, n),
          )
          const raw = smrFeatures(
            alphaPower(laplacianTrace(c3, nC3), sampleRate),
            alphaPower(laplacianTrace(c4, nC4), sampleRate),
          )
          vertNorm.current.push(raw.vert)
          neural = vertNorm.current.z(raw.vert)
        }
      }
      const mixed = mixControl(neural, keyboardZV(keysRef.current.up, keysRef.current.down))
      const drive = applyDeadzone(mixed)
      zRef.current = drive
      setZV(drive)

      if (restingRef.current) {
        if (yRef.current !== UD_CENTER_Y) snapCenter(yRef, setY, setTrail)
        if (now >= restUntilRef.current) {
          restingRef.current = false
          setResting(false)
          startedAtRef.current = now
        }
        return
      }

      const nextY = stepUdY(yRef.current, drive, UD_TICK_SEC, gainRef.current)
      yRef.current = nextY
      setY(nextY)
      setTrail((prev) => pushTrail(prev, nextY))

      const elapsed = (now - startedAtRef.current) / 1000
      const outcome = resolveUdTarget(nextY, targetRef.current, elapsed)
      if (outcome) spawnNext(outcome)
    }, Math.round(UD_TICK_SEC * 1000))
    return () => {
      window.clearInterval(id)
      window.clearTimeout(flashTimerRef.current)
    }
  }, [live, montage, temporalFilterRef])

  const intent = udIntent(zV)
  const meter = Math.max(-1, Math.min(1, zV / 1.6))

  return (
    <div className="smrud-page">
      <Link to="/" className="smrud-back">
        ←
      </Link>
      <div className="smrud-gain">
        <Slider
          label="灵敏度"
          value={gain}
          min={0.08}
          max={1}
          step={0.02}
          format={(value) => value.toFixed(2)}
          onChange={(value) => setGain(clampGain(value))}
        />
      </div>
      <div className="smrud-arena-wrap">
        <div className="smrud-meter" aria-hidden>
          <div className="smrud-meter-mid" />
          {meter >= 0 ? (
            <div className="smrud-meter-fill is-up" style={{ height: `${meter * 50}%` }} />
          ) : (
            <div className="smrud-meter-fill is-down" style={{ height: `${-meter * 50}%` }} />
          )}
        </div>
        <div className={`smrud-shaft${flash ? ` is-${flash}` : ''}`}>
          <div className="smrud-zone is-up" />
          <div className="smrud-zone is-down" />
          {!resting && target ? <div className={`smrud-target is-${target}`} /> : null}
          {trail.map((item, index) => (
            <div
              key={`${index}-${item.toFixed(3)}`}
              className="smrud-trail"
              style={{
                top: `${(1 - item) * 100}%`,
                opacity: ((index + 1) / trail.length) * 0.28,
              }}
            />
          ))}
          <div className={`smrud-cursor is-${intent}`} style={{ top: `${(1 - y) * 100}%` }} />
        </div>
      </div>
    </div>
  )
}
