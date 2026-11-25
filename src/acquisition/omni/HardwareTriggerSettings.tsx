import { useEffect, useState } from 'react'
import {
  authorizeHardwareTriggerDirectory, authorizeHardwareTriggerPort, hardwareTriggerDirectoryName,
} from './hardwareTrigger'

export function HardwareTriggerSettings({ disabled }: { disabled: boolean }) {
  const [folder, setFolder] = useState<string>()
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void hardwareTriggerDirectoryName().then(setFolder)
  }, [])

  return <details>
    <summary>CH340 硬件打标</summary>
    <div className="acq-bar">
      <button type="button" className="btn" disabled={disabled} onClick={() => {
        void authorizeHardwareTriggerPort().then(
          () => setNotice('已授权 CH340 打标板。'),
          error => setNotice(error instanceof Error ? error.message : String(error)),
        )
      }}>选择 CH340 打标板</button>
      <button type="button" className="btn" disabled={disabled} onClick={() => {
        void authorizeHardwareTriggerDirectory().then(
          name => { setFolder(name); setNotice('已授权只读录制目录。') },
          error => setNotice(error instanceof Error ? error.message : String(error)),
        )
      }}>选择 GUI 录制目录</button>
      {folder && <span className="acq-hint">GUI 录制目录 · {folder}</span>}
      {notice && <span className="acq-hint" role="status">{notice}</span>}
    </div>
    <p className="acq-hint">专注、咬牙、SMR 和 N-back 录制优先使用已授权的 CH340。请选择 OmniBCI GUI 保存当前 BDF+ 的目录，以便确认设备事件和 EEG 样点。发出前硬件链路不可用时，自动使用 GUI HTTP 打标。</p>
  </details>
}
