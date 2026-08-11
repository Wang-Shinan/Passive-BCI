# 单次生理通道的多智能体信用分配：相关研究调查与行动指南

调查日期：2026-07-30  
范围：人–AI 团队生理、ErrP/agency、自校准 BCI、EEG 基础模型、多智能体信用、噪声评估器与自适应自动化。  
资料库：53 篇论文，其中 42 篇为同行评审论文，11 篇为预印本。

## 1. 结论先行

这个 proposal 值得继续做，但最有价值的部分并不是“用 EEG 给智能体打分”。单独来看，
EEG 错误检测、单试次 agency 分类、无独立校准的在线 ErrP、自适应自动化、Shapley
信用、噪声评估器后验和 agent-step process reward 都已有直接先例
[@iturrate2015self; @gomez2024agency; @wilson2007adaptive; @han2020shapley;
@bonagiri2026stableval; @xu2026triage]。

真正仍然开放的是下面这个组合问题：

> 当每个物理事件只能被人类生理系统观察一次、每次观测的信息量很低、可靠度在会话内
> 漂移、缺失具有语义，而且智能体的行为还能改变评估者状态时，如何联合推断多智能体
> 信用与观测通道可靠度，并阻止策略通过伤害评估器来改善自己的表面信用？

这里有两个最强的研究抓手。

第一是 **physical non-repeatability**。许多 counterfactual、coalition 或
group-relative 方法需要多次 rollout、相同状态、冻结随机种子或重复 judge 调用。真实
人类对同一事件的 phasic response 不可能原样重放。需要论证的不是这些方法“在低信噪比
下表现较差”，而是它们的输入假设在物理单次通道下不成立。

第二是 **endogenous evaluator reliability**。传统自适应自动化用 workload 决定何时
给人帮助；这里更危险的回路是 agent action 改变 workload，workload 改变 phasic
decoder 的可靠度，可靠度又改变 agent 获得的信用。若训练目标依赖这条通道，策略可能
主动制造让监督者难以评估的状态。这与一般的 workload-aware aiding 不同，但需要用明确
的因果模型和可复现实验来证明。

相反，下面这些说法不宜作为主要 novelty：

- “首次用 ErrP 发现错误”；
- “首次用 EEG 做在线自适应”；
- “首次对噪声评估器建混淆矩阵”；
- “首次输出 posterior expected credit”；
- “首次用局部 judge 给 agent step 分信用”；
- “基础模型可以免校准”。

最后一条尤其需要谨慎。最新系统评测显示，EEG 基础模型的线性探测常常不足，专用小模型
仍有竞争力，更大的模型也不必然泛化更好 [@liu2026eegfm]；更激进的负对照甚至发现
dataset identity 可比临床标签更容易从 embedding 中解码 [@zare2026stress]。因此基础
模型应被当作候选 encoder，而不是 proposal 成立的前提。

## 2. 背景：六条研究线如何汇合

### 2.1 人–AI 团队中的身份效应与生理变化

Qin、Lee 与 Sajda 的 Wizard-of-Oz 研究提供了最直接的动机：团队相信一名能力相当的
专家是 AI 后，整体表现显著下降，而且差异集中在中高难度条件；沟通、瞳孔和团队神经
动力学也发生变化 [@qin2026ai]。同一研究线还发现，根据队友的行为与生理历史预测其
未来动作的难易程度，与团队绩效相关 [@qin2025predictability]。

但这两项研究没有证明存在一个可在线输出 per-agent credit 的神经通道。Qin 2026 的
WoZ 专家固定承担 thrust 角色，因此 agent identity 与控制角色混杂；其 EEG 重点是
成功穿环附近的 inter-brain synchrony，而不是失败事件上的 ErrP。它最适合支持
“问题真实存在”和“困难条件是效应发生区间”，不能直接支持 proposal 中的 decoder。

对于后续研究，GJC 至少需要：

1. 在人类、AI 和各控制角色之间完全 counterbalance；
2. 失败后保留可分析事件，而不是立即终止并丢掉错误后的神经反应；
3. 把 action onset、visible state change 和 outcome onset 分开记录；
4. 将 team 作为独立统计单位，不能把大量 trial 当作独立样本；
5. 同时保留 speech、controller、pupil 和 timeout，供 neural increment ablation 使用。

### 2.2 从“检测错误”到“归因给谁”

ErrP 文献已经证明人在执行或观察错误时会产生可检测的事件相关反应
[@ferrez2008error; @chavarriaga2010learning]。更接近 proposal 的是
Gómez-Andrés 等人的 agency 研究：23 名参与者完成包含人为注入 external error 的
Flanker 任务，subject-specific 线性 SVM 在 Correct / self-error / external-error 三类
上取得平均 0.65 的单试次准确率；较早的 frontal ERN 与 self-error 相关，较晚的
parietal P600 帮助区分 external agency [@gomez2024agency]。

这项结果既是好消息，也是边界。好消息是，单试次 EEG 里确实可能存在“错误是谁造成的”
信息，而不只有 global error。边界是它需要数百次被试内训练试次，external error 是
干净且人为注入的，而且 self/other 远比多个耦合 agent 中的责任分配简单。65% 三分类
准确率也没有回答校准、拒绝、延迟和漂移。

因此 proposal 的第一个决定性 pilot 不应该马上训练完整 multi-agent credit model，
而应先做一个正交操纵：

- objective correctness：对 / 错；
- expectation：预期 / 非预期；
- agency：human / agent A / agent B；
- visibility：责任线索可见 / 不可见；
- repair：错误后来被修复 / 未修复。

目标是检验 agent identity 或 agency 信息能否在控制 surprise 与 correctness 后仍被
单试次解码。如果做不到，EEG 最多是全局 gate，不能承担 allocator。

### 2.3 在线自校准已有先例，但不等于多智能体信用

Iturrate 等人的工作是 proposal 最重要的架构基线。系统在 \(5\times5\) 网格中执行动作，
每次动作后观察一次 ErrP，并利用任务约束联合估计隐藏目标和用户特定 decoder。八名
参与者无需独立校准即可从实验开始使用系统；第一个目标较慢，之后到达目标所需动作数
显著减少 [@iturrate2015self]。

这说明“decoder 可靠度未知，所以必须先做长校准”并不总成立。任务结构本身可以提供弱
监督。然而，网格目标提供了很强的可识别性：候选目标有限，动作后果简单，而且是一个
控制器，不是多个相互补偿或相互掩盖的智能体。proposal 必须把 Iturrate-style joint
latent model 作为 baseline，并进一步回答：

- 什么 anchor 使 credit 与 decoder drift 可区分？
- 需要多少显式 query 或已知 control event？
- 当 drift timescale 接近事件间隔时，posterior 是否仍能收缩？
- “agent 变差”和“decoder 更倾向报错”在多长 session 内可被区分？

如果没有锚点时两者 observationally equivalent，就应该明确给出不可识别性结果，而不
是用更复杂网络掩盖。

### 2.4 Tonic workload 是条件变量，不是信用源

生理状态驱动自动化并不新。Pope 等人的 biocybernetic loop、Wilson 与 Russell 的
psychophysiologically determined adaptive aiding，以及 Faller 等人的 online arousal
neurofeedback 都表明实时状态估计可以改变辅助策略并改善困难任务表现
[@pope1995biocybernetic; @wilson2007adaptive; @faller2019arousal]。Faller 还使用
veridical、sham 与 silence 条件，这是 proposal 应继承的控制设计。

因此 workload 不能被包装为 per-agent credit。更合理的三个用途是：

1. 条件化 phasic observation model：
   \(p(o_t\mid z_t,w_t,e_t,\theta_t)\)；
2. 作为 query cost，让系统避免在高负荷且低可靠时打断人；
3. 帮助区分“没有错误”“超时未完成”“人没有在看”和“artifact rejected”。

最值得研究的不是让 workload 保持在一个舒适区间，而是它从 exogenous covariate 变成
agent-actuated state 后是否产生 evaluator gaming。必须画出至少两张因果图：一张用于
估计 credit，一张用于控制 workload；否则对 workload 的 conditioning 可能错误阻断
中介路径或引入 collider bias。

## 3. 方法谱系与 proposal 的位置

### 3.1 多智能体信用分配

经典 cooperative MARL 从 value decomposition 入手：VDN 将团队价值分解为个体价值，
QMIX 施加单调 mixing constraint，COMA 使用 counterfactual baseline 隔离某个 agent
action 的边际影响 [@sunehag2018vdn; @rashid2018qmix; @foerster2018coma]。Shapley
Q-value 进一步利用 coalition-based marginal contribution 分配全局回报
[@han2020shapley]。

这些方法解决的是训练环境里可重复采样或可估计价值函数的信用问题。proposal 面对的是
一个外部 human observation channel：对每个真实事件只有一次生理响应，不能要求人类
对所有 coalition 重演同一个心理状态。因此 exact Shapley 最适合在 bit-exact simulator
里做 audit ground truth，而不是宣称人脑产生 Shapley value。

2026 年的 TRIAGE（预印本）进一步表明，局部 semantic role 可以修正 GRPO 把同一个
trajectory advantage 广播给所有 agent segment 的缺陷。它把动作分为 decisive
progress、useful exploration、no-progress 与 regression，并证明 role correction
只有在其与真实 credit residual 正协方差时才降低均方误差 [@xu2026triage]。这个条件
对 proposal 很有用：生理 verdict 并非只要 above chance 就有价值，它与真实 residual
的对齐方向、校准和使用权重共同决定是否改善 credit。

TRIAGE 也划清了 novelty：它可使用多 rollout、final verifier、future local context 和
大 judge；单次生理通道没有这些资源。因此应把它放在 repeatable/wide-channel upper
baseline，而不是忽略。

### 3.2 噪声评估器与 posterior credit

Dawid–Skene 类方法早已用 EM 同时估计 latent label 与 annotator confusion matrix
[@dawid1979maximum]。STABLEVAL 又把完整 posterior 转为 expected item credit，并以
annotator subsampling 下的排名稳定性为目标 [@bonagiri2026stableval]。它在高分歧条件
下比 majority vote 稳定，但需要每个 item 的多次标注和足够 annotation density；在
高一致条件下优势很小，在稀疏条件下 reliability 估计会不稳定。

这意味着 proposal 不能把“建模 evaluator noise”或“输出 posterior credit”本身作为
新颖性。它的差异应精确写成：

- 不是多 annotator panel，而是同一个 observer 的 time-varying state；
- 不是每个 item 多次标注，而是每个物理事件仅一次；
- 不是随机缺标签，而是 artifact、timeout、neutral、not-attending 有不同语义；
- evaluator state 受被评对象的 action 影响；
- 目标不是稳定 leaderboard，而是在低 interruption budget 下作在线干预。

### 3.3 归因还需要 intervention validation

DoVer 把 LLM multi-agent debugging 从 log-only attribution 转为 do-then-verify：生成失败
假设、编辑 message 或 plan、从 checkpoint replay，再观察任务是否被修复。它在
Magnetic-One 的 GAIA/AssistantBench 派生失败上修复 18–28%，在 AG2/GSMPlus 上修复
49%；更重要的是，多个不同 intervention 可以独立修复同一失败
[@ma2026dover]。

因此 report exact Shapley error 还不够。建议加入三组 endpoint：

1. **Attribution:** 与 simulator exact Shapley 的距离、排序与 calibration；
2. **Decision value:** replace / query / suppress top-credit agent 或 edge 后，未来 matched
   episode 是否更好；
3. **Human cost:** 显式中断次数、时间、workload 与 trust。

这也避免把一个可计算 decomposition 误称为唯一因果解释。

## 4. EEG 基础模型：应怎样调查，而不是怎样选冠军

REVE 是当前最相关的候选之一：它用 3D electrode position 加 time 的 4D positional
encoding，在 92 个数据集、约 25,000 人和超过 60,000 小时 EEG 上进行 masked
autoencoding，并报告十项 downstream task [@elouahidi2025reve]。它解决了 montage
异构与跨任务预训练的现实问题，且代码、权重和教程公开。

但 offline task leaderboard 与 proposal 的 interface contract 并不一致。最新广泛
benchmark 评估 12 个开源 foundation model、13 个数据集和九种 BCI paradigm，结论是
linear probe 经常不够、specialist model 依然有竞争力、参数更大不意味着更好
[@liu2026eegfm]。CHIL 2026 的多维框架还发现，foundation model 在长上下文 sleep /
mental-health 任务的优势比短窗口 BCI 任务更稳定；在 channel-constrained 条件下仍
有限 [@kommineni2026multidimensional]。

Zare 的 2026 预印本应视为警报而非定论。它在一项 Korean dementia 任务上发现 frozen
REVE 的 AUROC 低于 classical feature，随机初始化 encoder 甚至更高；dataset identity
可从 embedding 近乎完美解码，而 diagnosis 接近随机。另一方面，在 CHB-MIT seizure
任务上，REVE 又明确优于随机初始化 [@zare2026stress]。正确结论不是“foundation model
无用”，而是任何 gain 都要通过 exposure、site identity、random initialization、
projection choice 与 subject split 的负对照。

因此 closed-loop readiness benchmark 至少要包含：

| 轴 | 推荐指标 |
|---|---|
| discrimination | subject-disjoint AUROC/AUPRC/balanced accuracy |
| calibration | Brier、NLL、ECE 和置信区间 |
| selective prediction | risk–coverage curve、rejected epoch 的错误率 |
| latency | 从事件 marker 到 verdict 的 median / p95，包括采集窗口 |
| fast adaptation | 0/1/5/10/20 个 subject label 下的曲线 |
| drift | change point 后恢复时间、累计 calibration error |
| shortcut | dataset/session identity probe、random init、label permutation |
| downstream utility | 固定 query budget 下的 Shapley error 或 intervention gain |
| compute | target hardware 的内存、能耗与吞吐 |

模型对比至少包括 classical ERP/LDA 或 shrinkage Gaussian、EEGNet 类 compact specialist、
REVE、另一个 topology-aware FM，以及随机初始化同架构。不要只比较 foundation models
之间的 leaderboard。

## 5. 可复用实现与最短原型路径

最有价值的代码不是一个“大一统仓库”，而是四类组件：

1. **Iturrate self-calibration repository**：提供 online/offline ErrP、robust likelihood
   与 task-constrained joint inference，是核心架构 baseline。
2. **Qin repositories**：提供 ADCT 多模态数据结构、EEG/瞳孔/语言/动作分析与 teammate
   action prediction，适合复现实验和设计数据接口。
3. **REVE 与 EEG-FM-Bench**：提供 encoder、预处理和多模型统一 wrapper。
4. **Braindecode / EEG-ExPy**：前者提供成熟 EEG dataset/window/model 生态，后者提供
   事件时序、刺激与廉价硬件 streaming 的实验骨架。

建议的 prototype 顺序是：

```text
GJC 事件日志与 marker
    -> acquisition / timestamp bridge
    -> preprocessing + artifact rejection
    -> classical / EEGNet / REVE 三路 encoder
    -> calibrated verdict {value, confidence, latency, rejected}
    -> Iturrate-style reliability update
    -> posterior agent/edge credit
    -> query / intervention policy
```

第一版不需要先训练 foundation model。应先用合成 observation channel 做完整 credit
architecture，把 capacity、drift、missingness 和 query budget 全部扫完；随后接入一个
经典 ErrP decoder，再接 compact model 与 REVE。这样 decoder 失败不会掩盖 architecture
是否成立。

## 6. 开放问题与研究计划

### 6.1 最高优先级问题

1. **Construct validity：** EEG 输出究竟是 surprise、objective error、agency，还是事后
   blame？在正交控制后还有多少 agent-specific 信息？
2. **Event definition：** 对长时间、多步依赖，哪个可观测事件触发 200–800 ms epoch？
3. **Identifiability：** 单次观测下，credit 与 drifting reliability 需要哪些最小 anchor？
4. **Incrementality：** EEG 是否在 task log、critic、pupil、HRV、gaze 和 action 之上
   增加真实 decision value？
5. **Gaming：** agent 是否能在现实 horizon 内学会操纵 workload/attention 来改变自身
   observed credit？
6. **Transfer：** GJC 的 exact replay 结果如何桥接到异步、语义事件和非确定性的 LLM-MAS？

### 6.2 建议的四阶段研究路线

**阶段 A：纯模拟器与定理。**

- 构建 bit-exact GJC；
- 对所有 coalition 计算 exact Shapley；
- 明确哪些 baseline estimator 需要多少次 counterfactual observation；
- 扫描 0–1 bit/event、不同 drift timescale、missingness 与 query budget；
- 给出 joint inference 的可识别性边界或反例；
- 构造 evaluator-gaming policy 并测试结构防御。

**阶段 B：受控神经科学 pilot。**

- 先做多 agent agency × correctness × surprise 因子任务；
- 同时记录 EEG、pupil、HRV、gaze 和 behaviour；
- 比较经典、compact 与 foundation encoder；
- 报告 calibration、risk–coverage、latency 和 session drift；
- 设置 cap-sham 与 information-sham。

**阶段 C：GJC 人类闭环。**

- counterbalance 人/AI 与 role；
- outcome-only、wide-channel、EEG、fusion、oracle 五类 baseline；
- 比较 random query、uncertainty query 与 workload-cost-aware query；
- 主要终点使用 task quality at fixed interruption budget；
- secondary endpoint 才是 decoder accuracy。

**阶段 D：LLM-MAS bridge。**

- 先使用 deterministic cache 和显式 agent-labelled event；
- 保留 replay 能力供 simulator audit，但每个人类事件只消费一次生理观测；
- 同时报告 attribution 与 intervention utility；
- 最后才进入自然、长时、异步 workflow。

### 6.3 Stop/go gates

- **Gate 1：** agency/agent identity 在控制 surprise 与 correctness 后仍可解码；
- **Gate 2：** 校准、拒绝和 p95 latency 满足任务 deadline；
- **Gate 3：** realistic session 内 joint credit/reliability posterior 可识别；
- **Gate 4：** EEG 在非神经 baseline 上增加 decision value 或减少 interruption；
- **Gate 5：** vulnerable design 中 evaluator gaming 可复现，防御后 true performance 不降；
- **Gate 6：** simulator credit gain 能预测人类或 LLM-MAS bridge task 的 intervention gain。

任何一个 gate 失败，都应收缩 claim，而不是继续扩大系统。特别是 Gate 1 失败时，仍可以
把 EEG 用作 global allocation gate；Gate 4 失败时，architecture 可能仍成立，但不应
声称“必须使用脑信号”；Gate 5 中如果 gaming 只在不现实参数下出现，则应将其降为理论
风险。

## 7. 推荐阅读路径

### 第一轮：六篇，先判断 proposal 是否站得住

1. **Qin et al. 2026**：只回答问题是否真实，重点看 WoZ、role confound、difficulty
   interaction 和 EEG event 选择 [@qin2026ai]。
2. **Iturrate et al. 2015**：理解 joint decoder/task inference；把它当必须击败的 baseline
   [@iturrate2015self]。
3. **Gómez-Andrés et al. 2024**：判断 agency 是否可单试次解码，并记录它需要多少被试内
   数据 [@gomez2024agency]。
4. **TRIAGE 2026（预印本）**：读 Proposition 1、fixed correction 的 covariance 条件和
   judge failure mode [@xu2026triage]。
5. **STABLEVAL 2026**：明确“posterior evaluator noise”已经被占据，以及多标注与单次
   序列设置的差异 [@bonagiri2026stableval]。
6. **DoVer 2026**：理解为什么 attribution accuracy 之外需要 intervention utility
   [@ma2026dover]。

### 第二轮：基础模型与闭环工程

按 REVE → Liu benchmark → Kommineni → Zare 的顺序阅读。先理解模型设计，再看统一比较，
最后看部署约束和负对照 [@elouahidi2025reve; @liu2026eegfm;
@kommineni2026multidimensional; @zare2026stress]。同时对照 Faller 与 Wilson，避免把
已有 adaptive aiding 写成 novelty [@faller2019arousal; @wilson2007adaptive]。

### 阅读每篇论文时固定回答五个问题

1. 它的 observation 可以重复吗？需要多少次 judge/rollout？
2. 它输出的是 label、reward、posterior、ranking 还是 intervention？
3. 可靠度是固定、离线估计，还是在线漂移？
4. missing / neutral / timeout / artifact 是否被区分？
5. 最终指标是 predictive accuracy，还是 closed-loop decision value？

把所有论文放进这五列后，proposal 与邻近工作的边界会比按“EEG / MARL / HCI”分类更清楚。

## 8. 一张可操作的证据矩阵

下面这张表可以直接用作下一轮组会或 proposal revision 的检查表。“支持”表示论文真的
测过该性质，“邻近”表示概念相关但实验条件不同，“不支持”表示不能把该论文当作这条
claim 的证据。

| 论文 | 单次事件 | agent-specific | 在线闭环 | 漂移可靠度 | 物理不可重放 | evaluator 可被 agent 改变 | 适合承担的角色 |
|---|---|---|---|---|---|---|---|
| Qin 2026 | 邻近 | 不支持 | 不支持 | 不支持 | 邻近 | 邻近 | 动机、任务与 difficulty regime |
| Qin 2025 | 不支持 | 预测 teammate action | 不支持 | 不支持 | 不支持 | 不支持 | 多模态行为/生理 baseline |
| Iturrate 2015 | 支持 | 不支持 | 支持 | 部分 | 支持 | 不支持 | joint self-calibration baseline |
| Gómez-Andrés 2024 | 支持 | self/other only | 不支持 | 不支持 | 支持 | 不支持 | construct-feasibility evidence |
| Faller 2019 | tonic state | 不支持 | 支持 | 个体校准 | 不适用 | 不支持 | sham-controlled closed loop |
| REVE 2025 | offline epoch | task label | 不支持 | 不支持 | 不支持 | 不支持 | candidate encoder |
| Liu 2026 | offline epoch | task label | 不支持 | few-shot only | 不支持 | 不支持 | model-selection benchmark |
| Zare 2026（预印本） | offline epoch | task label | 不支持 | 不支持 | 不支持 | 不支持 | shortcut negative controls |
| TRIAGE 2026（预印本） | segment | 支持 | training loop | judge 固定 | 不支持 | 不支持 | wide-channel upper baseline |
| STABLEVAL 2026 | item | system score | offline EM | annotator-specific | 不支持 | 不支持 | occupied posterior-noise prior art |
| DoVer 2026 | trial/segment | 支持 | replay intervention | judge-dependent | 不支持 | 不支持 | intervention-utility endpoint |
| Wilson 2007 | tonic state | 不支持 | 支持 | 个体阈值 | 不适用 | 不支持 | adaptive-aiding prior art |

矩阵里最明显的空列正是 proposal 要填的部分：没有已有系统同时覆盖 agent-specific、
online drift、physical non-repeatability 与 agent-actuated evaluator。如果最终实验只测
其中一两列，论文就会退化为相邻领域的增量组合。

## 9. 三周深入调查安排

### 第 1 周：确认构念和最近邻

**Day 1–2：Qin 2026。** 画出实验设计图，标注 between/within-subject factors、团队数量、
角色分配、事件终止条件、EEG 分析的 trial selection。单独写一页“这篇论文没有证明什么”。

**Day 3：Gómez-Andrés 2024。** 复核三个类别如何构造、每类 trial 数、within-subject
训练/测试方式，以及 0.65 accuracy 对 class prior 的含义。把 ERN 与 P600 时间窗映射到
proposal 的 `EpochVerdict.latencyMs`。

**Day 4–5：Iturrate 2015。** 阅读 likelihood、hidden goal、decoder parameter 与 planner
如何耦合；运行仓库 paper release，列出迁移到 GJC 时必须替换的 task constraints。

第 1 周结束时只回答一个问题：是否有足够证据值得开展 multi-agent agency pilot？如果
答案仍依赖“ErrP 一般能检测错误”，说明 construct 调查还不够。

### 第 2 周：划定 ML novelty

**Day 1–2：TRIAGE。** 推导 role-measurable correction，特别检查
\(\mathrm{Cov}(c_{\hat\rho},\delta)>0\) 的经验可测替代量。列出它使用而生理通道不可获得的
资源：多 rollout、future context、verifier、thinking judge。

**Day 3：STABLEVAL。** 重写其 graphical model，再把 annotator index 替换成 time-varying
state，观察哪里失去足够统计量。特别关注 low annotation density 的失败区间。

**Day 4：DoVer。** 把 failure flip、milestone progress 与 hypothesis validation 映射成
GJC 可实现的 intervention metrics。

**Day 5：MARL 基础。** 快速复习 VDN、QMIX、COMA、Shapley Q-value，只追踪每个方法需要
哪些反事实、价值函数或重复状态，不必做一般 MARL 大综述。

第 2 周产出应是一页 claim table：每一条 proposal claim 旁边写 closest prior art、
different assumption、measurable consequence 和 falsification test。

### 第 3 周：决定 decoder 与实验接口

**Day 1：REVE。** 跑通一个公开 downstream task，记录 preprocessing、montage mapping、
embedding shape、inference latency 与显存。

**Day 2：EEG-FM benchmark。** 对照 Liu 与 EEG-FM-Bench 的 wrapper，挑选一个 compact
specialist、一个 topology-aware FM 和一个 classical baseline。

**Day 3：负对照。** 实现 random initialization、label permutation、dataset/session
identity probe；确认 split 是 subject/team-disjoint。

**Day 4：校准与拒绝。** 确定 Brier、NLL、ECE、risk–coverage、artifact rejection 和
change-point recovery 的统一计算方式。

**Day 5：冻结接口。** 只有当所有模型都能输出
`{value, confidence, latencyMs, artifactRejected}`，才开始比较 downstream credit
utility。接口冻结后不要为某个模型改 metric。

三周后应该能够做出 go / revise / stop 的判断，而不仅是拥有更多论文。

## 10. 后续检索式

为了避免检索结果被 “EEG emotion recognition” 或一般 MARL 淹没，可把问题拆成下面几组：

- `"error related potential" AND agency AND single trial`
- `"observational ErrP" AND human robot interaction AND online`
- `"self calibration" AND ErrP AND latent decoder`
- `"expectation violation" AND EEG AND responsibility`
- `"multi-agent credit assignment" AND counterfactual AND replay`
- `"agent trajectory" AND intervention AND failure attribution`
- `"noisy evaluator" AND posterior credit AND calibration`
- `"EEG foundation model" AND few-shot AND subject-independent`
- `"EEG foundation model" AND calibration OR abstention OR latency`
- `"adaptive automation" AND workload AND closed loop`
- `"reward hacking" AND human evaluator AND workload`
- `"performative prediction" AND evaluator manipulation`

检索时优先保留能回答 assumption、measurement、intervention 或 failure mode 的论文；仅仅在
摘要里同时出现 EEG 和 AI 的论文不应进入核心集合。

## 11. 总结

当前文献并没有否定 proposal，反而帮助它从一个过宽的“脑信号增强多智能体系统”想法，
收缩成一个更清楚的研究问题。最稳的核心是：**在物理单次、低信息、会漂移且内生的观测
通道下，哪些 credit estimator 仍然有效，怎样量化不确定性，以及怎样阻止被评对象操纵
测量过程。**

EEG 是这个问题最有挑战也最有说服力的实例，但它必须通过 neural increment gate。
foundation model 是实现候选，但必须通过 closed-loop contract，而不能由 offline
accuracy 代替。Exact Shapley 提供模拟器中的审计标准，但实际价值必须由后续干预和人类
成本共同验证。按照上述 stop/go 顺序推进，可以在最小成本下尽早发现核心假设是否成立，
也能让最终论文的 architecture claim 不依赖某一个 decoder 恰好表现很好。

## References

完整 BibTeX 见 `references.bib`。
