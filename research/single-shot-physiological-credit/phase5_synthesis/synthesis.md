# Phase 5 — Synthesis

## 1. 研究版图：六条原本分离的线

| 研究线 | 已经知道什么 | proposal 需要新增什么 | 最近的锚点 |
|---|---|---|---|
| 人–AI 团队生理 | AI 身份认知可在能力不变时改变沟通、唤醒与团队绩效；困难任务效应更强 | 从相关性走向事件级、可干预的信用信号 | Qin 2026；Qin 2025 |
| ErrP / agency | 单次 EEG 可分辨错误，且有初步证据区分 self/other agency | 从 self/other 扩展到多个耦合智能体；输出需校准、可拒绝、低延迟 | Gómez-Andrés 2024；Iturrate 2015 |
| 自适应自动化 | 实时生理状态触发辅助早已能改善绩效 | 证明这里是“智能体改变评估器可靠度”的测量回路，不是普通 workload adaptation | Pope 1995；Wilson & Russell 2007；Faller 2019 |
| EEG 基础模型 | 大规模预训练改善了跨 montage/任务迁移的可能性 | 闭环接口评测：ECE/Brier、延迟、缺失、漂移、few-shot、下游效用 | REVE 2025；Liu 2026；Kommineni 2026；Zare 2026 |
| 多智能体信用 | 语义角色、过程奖励、counterfactual replay 可细化 trajectory reward | 物理单次观测下的后验反演；不能依赖多 rollout、冻结 seed 或 future replay | TRIAGE 2026；DoVer 2026 |
| 噪声评估器 | 混淆矩阵、EM、posterior expected credit 可稳定多标注者评估 | 同一人的可靠度在线漂移，每个事件只有一次观测，且缺失有语义 | STABLEVAL 2026 |

## 2. 概念上的关键区分

### 2.1 不是“从 EEG 读出真正的 Shapley 值”

生理信号最多提供一个关于“预期是否被违反、可能归因到哪里”的嘈杂观测。真正的
Shapley 值只在 replay-exact simulator 中可计算。人类实验中的输出应被表述为
**posterior credit under an observation model**，而不是神经信号直接编码了 causal
credit。

### 2.2 phasic verdict 与 tonic state 不能合并

- **Phasic:** 绑定明确事件起点，200–800 ms 后产生一次 verdict；可缺失；用于更新
  credit posterior。
- **Tonic:** 秒到数十秒的 workload/engagement；用于条件化 phasic 可靠度、决定何时
  查询、解释缺失，但不直接分配信用。

这一区分不仅是神经科学分类，也是软件接口和因果图的边界。

### 2.3 attribution accuracy 与 intervention utility 是两个终点

在模拟器中可以对比 exact Shapley；在人类或 LLM-MAS 场景中，还要问：基于最高后验
信用采取干预后，后续匹配情形是否更好？DoVer 表明多个干预可能修复同一失败，因此
“唯一正确归因”常常过强。

## 3. Proposal 的新颖性强度

| 候选 claim | 强度 | 结论 |
|---|---:|---|
| AI teammate 会改变人类生理和绩效 | 低 | 已由 Qin 等占据，只能作为动机 |
| 使用 ErrP 发现错误 | 低 | 成熟文献；不能成为标题贡献 |
| 单次 EEG 能含 agency 信息 | 中低 | Gómez-Andrés 已给出 self/other 单试次证据 |
| 无长校准的在线 ErrP | 中低 | Iturrate 已展示 joint self-calibration |
| 用生理状态自适应自动化 | 低 | 至少自 1990s 已有；Faller 有闭环和 sham |
| 给噪声评估器建混淆矩阵并输出 posterior credit | 低 | STABLEVAL/Dawid–Skene 类工作已占据 |
| 用局部 judge 做 agent-step credit | 低 | TRIAGE、process rewards 等已占据 |
| 对 replay-exact simulator 计算 exact Shapley | 中 | 有价值的审计基础，但不是单独的理论新颖性 |
| 物理不可重放的单次通道使既有 estimator 未定义 | 高 | 最清楚、最稳的 moat；必须形式化到 estimator assumptions |
| 同时估计漂移可靠度与多智能体 credit 后验 | 中高 | 有先例碎片，但组合与在线约束仍有空间 |
| agent 通过 workload 改变自身评估通道并可进行 evaluator gaming | 高 | 与普通 adaptive aiding 不同；需因果构造和实验展示 |
| closed-loop readiness 作为 EEG-FM 新 benchmark | 中高 | 前提是评测真正覆盖动态、校准、缺失和下游效用 |

## 4. 最稳的论文叙事

1. **形式化缺口。** 明确列出 repeatable verifier 方法需要的调用次数/冻结状态，并证明
   在每个真实事件只有一次观测时这些 estimator 不是“噪声更大”，而是输入不完备。
2. **模拟器审计。** 在 replay-exact GJC 中计算 exact Shapley，先完全绕开 EEG decoder，
   扫描 0–1 bit/event、漂移速率、missingness、query budget。
3. **观测模型。** 建模
   \(p(o_t\mid z_t,w_t,e_t,\theta_t)\)，其中 \(\theta_t\) 漂移，artifact rejection 是单独
   符号；显式查询只用于稀疏锚定。
4. **耦合与防御。** 建立
   \(a_t\rightarrow w_t\rightarrow\theta_t\rightarrow o_t\rightarrow\hat c_t\) 的可利用路径，
   展示优化器确实会找到“让监督者更糟从而让自己看起来更好”的策略，再用结构约束阻断。
5. **人类可行性。** 不一开始承诺完整 LLM-MAS。先验证多主体 agency-ErrP、接口指标和
   neural increment；之后才做完整闭环。

## 5. 基线矩阵

| 维度 | 必须包含的基线 |
|---|---|
| 信号 | outcome-only；timeout-only；行为/鼠标/眼动；自主 critic；EEG；多模态融合 |
| decoder | 经典 ERP/LDA 或 shrinkage Gaussian；EEGNet 类紧凑模型；REVE；随机初始化同架构 |
| calibration | 固定混淆矩阵；Iturrate-style joint calibration；漂移状态空间模型；oracle reliability |
| credit | uniform/team reward；局部 heuristic；TRIAGE 类 wide-channel judge；posterior credit；oracle Shapley |
| querying | random；uncertainty-only；workload-cost-aware；oracle value of information |
| coupling | workload exogenous；agent-actuated workload；允许 gaming；结构阻断 |
| validation | Shapley distance；calibration；ranking；future intervention utility；human interruption cost |

## 6. 时间线

- **1995–2007:** EEG/psychophysiology-driven adaptive automation establishes workload-aware aiding.
- **2015:** Iturrate demonstrates closed-loop self-calibrating ErrP control from task constraints.
- **2019:** Faller adds stronger closed-loop arousal neurofeedback with sham and silence controls.
- **2024:** Single-trial agency attribution becomes directly decodable in a controlled self/other task.
- **2025:** Team physiology predicts action/performance; EEG foundation models scale sharply; DoVer
  reframes debugging around interventions.
- **2026:** Human–AI identity effects in ADCT, standardized EEG-FM benchmarks, posterior evaluator
  credit, and role-typed agent credit narrow the novelty space.
- **Remaining opening:** treat a physiological evaluator as a single-shot, drifting, endogenous
  observation channel inside an audited multi-agent credit architecture.

## 7. Overall verdict

The proposal is not novel because it uses EEG, ErrPs, a foundation model, Shapley values, workload
adaptation, or a noisy evaluator. It is potentially novel because it treats these as one constrained
inference system and makes **non-repeatability** and **endogenous evaluator reliability** first-class
properties. The paper succeeds if it proves those properties change what estimators are valid and
what policies emerge; it weakens sharply if it is presented as a better decoder or another adaptive
BCI.

