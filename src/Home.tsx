import { Link } from 'react-router-dom'

const TOOLS = [
  {
    path: '/acquisition',
    title: '采集调试',
    blurb:
      'OmniBCI（Web Serial）或博睿康 Neuracle（JellyFish + oi-mi 桥接）：实时波形、通道配置与录制。',
    tag: 'OmniBCI · 博睿康',
    accent: '#22d3ee',
  },
]

const EXPERIMENTS = [
  {
    path: '/rl-graph',
    title: '实验一 · 人脑反馈强化学习',
    blurb: '光标在节点网络中探索终点。你对每步打分（可加文字）；TAMER / Q-learning / AI 分配 Q 三种更新方式。',
    tag: 'TAMER / Q / AI credit',
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
  {
    path: '/jump',
    title: '实验四 · 跳一跳',
    blurb: '按压蓄力控制跳跃距离，落在下一台得分；中心完美落地可连击。压力调节难度。',
    tag: 'WeChat Jump / Timing',
    accent: '#ff6b3d',
  },
  {
    path: '/draw-guess',
    title: '实验五 · 你画我猜',
    blurb: '画出词语让 AI 猜测。采集满意度 / 惊讶度 / 专注度 / 活跃度，并写下文字反馈。',
    tag: 'Draw & Guess / Affect',
    accent: '#7c9cff',
  },
  {
    path: '/dino',
    title: '实验六 · 小恐龙',
    blurb: 'Chrome 经典跑酷：跳仙人掌、躲飞鸟。压力调节速度与障碍密度。',
    tag: 'Dino Runner / Stress',
    accent: '#535353',
  },
]

function CardGrid({
  items,
}: {
  items: typeof TOOLS | typeof EXPERIMENTS
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <Link
          key={item.path}
          to={item.path}
          className="panel group block p-5 transition hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]"
          style={{ borderColor: `color-mix(in srgb, ${item.accent} 35%, #2a3550)` }}
        >
          <span className="chip mb-3" style={{ color: item.accent, borderColor: `${item.accent}55` }}>
            {item.tag}
          </span>
          <h2 className="m-0 text-lg font-semibold">{item.title}</h2>
          <p className="muted mt-2 text-sm leading-relaxed">{item.blurb}</p>
          <span className="mt-4 inline-flex text-sm" style={{ color: item.accent }}>
            进入 →
          </span>
        </Link>
      ))}
    </div>
  )
}

export function Home() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-10">
        <p className="chip mb-3">Passive BCI · Demo Suite</p>
        <h1 className="m-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          被动脑机接口实验网页
        </h1>
        <p className="muted mt-3 max-w-2xl text-base">
          六个范式先用人工评分 / 调节或「特征驱动」替代真实 EEG，统一
          <code className="mx-1 rounded bg-[#10182b] px-1.5 py-0.5 text-sm">SignalSource</code>
          接口；压力 / 情感类实验可切换手动 ↔ 特征映射。采集调试支持 OmniBCI（Web Serial）与博睿康
          Neuracle（oi-mi 桥接）。
        </p>
      </header>

      <section className="mb-12">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="m-0 text-xl font-semibold tracking-tight">采集调试</h2>
          <span className="muted text-sm">信号接入 · 质量检查</span>
        </div>
        <CardGrid items={TOOLS} />
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="m-0 text-xl font-semibold tracking-tight">实验</h2>
          <span className="muted text-sm">范式演示 · 人工反馈</span>
        </div>
        <CardGrid items={EXPERIMENTS} />
      </section>
    </div>
  )
}
