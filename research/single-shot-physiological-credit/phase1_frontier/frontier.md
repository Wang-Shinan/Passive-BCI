# Phase 1 — Frontier map

Date: 2026-07-30

## Scope

The proposal sits at the intersection of four fast-moving fronts:

1. single-trial error/expectation-violation decoding;
2. calibration-free and drifting EEG decoders;
3. credit and failure attribution in LLM multi-agent systems;
4. uncertainty-aware evaluation and EEG foundation-model benchmarking.

The frontier search prioritised 2025–2026 peer-reviewed papers and then added
very recent preprints when they directly occupy a novelty claim.

## Recent papers

1. **Qin, Lee & Sajda (2026), “Covert perception of AI adversely impacts team
   performance and changes physiological dynamics despite human-level AI
   competence,” npj Artificial Intelligence.** Wizard-of-Oz evidence that an
   AI label can worsen performance while capability is held constant; directly
   supports the proposal’s human-team motivation.
2. **Zare (2026), “Stress-Testing EEG Foundation Models for Clinical Decoding:
   Dataset Identity and Targeted Negative Controls” (preprint).** Shows that
   classical features or even random initialisation can beat pretrained EEG
   encoders on some tasks, and that dataset identity can dominate embeddings.
3. **Kontras et al. (2026), “NeuroAtlas: Benchmarking Foundation Models for
   Clinical EEG and Brain-Computer Interfaces” (preprint).** A 42-dataset,
   260k-hour benchmark finding mostly narrow advantages for present EEG
   foundation models.
4. **Liu et al. (2026), “EEG Foundation Models: Progresses, Benchmarking, and
   Open Problems” (preprint).** Reviews 50 models and benchmarks 12; specialist
   models remain competitive and scale does not guarantee transfer.
5. **Kommineni et al. (2026), “A Multi-dimensional Framework for Evaluating
   Generalization in EEG Foundation Models,” CHIL/PMLR.** Reframes FM
   evaluation around explicit generalisation dimensions rather than one pooled
   downstream score.
6. **El Ouahidi et al. (2025), “REVE: A Foundation Model for EEG—Adapting to
   Any Setup with Large-Scale Pretraining on 25,000 Subjects,” NeurIPS.**
   Large heterogeneous pretraining with flexible electrode and duration
   encoding; an important positive case for cross-setup transfer.
7. **Fang et al. (2025), “NeurIPT: Foundation Model for Neural Interfaces,”
   NeurIPS.** Uses physical electrode coordinates, amplitude-aware masking and
   progressive experts across nine BCI datasets.
8. **Ma et al. (2026), “DoVer: Intervention-Driven Auto Debugging for LLM
   Multi-Agent Systems,” ICLR.** Treats attribution hypotheses as interventions
   and verifies whether controlled edits repair failures; explicitly challenges
   unstable human step-level ground truth.
9. **Bonagiri et al. (2026), “CausalFlow: Causal Attribution and
   Counterfactual Repair for LLM Agent Failures” (preprint).** Computes
   intervention-based responsibility scores and validated repairs from failed
   traces.
10. **Xu et al. (2026), “TRIAGE: Role-Typed Credit Assignment for Agentic
    Reinforcement Learning” (preprint).** Adds role-conditioned process credit
    to outcome reward and formalises when role labels reduce advantage error.
11. **Li et al. (2026), “Who Deserves the Reward? SHARP: Shapley Credit-based
    Optimization for Multi-Agent System” (preprint).** Uses Shapley-motivated
    agent advantages for training LLM multi-agent systems, but relies on
    repeatable rollouts and verifier-based rewards.
12. **Bonagiri et al. (2026), “STABLEVAL: Disagreement-Aware and Stable
    Evaluation of AI Systems,” ICML.** Models annotator confusion and latent
    item correctness to obtain posterior expected credit and stable rankings.
13. **Yang et al. (2025), “Who Gets the Reward & Who Gets the Blame?
    Evaluation-Aligned Post-Training for Multi-LLM Agents,” NeurIPS LAW
    workshop.** Maps system evaluation to Shapley agent credit and then
    message-level learning signals; conceptual rather than empirically
    validated.
14. **Zhang et al. (2025), “AFlow: Automating Agentic Workflow Generation,”
    ICLR oral.** Searches code-represented workflows with repeated evaluations;
    relevant mainly as a contrast because its noise route is repeated sampling.
15. **Haxel et al. (2025), “EDAPT: Towards Calibration-Free BCIs with
    Continual Online Adaptation” (preprint).** Population pretraining plus
    continual supervised updating across nine datasets, with sub-200-ms update
    cost.
16. **Gómez-Andrés et al. (2024), “Decoding agency attribution using
    single-trial error-related brain potentials,” Psychophysiology.** Decodes
    self- versus externally generated errors, showing that the neural target
    may be richer than a binary error label.
17. **Lopes-Dias et al. (2024), “A generic error-related potential classifier
    based on simulated subjects,” Frontiers in Human Neuroscience.** Reports
    cross-dataset balanced accuracies around 63–73% and directly targets reduced
    subject calibration.
18. **Vanneste et al. (2025), “Error-related potentials in EEG signals:
    feature-based detection for human-robot interaction,” Scientific Reports.**
    A recent HRI-focused ErrP decoding study relevant to artefact and
    deployment controls.

## Frontier trends

- **Benchmark scepticism is now mainstream.** The important EEG-FM question is
  no longer “does pretraining help somewhere?” but “under which split,
  adaptation budget, latency, calibration and negative controls does it help?”
- **Agent attribution is moving from explanation to intervention.** DoVer and
  CausalFlow judge attribution by whether a controlled edit repairs the
  failure, not by agreement with a human label.
- **Posterior evaluation is occupied.** STABLEVAL makes uncertainty-aware
  inversion of noisy evaluators an explicit contribution. Novelty must rest on
  the single-shot physical channel, drift and graph-structured credit.
- **Richer error targets are plausible.** Agency-attribution ErrPs suggest a
  path from a binary violation bit toward “whose/what kind of error,” but this
  is early and paradigm-specific.
- **The strongest opportunity is an evaluation protocol, not a bigger
  decoder.** Calibration curves, bounded latency, rejection-as-absence,
  closed-loop drift and downstream decision value remain poorly covered by
  current EEG leaderboards.

## Active groups and useful anchors

- Paul Sajda’s group: team physiology, human–AI teaming and neuroadaptive
  systems.
- Giulia Lioi / Karim Jerbi / REVE collaborators: heterogeneous EEG
  foundation-model transfer.
- Braindecode ecosystem: reproducible EEG decoding and model integration.
- Recent agent-attribution groups around DoVer, CausalFlow, TRIAGE and SHARP:
  intervention, role typing and game-theoretic credit.

## Immediate implication for the proposal

The proposal is directionally well positioned, but two claims need especially
careful wording:

1. posterior inversion of evaluator noise is not new after STABLEVAL;
2. exact attribution accuracy is not accepted as the only useful end metric
   after DoVer/CausalFlow—intervention value should be added as a secondary
   metric even if exact Shapley remains the simulator audit.
