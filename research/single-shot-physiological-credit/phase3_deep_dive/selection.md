# Phase 3 — Core-paper selection

Selection date: 2026-07-30

The papers below were chosen because each tests a load-bearing premise of the proposal rather than
merely sharing vocabulary with it. Together they cover the motivating human–AI effect, whether an
EEG channel can be decoded at the required granularity, online calibration, observation-model
uncertainty, agent credit assignment, intervention-based validation, and EEG foundation-model
transfer.

| Priority | Paper | Why it is load-bearing |
|---:|---|---|
| 1 | Qin, Lee & Sajda (2026), *Artificial intelligence negatively impacts team performance through altered human behaviours and physiology* | Supplies the exact motivating deficit and task family; must be checked for design confounds and what physiology was actually decoded. |
| 2 | Iturrate et al. (2015), *Self-calibration for a brain–computer interface using error-related potentials and reinforcement learning* | Closest demonstration that sparse ErrP observations and task constraints can jointly identify a decoder and goal online. |
| 3 | Gómez-Andrés et al. (2024), *Decoding agency attribution using single trial error-related brain potentials* | Directly probes whether single-trial EEG distinguishes self-caused from externally caused errors, the closest physiological analogue to agent-specific credit. |
| 4 | Faller et al. (2019), *Regulation of arousal via online neurofeedback improves human performance in a demanding sensory-motor task* | Establishes a closed-loop physiological intervention in a related task and provides sham/silence controls. |
| 5 | REVE (El Ouahidi et al., 2025), *A Foundation Model for EEG* | A leading candidate substrate for cross-montage, low-calibration EEG decoding; reveals the gap between offline transfer and closed-loop readiness. |
| 6 | Liu et al. (2026), *EEG Foundation Models: Progresses, Benchmarking, and Open Problems* | Broad, standardized benchmark that prevents choosing a foundation model from headline accuracy alone. |
| 7 | Zare (2026), *Stress-Testing EEG Foundation Models for Clinical Decoding* | Uses targeted negative controls and dataset-identity probes; informs the proposal’s benchmark contract and anti-shortcut tests. |
| 8 | TRIAGE (Xu et al., 2026), *Role-Typed Credit Assignment for Agentic Reinforcement Learning* | Closest current work on semantic per-segment agent credit; its covariance condition states exactly when a noisy judge helps or harms. |
| 9 | STABLEVAL (Bonagiri et al., 2026), *Disagreement-Aware and Stable Evaluation of AI Systems* | Occupies the generic “posterior credit under evaluator noise” territory and sharpens what must be novel about single-shot, drifting inversion. |
| 10 | DoVer (Ma et al., 2026), *Intervention-Driven Auto Debugging for LLM Multi-Agent Systems* | Challenges attribution accuracy as the only endpoint and motivates intervention utility as a complementary validation criterion. |
| 11 | Wilson & Russell (2007), *Performance enhancement in an uninhabited air vehicle task using psychophysiologically determined adaptive aiding* | Strong prior art for workload-triggered adaptive automation; constrains novelty claims about tonic closed-loop adaptation. |

## Reading order

1. **Problem reality:** Qin 2026 → Faller 2019.
2. **Can the channel carry the intended variable?** Gómez-Andrés 2024 → Iturrate 2015.
3. **Can a pretrained model satisfy the interface?** REVE 2025 → Liu 2026 → Zare 2026.
4. **What is already occupied in credit/evaluator modeling?** TRIAGE 2026 → STABLEVAL 2026.
5. **How should attribution be validated?** DoVer 2026.
6. **What is old prior art rather than novelty?** Wilson & Russell 2007.

