# Phase 2 — Survey landscape

Date: 2026-07-30 | Curated papers: 50

## Search strategy

Queries were expanded around the proposal’s actual estimator assumptions, not
only its keywords:

- `"single-trial ErrP" AND cross-subject AND online`
- `"calibration-free BCI" AND drift`
- `"EEG foundation model" AND benchmark AND generalization`
- `"multi-agent credit assignment" AND Shapley AND counterfactual`
- `"agent failure attribution" AND intervention`
- `"adaptive automation" AND EEG AND workload`
- `"human AI teammate" AND physiology AND performance`
- `"annotator confusion" AND posterior credit`

The database contains 50 papers: foundational peer-reviewed work, recent
conference papers, and a small set of directly relevant 2025–2026 preprints.
Preprints are marked in `paper_db.jsonl`.

## Theme A — Human–AI team physiology and the GJC/ADCT substrate

Key papers: Qin et al. 2025 and 2026; Faller et al. 2019; the 2025 commitment
deficit study.

What is established:

- physiology and behavior in a triadic distributed-control task contain
  information about team coordination;
- merely labelling a capable teammate as AI can worsen intermediate/hard-task
  performance;
- arousal neurofeedback can improve demanding sensorimotor performance under
  veridical but not sham feedback.

What is not established:

- per-agent causal credit from physiology;
- closed-loop improvement of a human–AI team by such credit;
- whether phasic EEG adds value over synchronized task state, webcam, pupil and
  controller traces.

## Theme B — ErrP and expectation-violation channels

Key papers: Ferrez & Millán 2008; Chavarriaga & Millán 2010; Iturrate et al.
2015; Salazar-Gomez et al. 2017; Gómez-Andrés et al. 2024; Lopes-Dias et al.
2024; Vanneste et al. 2025.

The literature already supports single-trial decoding, online correction,
self-calibration from task constraints, and cross-subject generic classifiers.
The 2024 agency-attribution result is especially important because it suggests
that self/other error source can be separable. However, published paradigms
mostly concern a single device/robot action or binary correctness. They do not
solve graph-structured per-agent credit after one jointly caused event.

The realistic engineering range is roughly the proposal’s assumed regime:
generic balanced accuracies in the 60s–low 70s are common, while
subject-specific and tightly controlled paradigms can do better.

## Theme C — EEG foundation models and benchmarking

Key model papers: BENDR, BIOT, LaBraM, EEGPT, CBraMod, REVE, NeurIPT, LUNA,
BrainOmni.

Key benchmark/critique papers: Liu et al. 2026, EEG-Bench, NeuroAtlas,
Kommineni et al. 2026, Zare 2026.

The field’s centre of gravity has shifted from proposing another encoder to
testing transfer under realistic axes. The emerging consensus is:

- specialist models remain competitive;
- linear probing can understate or distort model value;
- model size does not guarantee cross-subject or cross-dataset transfer;
- dataset identity and preprocessing can dominate learned representations;
- clinical or operational metrics can change model ranking.

This directly supports a “closed-loop readiness” benchmark, but the benchmark
must add genuinely new axes: latency, calibration curve, confidence
calibration, epoch rejection semantics, and drift after the policy changes the
data distribution.

## Theme D — Multi-agent credit and failure attribution

Foundational MARL: VDN, COMA, QMIX, QTRAN and Shapley Q-value.

LLM-agent frontier: DyLAN, GPTSwarm, AFlow, Who Gets the Reward, SHARP,
TRIAGE, DoVer, CausalFlow, Shapley-Coop and HiveMind.

Three families should be kept distinct:

1. **Value factorisation/counterfactual baselines** learn repeated state-action
   structure from many episodes.
2. **Shapley workflow attribution** re-executes masked coalitions or sampled
   permutations.
3. **Intervention-driven debugging** changes a suspected step and checks
   whether the outcome flips.

The proposal’s strongest boundary is physical non-repeatability: none of these
methods can recreate another neural observation of the original human event.
But they can still rerun the software pipeline. The paper must therefore state
which object is non-repeatable: the human observation, not necessarily the
agent trace.

## Theme E — Noisy evaluators and human feedback

Key papers: Dawid–Skene, TAMER, Deep TAMER, COACH and STABLEVAL.

Two lessons:

- temporal credit for delayed human feedback has a long history, so a
  “single-shot human signal” alone is not novel;
- modelling evaluator reliability and propagating a posterior is explicitly
  occupied by STABLEVAL and historically rooted in Dawid–Skene.

The remaining gap is the combination of one physical observation per event,
within-session reliability drift, an explicit absence symbol, graph-structured
credit and a policy that changes evaluator reliability.

## Theme F — Adaptive automation and actuated supervisor state

Key papers: Pope et al. 1995; Wilson & Russell 2007; Aricò et al. 2016; Zander
& Kothe 2011.

This literature already owns:

- EEG-driven automation changes;
- two-sided concerns about overload and disengagement;
- individual calibration;
- sham/yoked or random-aiding controls;
- performance gains in realistic operator tasks.

The proposal should not claim novelty for workload band-keeping. Its plausible
new contribution is the incentive topology:

`agent action → workload/engagement → phasic-channel reliability → apparent
agent credit → next action`.

The research burden is to show that this topology creates an exploit that does
not arise when physiology only controls task assistance.

## Overall conclusion

The proposal is strongest when presented as a three-part interface problem:

1. **measurement:** one calibrated phasic observation plus explicit absence;
2. **inference:** posterior graph credit audited against exact simulator truth;
3. **control:** query allocation and policy constraints that prevent
   evaluator degradation.

It is weakest if framed as a new ErrP decoder, a new Shapley operator, a first
noisy-evaluator posterior, or a first EEG workload loop.
