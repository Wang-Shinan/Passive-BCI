export function resolveReveHeadMode(options: {
  task: string; argv?: string[]; env?: Record<string, string | undefined>
}): { freshHead: boolean; checkpointHead: boolean }
export function resolveReveLoraArgs(options: {
  task: string; stateFile?: string; ncc: string; argv?: string[]; env?: Record<string, string | undefined>
}): string[]
