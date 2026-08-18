import type { SmrTask } from './smrControl'
import type { TaskScore } from './engine'

const KEY = 'passive-bci.smr-adapt-profile'

export type SmrAdaptProfile = {
  subjectId: string
  updatedAt: string
  planId: string
  seed: number
  c3Neighbors: string[]
  c4Neighbors: string[]
  horizMean: number | null
  horizStd: number | null
  horizSign?: 1 | -1
  vertMean: number | null
  vertStd: number | null
  scores: TaskScore[]
  trials: number
}

export function profileStorageKey(subjectId: string): string {
  return `${KEY}.${subjectId.trim() || 'S01'}`
}

export function loadSmrProfile(subjectId: string): SmrAdaptProfile | null {
  try {
    const raw = localStorage.getItem(profileStorageKey(subjectId))
    if (!raw) return null
    return JSON.parse(raw) as SmrAdaptProfile
  } catch {
    return null
  }
}

export function saveSmrProfile(profile: SmrAdaptProfile): void {
  localStorage.setItem(profileStorageKey(profile.subjectId), JSON.stringify(profile))
}

export function proficientSummary(scores: readonly TaskScore[]): string {
  if (scores.length === 0) return '尚未完成试次'
  return scores
    .map((row) => {
      const pct = Math.round(row.pvc * 100)
      const mark = row.proficient ? '达标' : '未达标'
      return `${row.task} ${pct}% ${mark}`
    })
    .join(' · ')
}

export function scoreFor(scores: readonly TaskScore[], task: SmrTask): TaskScore | null {
  return scores.find((row) => row.task === task) ?? null
}
