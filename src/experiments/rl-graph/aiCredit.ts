import { neighbors, type Graph } from './graph'
import { getQ, setQ, type QTable } from './qlearning'
import type { TamerTraceStep } from './tamer'

export interface LlmApiConfig {
  endpoint: string
  apiKey: string
  model: string
  useLocal: boolean
}

export interface QCandidate {
  /** Opaque id shown to the model (e..g. C1). */
  id: string
  state: number
  action: number
  currentQ: number
  /** Just executed by the agent. */
  justTaken?: boolean
  /** How many steps ago in the credit window (0 = newest). */
  age?: number
  role: 'executed' | 'sibling' | 'trace'
}

export interface AiQUpdate {
  id: string
  q: number
}

export interface AiCreditResult {
  updates: AiQUpdate[]
  provider: 'openai' | 'local'
  rawText?: string
  reasoning?: string
  latencyMs: number
}

const STORAGE_KEY = 'passive-bci.llm.api'
const LEGACY_STORAGE_KEY = 'passive-bci.draw-guess.api'

export const DEFAULT_LLM_CONFIG: LlmApiConfig = {
  endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
  apiKey: '',
  model: 'kimi-for-coding',
  useLocal: true,
}

export function normalizeLlmEndpoint(endpoint: string): string {
  const url = endpoint.trim().replace(/\/+$/, '')
  if (!url) return DEFAULT_LLM_CONFIG.endpoint
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`
  if (/\/coding$/i.test(url)) return `${url}/v1/chat/completions`
  return url
}

export function normalizeApiKey(apiKey: string): string {
  return apiKey.trim().replace(/^Bearer\s+/i, '').replace(/\s+/g, '')
}

function parseStoredConfig(raw: string | null): LlmApiConfig | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LlmApiConfig>
    return {
      ...DEFAULT_LLM_CONFIG,
      ...parsed,
      endpoint: normalizeLlmEndpoint(parsed.endpoint ?? DEFAULT_LLM_CONFIG.endpoint),
      apiKey: normalizeApiKey(parsed.apiKey ?? ''),
      useLocal: parsed.useLocal ?? !parsed.apiKey,
    }
  } catch {
    return null
  }
}

export function loadLlmConfig(): LlmApiConfig {
  return (
    parseStoredConfig(localStorage.getItem(STORAGE_KEY)) ??
    parseStoredConfig(localStorage.getItem(LEGACY_STORAGE_KEY)) ?? {
      ...DEFAULT_LLM_CONFIG,
    }
  )
}

export function saveLlmConfig(config: LlmApiConfig): void {
  const payload = JSON.stringify({
    ...config,
    endpoint: normalizeLlmEndpoint(config.endpoint),
    apiKey: normalizeApiKey(config.apiKey),
  })
  localStorage.setItem(STORAGE_KEY, payload)
  // Keep draw-guess key in sync so one paste works across experiments.
  localStorage.setItem(LEGACY_STORAGE_KEY, payload)
}

function temperatureFor(config: LlmApiConfig): number {
  return /api\.kimi\.com|kimi-for-coding|^k3/i.test(`${config.endpoint} ${config.model}`)
    ? 1
    : 0.2
}

function extractJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
    .trim()

  const attempts = [cleaned]
  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(cleaned.slice(firstBrace, lastBrace + 1))
  }
  const updateBlock = cleaned.match(/\{[\s\S]*"updates"\s*:\s*\[[\s\S]*?\][\s\S]*\}/)
  if (updateBlock) attempts.unshift(updateBlock[0])

  let lastError: unknown
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模型未返回可解析 JSON')
}

/**
 * Build opaque local candidates: just-taken edge, siblings from same state,
 * and optional recent credit-window steps. Never includes full graph / coords / goal.
 */
export function buildQCandidates(
  table: QTable,
  graph: Graph,
  pending: { from: number; to: number },
  trace: readonly TamerTraceStep[],
  creditWindow = 1,
): QCandidate[] {
  const candidates: QCandidate[] = []
  const seen = new Set<string>()
  const push = (
    c: Omit<QCandidate, 'id' | 'currentQ'> & { currentQ?: number },
  ) => {
    const key = `${c.state}->${c.action}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({
      ...c,
      id: `C${candidates.length + 1}`,
      currentQ: c.currentQ ?? getQ(table, c.state, c.action),
    })
  }

  push({
    state: pending.from,
    action: pending.to,
    justTaken: true,
    age: 0,
    role: 'executed',
  })

  for (const nb of neighbors(graph, pending.from)) {
    if (nb === pending.to) continue
    push({
      state: pending.from,
      action: nb,
      role: 'sibling',
    })
  }

  const window = Math.max(1, Math.floor(creditWindow))
  const recent = trace.slice(0, -1).slice(-(window - 1))
  for (let i = recent.length - 1; i >= 0; i--) {
    const step = recent[i]!
    const age = recent.length - i
    push({
      state: step.state,
      action: step.action,
      age,
      role: 'trace',
    })
  }

  return candidates
}

export function applyAiQUpdates(
  table: QTable,
  candidates: readonly QCandidate[],
  updates: readonly AiQUpdate[],
): number {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  let applied = 0
  for (const u of updates) {
    const c = byId.get(u.id)
    if (!c) continue
    if (!Number.isFinite(u.q)) continue
    const q = Math.max(-2, Math.min(2, u.q))
    setQ(table, c.state, c.action, q)
    applied++
  }
  return applied
}

/** Offline heuristic when no API key: pull executed toward rating, nudge siblings away. */
export function localAiAssign(
  candidates: readonly QCandidate[],
  rating: number,
  text: string,
): AiCreditResult {
  const t0 = performance.now()
  const positivity =
    /好|对|近|棒|聪明|正确|可以|不错|接近/.test(text) ? 0.15 :
    /差|错|远|离谱|不对|糟糕|回退/.test(text) ? -0.15 : 0
  const target = Math.max(-1, Math.min(1, rating + positivity))

  const updates: AiQUpdate[] = candidates.map((c) => {
    if (c.role === 'executed' || c.justTaken) {
      const blend = 0.55 * target + 0.45 * c.currentQ
      return { id: c.id, q: Number(blend.toFixed(3)) }
    }
    if (c.role === 'sibling') {
      // Contrastive: if positive feedback, slightly suppress unused siblings.
      const nudge = target > 0 ? -0.08 * target : 0.05 * Math.abs(target)
      return { id: c.id, q: Number((c.currentQ + nudge).toFixed(3)) }
    }
    // Older trace: soft credit smear
    const age = c.age ?? 1
    const w = 0.5 ** age
    const blend = c.currentQ + w * 0.35 * (target - c.currentQ)
    return { id: c.id, q: Number(blend.toFixed(3)) }
  })

  return {
    updates,
    provider: 'local',
    rawText: JSON.stringify({ updates }, null, 2),
    reasoning: '本地启发式：把评分/文字极性映射到刚执行动作，并对兄弟动作做对比抑制。',
    latencyMs: Math.round(performance.now() - t0),
  }
}

function formatCandidatesForPrompt(candidates: readonly QCandidate[]): string {
  return candidates
    .map((c) => {
      const tags: string[] = []
      if (c.justTaken || c.role === 'executed') tags.push('JUST_TAKEN')
      if (c.role === 'sibling') tags.push('SIBLING_SAME_STATE')
      if (c.role === 'trace') tags.push(`TRACE_AGE_${c.age ?? '?'}`)
      return `- ${c.id}: current_Q=${c.currentQ.toFixed(3)} [${tags.join(', ') || c.role}]`
    })
    .join('\n')
}

const SYSTEM_PROMPT = [
  '你是表格强化学习里的「信用分配 / Q 赋值」助手。',
  '智能体在一张未知图上走步；你看不到完整图、节点坐标、邻接表或终点位置。',
  '你只能看到：人类评分、可选文字反馈、以及若干局部动作的当前 Q 候选（用 C1/C2… 匿名编号）。',
  '请根据反馈为这些候选分配新的 Q 值（建议范围约 [-1, 1]，必要时可略超出但勿超过 [-2, 2]）。',
  '原则示意（请自行理解，非硬规则）：',
  '- 高分 / 正面文字 → 提高 JUST_TAKEN；可略降同状态未选兄弟动作（对比）。',
  '- 低分 / 负面文字 → 降低 JUST_TAKEN；必要时抬高或保留其他候选。',
  '- TRACE_AGE_* 是更早的步，信用应随年龄衰减。',
  '先可简短推理，末尾必须输出 JSON：',
  '{"updates":[{"id":"C1","q":0.0}]}',
  'updates 应覆盖你认为需要改动的候选；未列出的保持原值。',
].join('\n')

export async function requestAiQAssignment(opts: {
  config: LlmApiConfig
  candidates: readonly QCandidate[]
  rating: number
  feedbackText: string
  reachedGoal: boolean
  fallbackLocal?: boolean
}): Promise<AiCreditResult> {
  const { config, candidates, rating, feedbackText, reachedGoal, fallbackLocal = true } = opts

  if (config.useLocal || !config.apiKey.trim()) {
    return localAiAssign(candidates, rating, feedbackText)
  }

  const userText = [
    '请根据本步人类反馈，为下列局部 Q 候选重新赋值。',
    '禁止假设完整地图；你只有这些候选。',
    '',
    `人类评分 rating=${rating}（刻度约 -1…1）`,
    `文字反馈：${feedbackText.trim() || '（无）'}`,
    `本步是否到达终点（布尔，无坐标）：${reachedGoal ? 'true' : 'false'}`,
    '',
    '当前值候选：',
    formatCandidatesForPrompt(candidates),
    '',
    '请输出推理，并在末尾给出 JSON：{"updates":[{"id":"C1","q":0.0}]}',
  ].join('\n')

  const t0 = performance.now()
  try {
    const response = await fetch('/api/llm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${normalizeApiKey(config.apiKey)}`,
        'X-Proxy-Target': normalizeLlmEndpoint(config.endpoint),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: temperatureFor(config),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userText },
        ],
      }),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`API ${response.status}: ${errText.slice(0, 240) || response.statusText}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null
          reasoning_content?: string | null
        }
      }>
      error?: { message?: string } | string
    }
    if (payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : payload.error.message
      throw new Error(msg || '上游 API 返回错误')
    }

    const message = payload.choices?.[0]?.message
    const content = String(message?.content ?? '').trim()
    const reasoning = message?.reasoning_content?.trim() || undefined
    if (!content && !reasoning) throw new Error('模型返回为空')

    const parsed = extractJsonObject(content || reasoning || '') as {
      updates?: Array<{ id?: string; q?: number }>
    }
    const updates = (parsed.updates ?? [])
      .map((u) => ({
        id: String(u.id ?? '').trim(),
        q: Number(u.q),
      }))
      .filter((u) => u.id && Number.isFinite(u.q))

    if (!updates.length) throw new Error('JSON 中无有效 updates')

    return {
      updates,
      provider: 'openai',
      rawText: content,
      reasoning,
      latencyMs: Math.round(performance.now() - t0),
    }
  } catch (error) {
    if (!fallbackLocal) throw error
    const local = localAiAssign(candidates, rating, feedbackText)
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ...local,
      rawText: `remote_failed: ${reason}\n${local.rawText ?? ''}`,
      reasoning: `远程失败，已回退本地。${local.reasoning ?? ''}`,
    }
  }
}
