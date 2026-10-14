import { SmrAdaptPage } from '../smr-adapt'

export function SmrAcquisitionPage({ autoStartModel = true }: { autoStartModel?: boolean }) {
  return <SmrAdaptPage groupedAcquisition autoStartModel={autoStartModel} />
}
