import type { IconName } from '../lib/ui/Icon'

export type DirectoryEntry = {
  icon: IconName
  path: string
  name: string
  description: string
  requirement: string
  legacy?: boolean
}

export const experiments: DirectoryEntry[] = [
  { icon: 'memory', path: '/nback', name: 'N-back 工作记忆', description: '1–3-back 字母匹配；记录命中、漏报、误报与反应时。', requirement: '空格响应；可同步录制 EEG。' },
  { icon: 'blocks', path: '/tetris', name: '压力自适应俄罗斯方块', description: '标准方块游戏；支持压力调速、SMR 控制与教师协作。', requirement: '可键盘操作；脑控需连接 EEG 和模型。' },
  { icon: 'graph', path: '/rl-graph', name: '人脑反馈强化学习', description: '图或网格上的路径任务；支持 TAMER、Q-learning 和 AI 分配 Q。', requirement: '按键 1–5 评分；可添加文字反馈。' },
  { icon: 'cards', path: '/card-cit', name: '扑克牌隐藏信息测试', description: '心选一张牌；通过三轮闪动和按键反应时进行判断。', requirement: '空格响应；当前使用反应时。' },
  { icon: 'jump', path: '/jump', name: '跳一跳', description: '按压蓄力、松开跳跃；记录起跳、落地与失误。', requirement: '按压操作；压力信号可调节难度。' },
  { icon: 'pen', path: '/draw-guess', name: '你画我猜', description: '手绘词语，采集 AI 猜测结果、四维情感评分与文字反馈。', requirement: '本地猜测可用；视觉模型需配置 API。' },
  { icon: 'run', path: '/dino', name: '小恐龙', description: '跳跃与俯身躲避障碍；压力信号调节速度和障碍密度。', requirement: '键盘或点击操作。' },
  { icon: 'grid', path: '/schulte', name: '舒尔特方格', description: '依次点击数字；记录每步反应时与滚动专注指数。', requirement: '鼠标点击操作。' },
]

export const smrExperiments: DirectoryEntry[] = [
  { icon: 'grid', path: '/neuroslide', name: 'NeuroSlide 脑控冰面迷宫', description: '一次方向指令，滑到墙前。简单、普通、困难三级冰面解谜。', requirement: '键盘可独立游玩；支持四分类 EEG、稳定确认和独立试次。' },
  { icon: 'grid', path: '/smr-grid', name: 'SMR 二维棋盘追踪', description: '3×3 随机亮格，光标命中后保留位置，连续追踪下一目标。', requirement: 'SMR 四方向信号；也可用键盘试玩。' },
  { icon: 'training', path: '/smr-acquisition', name: 'SMR 分组采集与训练', description: '四方向随机采集；组间保存、训练分类头、评估并选择模型，再继续下一组。', requirement: '可演示；自动训练需真实 EEG 与本地冻结 REVE 四分类模型。' },
  { icon: 'cursor', path: '/smr', name: 'SMR 采集与光标控制', description: '切换普通 SMR 或全屏 SMR；包含个体化适配、方向采集、训练与验证。', requirement: '普通模式可预览；全屏 SMR 采集需真实 EEG 与对应模型。' },
  { icon: 'calibrate', path: '/tetris-adapt', name: '方块 SMR 适配', description: '左右、旋转、下落动作练习与窄井任务；脚想象只采标签。', requirement: '四分类头保持冻结。' },
  { icon: 'signal', path: '/gaze-smr-tetris', name: '全屏 SMR 俄罗斯方块', description: '使用 REVE 方向头控制方块：左移、右移、旋转、软降。', requirement: '真实 EEG；本被试的 gaze_smr 头。' },
]

export const tools: DirectoryEntry[] = [
  { icon: 'signal', path: '/jaw-clench', name: '咬牙与放松采集', description: '全屏提示咬牙／放松，等量随机录制 EEG 与二分类标签。', requirement: '可预览；录制需真实 EEG，无需模型。' },
  { icon: 'signal', path: '/acquisition', name: '采集调试', description: '设备连接、开流、波形、频谱、阻抗与通道配置。', requirement: 'OmniBCI / 博睿康 / BCIGo' },
  { icon: 'database', path: '/recordings', name: '会话库', description: '查看实际录制，编辑备注、下载与删除会话。', requirement: '读取本地 recordings 目录' },
  { icon: 'training', path: '/training', name: '数据导出与 Linear Probing', description: '从录制导出 H5，训练冻结 REVE 的线性头并查看评估。', requirement: '需配套后端与训练依赖' },
  { icon: 'learn', path: '/online-learn', name: '基模在线学习', description: '配置 REVE 任务和在线线性头更新；SMR 头冻结。', requirement: '需对应模型服务' },
  { icon: 'external', path: '/stress-remote', name: '独立压力窗口', description: '在独立窗口中调整压力信号。', requirement: '用于主试调节' },
]
