import { TONGUE_MOVEMENT } from '../smr-adapt/labels'

export const chapters = [
  { id: 'left', label: '左手', action: '左手握拳', hint: '观察手指怎样收拢，再慢慢松开。' },
  { id: 'right', label: '右手', action: '右手握拳', hint: '观察手指怎样收拢，再慢慢松开。' },
  { id: 'tongue', label: '舌头', action: TONGUE_MOVEMENT, hint: '从侧面看舌尖在口内抬起，轻触上排牙齿后方的硬腭，再放松。' },
  { id: 'feet', label: '双脚', action: '双脚抬脚尖', hint: '双膝稳定，脚跟着地。观察两侧脚尖一起抬起、落下。' },
  { id: 'jaw', label: '咬牙', action: '轻轻咬住并保持', hint: '观察下颌抬起。上下牙轻轻接触后，保持这个位置。' },
  { id: 'rest', label: '放松', action: '放松', hint: '看向窗外的注视点，让四肢和口舌自然放松。' },
] as const

export type PreviewTask = typeof chapters[number]['id']
