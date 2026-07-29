import { Link } from 'react-router-dom'

const EXPERIMENTS = [
  {
    path: '/rl-graph',
    title: '实验一 · 人脑反馈强化学习',
    blurb: '光标在节点网络中探索终点。你对每步动作打分，智能体据此更新 Q 值。',
    tag: 'TAMER / Q-learning',
    accent: '#5b8cff',
  },
  {
    path: '/tetris',
    title: '实验二 · 压力自适应俄罗斯方块',
    blurb: '标准方块玩法。主试用滑块调节压力，下落速度随之动态变化。',
    tag: 'Adaptive difficulty',
    accent: '#38d39f',
  },
  {
    path: '/card-cit',
    title: '实验三 · 扑克牌隐藏信息测试',
    blurb: '心里选一张牌并试图欺骗系统。三轮闪动测反应时泄漏，系统给出猜测。',
    tag: 'CIT / RT leak',
    accent: '#f5a524',
  },
]

export function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-10">
        <p className="chip mb-3">Passive BCI · Demo Suite</p>
        <h1 className="m-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          被动脑机接口实验网页
        </h1>
        <p className="muted mt-3 max-w-2xl text-base">
          三个范式先用人工评分 / 调节替代真实 EEG，统一
          <code className="mx-1 rounded bg-[#10182b] px-1.5 py-0.5 text-sm">SignalSource</code>
          接口，后续可接入 LSL / WebSocket 桥接真信号。
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {EXPERIMENTS.map((exp) => (
          <Link
            key={exp.path}
            to={exp.path}
            className="panel group block p-5 transition hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]"
            style={{ borderColor: `color-mix(in srgb, ${exp.accent} 35%, #2a3550)` }}
          >
            <span className="chip mb-3" style={{ color: exp.accent, borderColor: `${exp.accent}55` }}>
              {exp.tag}
            </span>
            <h2 className="m-0 text-lg font-semibold">{exp.title}</h2>
            <p className="muted mt-2 text-sm leading-relaxed">{exp.blurb}</p>
            <span className="mt-4 inline-flex text-sm" style={{ color: exp.accent }}>
              进入实验 →
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
