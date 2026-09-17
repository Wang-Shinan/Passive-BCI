export function nbackTriggerCode(type: string, data: Record<string, unknown>, n: number): number | null {
  if (type === 'block_start') return 100
  if (type === 'stimulus_onset') return (data.scored === false ? 110 : data.target === true ? 130 : 120) + n
  if (type === 'stimulus_offset') return (data.scored === false ? 140 : data.target === true ? 160 : 150) + n
  if (type === 'response') return data.scored === false ? 201 : data.target === true ? 202 : 203
  if (type === 'trial_end') {
    const codes: Record<string, number> = { warmup: 400, hit: 401, miss: 402, false_alarm: 403, correct_rejection: 404 }
    return codes[String(data.outcome)] ?? null
  }
  if (type === 'block_end') return 300
  if (type === 'block_abort') return 301
  return null
}

/** Self-describing BDF annotation, retaining the complete block UUID and zero-based trial index. */
export function nbackTriggerLabel(type: string, data: Record<string, unknown>, n: number, blockId: string): string {
  const condition = data.scored === false ? 'warmup' : data.target === true ? 'target' : data.target === false ? 'nontarget' : '-'
  const outcome = typeof data.outcome === 'string' ? data.outcome : condition
  const rt = typeof data.rtMs === 'number' ? data.rtMs.toFixed(1) : '-'
  return `nback:v2:b=${blockId}:n=${n}:t=${data.index ?? '-'}:e=${type}:l=${data.letter ?? '-'}:c=${outcome}:rt=${rt}`
}
