export interface GuessItem {
  word: string
  confidence: number
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface GuessResult {
  guesses: GuessItem[]
  provider: 'openai' | 'local'
  /** Assistant visible reply (usually JSON or mixed). */
  rawText?: string
  /** Model reasoning / thinking, shown as markdown when present. */
  reasoning?: string
  /** Human-readable summary for transcript (markdown-friendly). */
  displayMarkdown?: string
  latencyMs: number
  /** Full message history after this turn (for multi-turn). */
  messages: ChatMessage[]
}

export interface AffectiveSignals {
  satisfaction: number
  surprise: number
  focus: number
  arousal: number
}

export interface GuessApiConfig {
  endpoint: string
  apiKey: string
  model: string
  useLocal: boolean
}

const STORAGE_KEY = 'passive-bci.draw-guess.api'

export const DEFAULT_GUESS_CONFIG: GuessApiConfig = {
  endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
  apiKey: '',
  model: 'k3',
  useLocal: true,
}

export function normalizeGuessEndpoint(endpoint: string): string {
  const url = endpoint.trim().replace(/\/+$/, '')
  if (!url) return DEFAULT_GUESS_CONFIG.endpoint
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`
  if (/\/coding$/i.test(url)) return `${url}/v1/chat/completions`
  return url
}

export function normalizeApiKey(apiKey: string): string {
  return apiKey.trim().replace(/^Bearer\s+/i, '').replace(/\s+/g, '')
}

function isLegacyOpenAiDefault(config: Partial<GuessApiConfig>): boolean {
  const endpoint = config.endpoint ?? ''
  const model = config.model ?? ''
  return endpoint.includes('api.openai.com') || model === 'gpt-4o-mini' || model === 'gpt-4o'
}

export function loadGuessConfig(): GuessApiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_GUESS_CONFIG }
    const parsed = JSON.parse(raw) as Partial<GuessApiConfig>
    const migrated = isLegacyOpenAiDefault(parsed)
      ? { ...parsed, endpoint: DEFAULT_GUESS_CONFIG.endpoint, model: DEFAULT_GUESS_CONFIG.model }
      : parsed
    return {
      ...DEFAULT_GUESS_CONFIG,
      ...migrated,
      endpoint: normalizeGuessEndpoint(migrated.endpoint ?? DEFAULT_GUESS_CONFIG.endpoint),
      apiKey: normalizeApiKey(migrated.apiKey ?? ''),
      useLocal: migrated.useLocal ?? !migrated.apiKey,
    }
  } catch {
    return { ...DEFAULT_GUESS_CONFIG }
  }
}

export function saveGuessConfig(config: GuessApiConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...config,
      endpoint: normalizeGuessEndpoint(config.endpoint),
      apiKey: normalizeApiKey(config.apiKey),
    }),
  )
}

function inkStats(imageData: ImageData): { inkRatio: number; hash: number; strokeSpread: number } {
  const { data, width, height } = imageData
  let ink = 0
  let sumX = 0
  let sumY = 0
  let hash = 2166136261
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!
    const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3
    if (a > 20 && lum < 245) {
      ink++
      const px = (i / 4) % width
      const py = Math.floor(i / 4 / width)
      sumX += px
      sumY += py
      hash ^= (data[i]! << 16) ^ (data[i + 1]! << 8) ^ data[i + 2]!
      hash = Math.imul(hash, 16777619)
    }
  }
  const total = width * height
  const inkRatio = ink / Math.max(1, total)
  const cx = ink ? sumX / ink : width / 2
  const cy = ink ? sumY / ink : height / 2
  const strokeSpread = Math.hypot(cx / width - 0.5, cy / height - 0.5)
  return { inkRatio, hash: hash >>> 0, strokeSpread }
}

export function localGuess(
  imageData: ImageData,
  wordBank: readonly string[],
  secretWord: string,
  priorMessages: ChatMessage[] = [],
  oracleBias = 0.55,
): GuessResult {
  const t0 = performance.now()
  const { inkRatio, hash, strokeSpread } = inkStats(imageData)
  let x = (hash ^ Math.floor(inkRatio * 1e6) ^ Math.floor(strokeSpread * 1e4) ^ priorMessages.length) >>> 0
  const next = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
  const scored = wordBank.map((word, index) => {
    let score = next()
    if (word === secretWord) score += oracleBias
    if (inkRatio < 0.01) score -= 0.4
    score += ((hash >> (index % 16)) & 1) * 0.05
    return { word, confidence: score }
  })
  scored.sort((a, b) => b.confidence - a.confidence)
  const guesses = scored.slice(0, 3).map((item, i) => ({
    word: item.word,
    confidence: Number(Math.max(0.05, 0.92 - i * 0.18 - (1 - item.confidence) * 0.1).toFixed(3)),
  }))
  const rawText = JSON.stringify({ guesses }, null, 2)
  const assistant: ChatMessage = { role: 'assistant', content: rawText }
  return {
    guesses,
    provider: 'local',
    rawText,
    reasoning: '本地演示猜测（未调用远程模型）。',
    displayMarkdown: formatGuessMarkdown(guesses, '本地演示猜测（未调用远程模型）。'),
    latencyMs: Math.round(performance.now() - t0),
    messages: [...priorMessages, assistant],
  }
}

/** Unpack JSON object embedded in plain text / fenced code / mixed prose. */
export function extractJsonObject(text: string): unknown {
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
  // Prefer object that contains "guesses"
  const guessBlock = cleaned.match(/\{[\s\S]*"guesses"\s*:\s*\[[\s\S]*?\][\s\S]*\}/)
  if (guessBlock) attempts.unshift(guessBlock[0])

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

export function parseGuesses(payload: unknown): GuessItem[] {
  const root = payload as {
    guesses?: Array<{ word?: string; confidence?: number }>
    word?: string
    confidence?: number
  }
  let list = root.guesses
  if (!list && root.word) {
    list = [{ word: root.word, confidence: root.confidence }]
  }
  return (list ?? [])
    .map((g) => ({
      word: String(g.word ?? '').trim(),
      confidence: Number.isFinite(Number(g.confidence)) ? Number(g.confidence) : 0,
    }))
    .filter((g) => g.word)
    .slice(0, 5)
}

export function formatGuessMarkdown(guesses: GuessItem[], reasoning?: string): string {
  const lines: string[] = []
  if (reasoning?.trim()) {
    lines.push('### 推理', '', reasoning.trim(), '')
  }
  lines.push('### 解包后的猜测', '')
  if (!guesses.length) {
    lines.push('_（未能解析出猜测列表）_')
  } else {
    guesses.forEach((g, i) => {
      lines.push(`${i + 1}. **${g.word}** — 置信度 ${(g.confidence * 100).toFixed(0)}%`)
    })
  }
  return lines.join('\n')
}

function temperatureFor(config: GuessApiConfig): number {
  return /api\.kimi\.com|kimi-for-coding|^k3/i.test(`${config.endpoint} ${config.model}`) ? 1 : 0.2
}

const SYSTEM_PROMPT = [
  '你在玩「你画我猜」：根据用户手绘简笔画猜测词语。',
  '你可以在回复中先用自然语言简要推理，但必须在末尾给出可解析的 JSON：',
  '{"guesses":[{"word":"词语","confidence":0.0}]}',
  '给出 3 个最可能的中文短词，confidence 为 0~1。',
  '不要询问正确答案；根据画面与用户后续反馈自行修正。',
].join('\n')

export function buildInitialMessages(
  dataUrl: string,
  wordBank: readonly string[],
): ChatMessage[] {
  const userText = [
    '请根据这幅白底简笔画猜测画的是什么。',
    `可参考词库（不必受限）：${wordBank.slice(0, 40).join('、')}…`,
    '请输出推理，并在最后给出 JSON：{"guesses":[{"word":"词语","confidence":0.0}]}',
  ].join('\n')

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]
}

export function buildFeedbackMessage(
  signals: AffectiveSignals,
  feedbackText: string,
  previousGuesses: GuessItem[],
): ChatMessage {
  const text = [
    '这是我对你上一轮猜测的反馈。请据此修正猜测，并再次输出推理 + JSON。',
    '',
    '四维信号（0–100，由被试/主试提供；含义请你自行理解，以下仅为示意而非硬规则）：',
    `- 满意度 satisfaction=${signals.satisfaction}（示意：是否接近答案）`,
    `- 惊讶度 surprise=${signals.surprise}（示意：猜测是否过于离谱）`,
    `- 专注度 focus=${signals.focus}（示意：是否愿意跟随你的推理）`,
    `- 活跃度 arousal=${signals.arousal}（示意：是否愿意积极纠正）`,
    '',
    `上一轮解包猜测：${previousGuesses.map((g) => `${g.word}(${(g.confidence * 100).toFixed(0)}%)`).join('、') || '（无）'}`,
    '',
    `文字反馈：${feedbackText.trim() || '（无文字，仅参考四维信号）'}`,
    '',
    '请形成你自己对这组信号与反馈的理解，更新 3 个猜测，并在末尾给出 JSON。',
  ].join('\n')

  return { role: 'user', content: text }
}

export type StreamDelta = { content: string; reasoning?: string }
export type OnStreamDelta = (delta: StreamDelta) => void

/** Live markdown while tokens arrive (before JSON unpack). */
export function formatStreamingMarkdown(content: string, reasoning?: string): string {
  const parts: string[] = []
  if (reasoning?.trim()) {
    parts.push('### 推理', '', reasoning)
  }
  if (content.trim()) {
    parts.push(reasoning?.trim() ? '### 回复' : '### AI 正在输出', '', content)
  }
  return parts.join('\n') || '_正在思考…_'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Local / fallback: fake typewriter so UI still streams. */
async function simulateTypewriter(
  content: string,
  reasoning: string | undefined,
  onDelta?: OnStreamDelta,
): Promise<void> {
  if (!onDelta) return
  let r = ''
  let c = ''
  for (const ch of reasoning ?? '') {
    r += ch
    onDelta({ content: c, reasoning: r })
    await sleep(6)
  }
  // Chunk by 1–2 chars for slightly smoother Chinese typing.
  for (let i = 0; i < content.length; i++) {
    c += content[i]!
    onDelta({ content: c, reasoning: r || undefined })
    await sleep(content[i] === '\n' ? 18 : 8)
  }
}

async function readErrorPayload(response: Response): Promise<string> {
  const errText = await response.text().catch(() => '')
  try {
    const json = JSON.parse(errText) as { error?: string | { message?: string } }
    if (typeof json.error === 'string') return json.error
    if (json.error?.message) return json.error.message
  } catch {
    /* plain text */
  }
  return errText.slice(0, 240) || response.statusText
}

async function callChatApi(
  config: GuessApiConfig,
  messages: ChatMessage[],
  onDelta?: OnStreamDelta,
): Promise<{ content: string; reasoning?: string; latencyMs: number }> {
  const t0 = performance.now()
  let response: Response
  try {
    response = await fetch('/api/llm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${normalizeApiKey(config.apiKey)}`,
        'X-Proxy-Target': normalizeGuessEndpoint(config.endpoint),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: temperatureFor(config),
        messages,
        stream: true,
      }),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `网络请求失败（${detail}）。请确认已用 npm run dev 启动（需 Vite 代理），或勾选「本地演示猜测」。`,
    )
  }

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await readErrorPayload(response)}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const isEventStream =
    contentType.includes('text/event-stream') || contentType.includes('event-stream')

  // Non-stream JSON fallback (some gateways ignore stream:true).
  if (!isEventStream) {
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
    await simulateTypewriter(content, reasoning, onDelta)
    return {
      content: content || (reasoning ? `（仅有推理，无正文）\n\n${reasoning}` : ''),
      reasoning,
      latencyMs: Math.round(performance.now() - t0),
    }
  }

  if (!response.body) throw new Error('流式响应无 body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''

  const emit = () => {
    onDelta?.({ content, reasoning: reasoning || undefined })
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''

    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue

      let json: {
        choices?: Array<{
          delta?: {
            content?: string | null
            reasoning_content?: string | null
          }
          message?: {
            content?: string | null
            reasoning_content?: string | null
          }
        }>
        error?: { message?: string } | string
      }
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      if (json.error) {
        const msg = typeof json.error === 'string' ? json.error : json.error.message
        throw new Error(msg || '上游流式返回错误')
      }
      const choice = json.choices?.[0]
      const delta = choice?.delta ?? choice?.message
      if (!delta) continue
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content
      }
      emit()
    }
  }

  content = content.trim()
  reasoning = reasoning.trim()
  if (!content && !reasoning) throw new Error('模型流式返回为空')

  return {
    content: content || (reasoning ? `（仅有推理，无正文）\n\n${reasoning}` : ''),
    reasoning: reasoning || undefined,
    latencyMs: Math.round(performance.now() - t0),
  }
}

function resultFromAssistant(opts: {
  content: string
  reasoning?: string
  latencyMs: number
  priorMessages: ChatMessage[]
  provider: 'openai' | 'local'
}): GuessResult {
  const { content, reasoning, latencyMs, priorMessages, provider } = opts
  let guesses: GuessItem[] = []
  let parseError: string | undefined
  try {
    guesses = parseGuesses(extractJsonObject(content))
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  const assistant: ChatMessage = { role: 'assistant', content }
  const displayMarkdown = [
    formatGuessMarkdown(guesses, reasoning),
    parseError ? `\n\n> JSON 解包失败：${parseError}` : '',
    '\n\n<details><summary>原始 content</summary>\n\n```json\n',
    content.replace(/```/g, '``\\`'),
    '\n```\n</details>',
  ].join('')

  return {
    guesses,
    provider,
    rawText: content,
    reasoning,
    displayMarkdown,
    latencyMs,
    messages: [...priorMessages, assistant],
  }
}

export async function requestGuess(opts: {
  canvas: HTMLCanvasElement
  config: GuessApiConfig
  wordBank: readonly string[]
  secretWord: string
  fallbackLocal?: boolean
  onDelta?: OnStreamDelta
}): Promise<GuessResult> {
  const { canvas, config, wordBank, secretWord, fallbackLocal = true, onDelta } = opts
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法读取画布')

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const ink = inkStats(imageData)
  if (ink.inkRatio < 0.0015) throw new Error('画布几乎是空白的，请先画画再猜')

  const dataUrl = canvas.toDataURL('image/png')
  const messages = buildInitialMessages(dataUrl, wordBank)

  if (config.useLocal || !config.apiKey.trim()) {
    const local = localGuess(imageData, wordBank, secretWord, messages)
    await simulateTypewriter(local.rawText ?? '', local.reasoning, onDelta)
    return local
  }

  try {
    const { content, reasoning, latencyMs } = await callChatApi(config, messages, onDelta)
    return resultFromAssistant({
      content,
      reasoning,
      latencyMs,
      priorMessages: messages,
      provider: 'openai',
    })
  } catch (error) {
    if (!fallbackLocal) throw error
    const local = localGuess(imageData, wordBank, secretWord, messages)
    const reason = error instanceof Error ? error.message : String(error)
    await simulateTypewriter(local.rawText ?? '', local.reasoning, onDelta)
    return {
      ...local,
      rawText: `remote_failed: ${reason}`,
      displayMarkdown: `远程失败，已回退本地演示。\n\n${local.displayMarkdown}`,
    }
  }
}

/** Continue multi-turn after user feedback + affective signals. */
export async function requestFollowUpGuess(opts: {
  canvas: HTMLCanvasElement
  config: GuessApiConfig
  wordBank: readonly string[]
  secretWord: string
  priorMessages: ChatMessage[]
  previousGuesses: GuessItem[]
  signals: AffectiveSignals
  feedbackText: string
  fallbackLocal?: boolean
  onDelta?: OnStreamDelta
}): Promise<GuessResult> {
  const {
    canvas,
    config,
    wordBank,
    secretWord,
    priorMessages,
    previousGuesses,
    signals,
    feedbackText,
    fallbackLocal = true,
    onDelta,
  } = opts

  const feedback = buildFeedbackMessage(signals, feedbackText, previousGuesses)
  const messages = [...priorMessages, feedback]

  if (config.useLocal || !config.apiKey.trim()) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法读取画布')
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const bias =
      0.25 +
      (signals.satisfaction / 100) * 0.45 -
      (signals.surprise / 100) * 0.2
    const local = localGuess(imageData, wordBank, secretWord, messages, Math.max(0.05, bias))
    await simulateTypewriter(local.rawText ?? '', local.reasoning, onDelta)
    return local
  }

  try {
    const { content, reasoning, latencyMs } = await callChatApi(config, messages, onDelta)
    return resultFromAssistant({
      content,
      reasoning,
      latencyMs,
      priorMessages: messages,
      provider: 'openai',
    })
  } catch (error) {
    if (!fallbackLocal) throw error
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw error
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const local = localGuess(imageData, wordBank, secretWord, messages)
    const reason = error instanceof Error ? error.message : String(error)
    await simulateTypewriter(local.rawText ?? '', local.reasoning, onDelta)
    return {
      ...local,
      rawText: `remote_failed: ${reason}`,
      displayMarkdown: `远程失败，已回退本地演示。\n\n${local.displayMarkdown}`,
    }
  }
}
