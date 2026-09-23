/** Shared shell state; each protocol keeps its own model and recording labels. */
export type SmrModeProps = {
  embedded?: boolean
  subjectId?: string
  onSubjectChange?: (subject: string) => void
  onBusyChange?: (busy: boolean) => void
}
