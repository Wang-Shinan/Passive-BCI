/** Imported and validated models available in this installation. */
export const LEGACY_S04_HEAD = 'smr_control_s04_reve_20261015_baseline.pt'
export const JOINT_S04_HEAD = 'smr_control_s04_joint_20261016.pt'
// Operator-selected classifier trained at 2026-10-16 11:12 Asia/Shanghai.
export const S04_HEAD = 'smr_control_lp_093f1a91-f720-4773-b87f-4c2f8a5daea3.pt'
export const S04_REVISION = 'web-lp-093f1a91-f720-4773-b87f-4c2f8a5daea3'
/** Times verified from checkpoint trained_at (UTC converted to Asia/Shanghai). */
export const S04_MODEL_OPTIONS = [
  { id: LEGACY_S04_HEAD, label: '10月15日 · 原个体化权重',
    revision: 's04-reve-20261015-baseline-b03275ad-4s',
    description: '最初导入的 S04 编码器和分类头，未采用今天的分类头训练结果。' },
  { id: 'smr_control_lp_07803861-e8b4-4a1c-9a1a-a2523a0ffd45.pt', label: '10月16日 10:54 · 分类头训练',
    revision: 'web-lp-07803861-e8b4-4a1c-9a1a-a2523a0ffd45',
    description: '上午 10:54 保存的分类头，配套原 S04 编码器。' },
  { id: 'smr_control_lp_88707b83-88d6-411e-85a9-baa63aabbed9.pt', label: '10月16日 11:03 · 分类头训练',
    revision: 'web-lp-88707b83-88d6-411e-85a9-baa63aabbed9',
    description: '上午 11:03 保存的分类头，配套原 S04 编码器。' },
  { id: 'smr_control_lp_1fb4ebb7-21c9-4c7c-bc0c-03910e6d8858.pt', label: '10月16日 11:08 · 分类头训练',
    revision: 'web-lp-1fb4ebb7-21c9-4c7c-bc0c-03910e6d8858',
    description: '上午 11:08 保存的分类头，配套原 S04 编码器。' },
  { id: S04_HEAD, label: '10月16日 11:12 · 分类头训练', revision: S04_REVISION,
    description: '上午 11:12 保存的分类头，配套原 S04 编码器；刚才指定使用的版本。' },
  { id: JOINT_S04_HEAD, label: '10月16日 11:13 · 联合训练权重',
    revision: 's04-joint-20261016-a2bae3f7-4s',
    description: '联合训练后的 S04 编码器与分类头，与只更新分类头的版本不同。' },
] as const

export function knownS04Revision(headId: string | undefined): string | undefined {
  return S04_MODEL_OPTIONS.find(option => option.id === headId)?.revision
}

export function defaultSubjectHead(task: string, subjectId: string): string {
  return task === 'smr_control' && subjectId.trim().toUpperCase() === 'S04' ? S04_HEAD : ''
}
