# Phase 3 — Deep-dive notes

These notes separate what each paper actually demonstrates from what the proposal would need it to
demonstrate. “Implication” is therefore intentionally stricter than the original authors’ framing.

## 1. Qin, Lee & Sajda (2026) — AI negatively impacts team performance

**Question.** Does believing that a capable teammate is AI alter team performance and physiology
when the teammate’s actual competence is held constant?

**Methodology.** The study used the Apollo Distributed Control Task (ADCT), in which yaw, pitch and
thrust control are distributed across teammates under partial observability. A Wizard-of-Oz expert
always filled the thrust role and was described either as human or AI. Communication conditions
varied within the broader design. EEG was recorded with 20 channels at 256 Hz and processed with
MNE, bad-channel handling and ICA. Four-second epochs around successful ring passages were used for
neural synchrony analyses.

**Experiments and results.** Ninety-five participants were recruited, but the analysed team samples
were much smaller after grouping and data-quality exclusions: 18 human-only triads, 12 human dyads,
and 6 dyads in the AI/expert context. Total team performance was worse in the supposed-AI condition
despite the confederate’s competence being held fixed (reported \(T(28)=4.893, p<.0001\)). The
difference was not significant on easy trials but was large on intermediate and hard trials.
Communication frequency/duration decreased and physiological/behavioural coordination changed.

**Strengths.** Capability is better controlled than in comparisons between different artificial
and human policies. The difficulty interaction gives a useful regime boundary rather than a
blanket “AI hurts teams” statement.

**Limitations.**

- Agent identity is confounded with role: the disguised expert always controls thrust.
- A miss/collision/timeout terminates the trial, limiting repeated post-error events.
- The EEG analysis is not an online, per-event ErrP decoder and emphasizes successful ring passages.
- Small effective team counts and EEG exclusions weaken generalization.

**Implication for the proposal.** This paper justifies the *problem setting*, not the proposed
credit channel. Gated Joint Control must counterbalance role and agent identity, retain failure
events, and pre-register event onsets. The strongest replication target is the difficulty-dependent
team deficit, not the paper’s neural-synchrony statistic.

## 2. Iturrate et al. (2015) — Self-calibrating ErrP BCI

**Question.** Can a BCI learn both a user-specific ErrP decoder and the user’s intended goal without
an explicit calibration block?

**Methodology.** Eight participants moved a cursor on a \(5\times5\) grid. The system chose among
five actions and observed one EEG response after each action. Recordings used 16 electrodes at
256 Hz; the classifier used Fz, FCz and Cz activity in the 200–800 ms interval after an action,
filtered to 1–10 Hz and represented by 57 features. A Gaussian classifier with covariance
shrinkage was embedded in a reinforcement-learning formulation that jointly inferred the hidden
target and decoder parameters from navigation constraints.

**Experiments and results.** Participants completed roughly 500 system actions over about 50
minutes. The first goal took on average 165 actions to reach; after self-calibration, later goals
required about \(60\pm24\) actions. Across participants the system reached an average of 6.88
correct targets and 1.50 incorrect targets.

**Strengths.** It is genuinely online and avoids a separate labelled calibration phase. It treats
the decoder and task state as coupled latent variables rather than freezing classifier accuracy.

**Limitations.** The grid and goal set provide unusually strong constraints; the error/correct
ratio is uncontrolled; there is one action-producing system rather than several interdependent
agents; “reaching the target” is easier to identify than allocating causal credit in a graph.

**Implication for the proposal.** This is the closest architectural ancestor of online inversion.
The proposal must distinguish itself through physical single-shot non-repeatability, multi-agent
posterior credit, drifting reliability, and explicit missingness. A mandatory baseline is an
Iturrate-style joint latent-state model adapted to GJC.

## 3. Gómez-Andrés et al. (2024) — Single-trial agency attribution

**Question.** Does a single EEG trial contain information distinguishing a self-generated error
from an externally generated error?

**Methodology.** Twenty-five participants performed a modified flanker task; 23 remained after
excluding two with too few self-error trials. A standard block contained 160 congruent trials;
two error-induction blocks contained 640 trials with incongruent visual feedback on 10% of trials.
EEG used 27 scalp electrodes at 250 Hz. For within-subject decoding, Correct, self-error and
external-error classes were balanced to 33 trials each. Linear SVMs used response-locked
spatiotemporal activity, with early ERN and later P600 periods providing distinct information.

**Experiments and results.** A model using the fuller temporal waveform achieved mean three-class
accuracy \(0.65\pm0.11\) (range 0.50–0.83), versus \(0.44\pm0.03\) for time-point models. Early
frontal activity was most informative for self-errors; later parietal activity contributed to
external-error attribution.

**Strengths.** It targets *agency of error*, not merely error versus correct, and reports
single-trial within-person classification with an explicit class balance.

**Limitations.**

- It uses hundreds of trials and subject-specific training; it is not zero/few-shot transfer.
- External errors are experimentally injected and temporally clean, not emergent failures in a
  coupled multi-agent trajectory.
- Three-way 65% accuracy is not evidence of calibrated probabilities, low latency, robustness to
  artifacts, or within-session drift.
- “Self versus other” still does not identify which of several other agents is responsible.

**Implication for the proposal.** This is the best evidence that the physiological target is not
impossible, but it also shows why the neural verdict should be a noisy *allocator* rather than a
reward. A decisive pilot should test whether the P600/ERN agency separation survives multiple
machine agents and ambiguity about causal responsibility.

## 4. Faller et al. (2019) — Closed-loop arousal neurofeedback

**Question.** Can online EEG-based arousal feedback improve performance in a demanding
boundary-avoidance task?

**Methodology.** Forty people were recruited and 18 passed screening/data criteria. After about
10 minutes of individual calibration, a linear EEG decoder estimated arousal during a virtual
reality navigation task. Within subjects, attempts were randomly assigned to veridical BCI
feedback, sham feedback, or silence. Participants completed 24 attempts under easier and harder
conditions.

**Experiments and results.** Veridical feedback improved performance in the hard condition, with
concurrent higher heart-rate variability and smaller pupils; it did not improve the easy
condition. Sham and silence conditions help separate informative feedback from the mere presence
of an added cue.

**Strengths.** Real-time closed-loop operation, individual calibration, random within-subject
controls, and convergent autonomic measures.

**Limitations.** The intervention adds an audible feedback channel to the person; it does not
constrain an agent policy. Screening removed many low performers and participants unsuitable for
EEG/VR, producing a selective sample. The decoded variable is tonic arousal, not phasic credit.

**Implication for the proposal.** It supports feasibility and sham-control design, but it occupies
“physiology-triggered task adaptation improves performance.” The proposal’s distinct claim must be
that agents actuate the reliability of the *measurement channel*, creating evaluator gaming, and
that the architecture blocks this path.

## 5. REVE (El Ouahidi et al., 2025) — EEG foundation model

**Question.** Can large-scale pretraining yield EEG representations that transfer across
electrode layouts, durations and downstream tasks?

**Methodology.** REVE uses masked autoencoding and a four-dimensional positional encoding combining
three-dimensional electrode location with time. Pretraining covers more than 60,000 hours, 92
datasets and approximately 25,000 subjects. Adaptation uses linear probing or structured
fine-tuning, augmentation, low-rank adaptation and model souping depending on the task.

**Experiments and results.** The NeurIPS paper reports evaluation on ten tasks including motor
imagery, seizure detection, sleep staging, cognitive load and emotion, with strong few-shot and
cross-setup results. Code, weights and tutorials are released.

**Strengths.** Heterogeneous pretraining and a montage-aware representation directly address
practical EEG fragmentation. The released implementation makes a realistic baseline.

**Limitations relative to this proposal.** The benchmarks are offline and optimize task metrics,
not verdict latency, probability calibration, artifact rejection, missingness semantics, session
drift, or closed-loop utility. Model size and tokenization can also conflict with bounded-latency
deployment.

**Implication for the proposal.** REVE should be a candidate encoder, not a presumed solution. The
new benchmark should score the entire interface contract: cross-subject calibration, expected
calibration error/Brier score, latency distribution, abstention quality, drift recovery, and
downstream credit utility at fixed interruption budget.

## 6. Liu et al. (2026) — EEG foundation-model benchmark and survey

**Question.** Under standardized protocols, do EEG foundation models generalize better than
specialist models and require less subject calibration?

**Methodology.** The work reviews 50 models and empirically evaluates 12 open-source foundation
models plus specialist baselines on 13 datasets spanning nine BCI paradigms. It separates
leave-one-subject-out generalization from within-subject few-shot adaptation and compares linear
probing with full fine-tuning.

**Experiments and results.** Three robust conclusions are reported: linear probing is often
insufficient; specialist models trained from scratch remain competitive; and larger parameter
counts do not guarantee better generalization.

**Strengths.** The breadth and protocol separation make it a better model-selection guide than
isolated model papers. It treats calibration and transfer as explicit axes.

**Limitations relative to this proposal.** It is still dominated by static datasets and standard
predictive metrics. The benchmark does not reproduce an online event stream in which reliability
drifts and rejected epochs have operational consequences.

**Implication for the proposal.** Do not claim “foundation model = calibration-free.” Benchmark
REVE, LaBraM/CBraMod-class models, a compact specialist, and classical Riemannian/spectral
baselines under the same event stream. Report the Pareto surface over accuracy, calibration,
latency, compute and number of subject labels.

## 7. Zare (2026) — Negative controls for EEG foundation models

**Question.** Are apparent EEG foundation-model gains transferable signal, or can they reflect
dataset identity, random features, projection choices or pretraining exposure?

**Methodology.** Six public models (LaBraM, EEGMamba, CBraMod, REVE, BENDR and BIOT) are evaluated
on five clinical tasks across four datasets with frozen linear probes. Depending on available
identifiers, splits are leave-one-subject-out, subject-grouped, or explicitly recording-level.
Targeted controls include random initialization, random features, label permutation,
scrambled-label fine-tuning and dimensionality-reduction sensitivity.

**Experiments and results.** On Korean dementia, frozen REVE achieved 0.568 AUROC versus 0.769 for
classical features, while a randomly initialized encoder reached 0.659. Dataset identity was
decoded from REVE embeddings at AUROC 1.000 using PCA-50, whereas Korean diagnosis was 0.528 with
the same pipeline. The clearest controlled positive was CHB-MIT seizure detection: REVE reached
0.793 AUROC, 9.2 percentage points above random initialization. On two-channel sleep staging,
classical features were at least as strong as the tested foundation models.

**Strengths.** It turns vague skepticism into executable negative controls and distinguishes
representation content from genuine pretraining benefit.

**Limitations.** This is a very recent single-author preprint. Tasks, cohorts, montages and exposure
vary together; one primary cohort lacks public patient identifiers; repeated LOSO folds share much
training data; exploratory comparisons lack family-wise correction.

**Implication for the proposal.** Add dataset/session identity probes, randomly initialized
encoders, label permutation, simple classical baselines and subject-disjoint splits. A
closed-loop-readiness benchmark is publishable only if it rules out dataset fingerprints and
reports neural increment beyond behavioural/autonomic channels.

## 8. TRIAGE (Xu et al., 2026) — Role-typed agent credit

**Question.** Can structured semantic roles correct the uniform trajectory-level advantages used
in agentic reinforcement learning?

**Methodology.** Environment-facing segments are labelled by an LLM judge as decisive progress,
useful exploration, no-progress infrastructure or regression. A bounded role constant is added to
the GRPO advantage; the judge sees at most five prior and five future action–observation pairs and
not the final verifier result. The theory defines the unobserved per-segment credit residual
\(\delta=A^*_{i,k}-A_i^{GRPO}\). The Bayes-optimal role-measurable correction is
\(E[\delta\mid\rho]\); for a noisy predicted role, improvement requires positive covariance between
the assigned constant and the true residual.

**Experiments and results.** Qwen2.5-7B and Qwen3-1.7B policies are trained on ALFWorld, Search-QA
and WebShop. ALFWorld/WebShop use ten runs; expensive Search-QA results use one run. On
Qwen2.5-7B, TRIAGE with a Qwen3-8B thinking judge reports 87.5%/48.1%/77.2% success versus
79.6%/43.3%/70.1% for GRPO. Completed ALFWorld and WebShop rollouts use 10.4% and 14.8% fewer
environment-facing turns than GRPO. It also beats a scalar process reward and a shared-backbone
value baseline in the reported comparisons.

**Strengths.** It defines where outcome-only credit is structurally incomplete and gives a measured
precondition for noisy semantic corrections. Role labels are more auditable than unconstrained
scalar judge rewards.

**Limitations.** The method uses multiple rollouts per prompt, future context, verifier rewards and
an expensive judge—resources unavailable to the proposal’s physical single-shot channel.
Search-QA lacks repeated-run uncertainty. Fixed constants and hard roles are sensitive to judge
reliability; if covariance is non-positive, the correction can worsen credit.

**Implication for the proposal.** The novelty cannot be “dense per-segment credit from a noisy
judge.” TRIAGE should be a repeatable/wide-channel upper baseline. Its covariance condition should
be adapted into a theorem or diagnostic for physiological verdict quality and evaluator-state
coupling.

## 9. STABLEVAL (Bonagiri et al., 2026) — Posterior credit under disagreement

**Question.** Can system rankings remain stable when human annotators are heterogeneous and noisy?

**Methodology.** Each item has latent graded correctness. Every annotator has a confusion matrix
with Dirichlet priors. EM estimates item posteriors and annotator reliability; the full posterior
is converted to posterior expected item credit and averaged into agent scores. Ranking stability is
measured by Kendall \(\tau_b\) under annotator subsampling.

**Experiments and results.** Synthetic stress tests and MT-Bench, ConvAbuse, QAGS and MSLR compare
majority vote, Dawid–Skene and posterior expected credit. Gains are strongest under high
disagreement; all methods converge in high-consensus regimes. Dawid–Skene can have lower latent
label MSE, while STABLEVAL targets score/ranking stability.

**Strengths.** It makes uncertainty propagation and evaluation stability explicit and provides
interpretable annotator/item diagnostics.

**Limitations.** It assumes conditionally independent annotators and sufficient repeated labels to
estimate confusion matrices. Sparse annotations destabilize estimates; correlated bias violates
the model; discretization choices alter results. It models a panel of annotators, not a single
drifting observer seen once per event.

**Implication for the proposal.** Generic claims about confusion matrices, Bayesian denoising or
posterior credit are occupied. The defensible gap is sequential joint inference when the same
human’s reliability drifts, each event is physically unrepeatable, missingness has semantics, and
agent actions can change the observation model.

## 10. DoVer (Ma et al., 2026) — Intervention-driven multi-agent debugging

**Question.** Should multi-agent debugging evaluate whether a localized blame label is “correct,”
or whether an intervention based on the hypothesis actually repairs the failure?

**Methodology.** DoVer segments a failed trajectory into trials, generates failure hypotheses, then
edits messages or plans and replays from checkpoints to verify each hypothesis. It measures failure
flips, milestone progress and hypothesis validation rather than only agreement with human
step-attribution labels.

**Experiments and results.** In Magnetic-One on GAIA/AssistantBench-derived failures, it flips
18–28% of failed trials, yields up to 16% milestone progress, and validates or refutes 30–60% of
hypotheses. On GSMPlus using AG2, it recovers 49% of failed trials. Multiple different
interventions can independently repair the same failure, showing that single-cause attribution may
be ill-posed.

**Strengths.** Counterfactual action tests the practical content of a diagnosis. Cross-framework
evaluation shows some transfer.

**Limitations.** Replay/checkpoint interventions are available in software but not for a
non-repeatable human physiological event. Segmentation and intervention fidelity depend on the
judge/model, and many cases remain inconclusive. The evaluation covers a small set of frameworks
and curated failed tasks rather than long-running production.

**Implication for the proposal.** Exact Shapley ground truth is appropriate for the replay-exact
simulator, but attribution accuracy alone is insufficient. Add *intervention utility*: whether
suppressing, replacing or querying the top-credited agent/edge repairs future matched episodes. Do
not imply that one Shapley vector is the unique causal explanation when several repairs work.

## 11. Wilson & Russell (2007) — Psychophysiological adaptive aiding

**Question.** Does adapting task assistance from a real-time psychophysiological state classifier
improve operator performance?

**Methodology.** Operators performed an uninhabited-air-vehicle task. EEG and other physiological
signals estimated engagement/workload, and an adaptive automation policy supplied aid when
estimated state crossed individually chosen criteria. Performance was compared with no-aid and
random-aid conditions.

**Experiments and results.** Psychophysiologically triggered aiding improved performance relative
to no aid and randomly scheduled aid; individualized criteria outperformed generic settings.

**Strengths.** Real-time closed-loop comparison with a random-aid control and individual
thresholds. It directly demonstrates that the timing of help, not simply its availability, matters.

**Limitations.** The state signal is tonic and used to decide *when to aid*, not to infer which agent
caused a phasic outcome. It does not model the evaluator as a causal state influenced by agent
actions.

**Implication for the proposal.** Workload-band control and physiology-triggered adaptation are
prior art. The new contribution must be the measurement-mediated feedback loop
\(a\rightarrow w\rightarrow p(o\mid r,w)\), its gaming pathology, and a structural separation or
constraint that prevents policies from improving measured credit by degrading the evaluator.

## Cross-paper verdict

The proposal’s central conjunction remains unusual:

1. a physically non-repeatable event observation;
2. a sub-bit, calibrated and abstaining physiological channel;
3. online posterior inversion with within-session reliability drift;
4. per-agent/edge credit rather than a global error label;
5. an evaluator state that agents themselves can actuate; and
6. simulator audit plus human transfer.

No selected paper establishes all six. However, almost every *individual ingredient* has prior
art. The paper must therefore avoid “first noisy physiological credit” rhetoric and make the
architectural conjunction, precise estimator failure under non-repeatability, and measured
closed-loop consequences the center of the contribution.

