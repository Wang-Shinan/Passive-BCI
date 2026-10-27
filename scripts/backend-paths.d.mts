export const projectRoot: string
export const backendRoot: string
export const adapterRoot: string
export const checkpointRoot: string
export function findPython(): string
export function backendEnv(): NodeJS.ProcessEnv
export function runBackend(script: string, args?: string[]): import('node:child_process').ChildProcess
