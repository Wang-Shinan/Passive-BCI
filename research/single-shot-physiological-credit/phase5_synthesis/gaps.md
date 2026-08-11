# Phase 5 — Gaps, threats and research questions

## A. Neuroscience gap: what exactly is the event-level target?

The proposal currently moves among “expectation violation,” “error-related response,” and
“per-agent credit.” These are not interchangeable.

**Unanswered questions**

1. Does a supervisor generate distinguishable responses for:
   - unexpected but good outcome,
   - expected bad outcome,
   - violated policy/procedure,
   - wrong agent action later repaired,
   - global team failure with ambiguous cause?
2. Does self/other agency decoding survive three or more agents and partial observability?
3. Which onset anchors the epoch: action emission, visible state change, realized outcome, or
   supervisor recognition?
4. Does using future context to disambiguate cause destroy the sub-second latency advantage?

**Decisive pilot**

Use a factorial micro-task with independently manipulated expectation violation, objective
correctness, responsible agent, and visibility. Pre-register response-locked and outcome-locked
epochs, test cross-subject calibration, and measure whether agent identity is decodable beyond
correct/error and surprise.

## B. Identifiability gap: can drift and credit be learned together?

With one observation per event, an increase in negative verdicts may mean worse agents, lower
decoder specificity, higher workload, or a changed expectation. Without anchors these variables
can be observationally equivalent.

**Required analysis**

- State the generative model and invariances explicitly.
- Prove or empirically map the conditions under which credit and reliability are identifiable.
- Include sparse gold queries, sham events or known-control probes as anchors.
- Report posterior contraction and calibration, not only point attribution.
- Sweep drift timescale relative to event rate.

**Failure criterion**

If the model cannot distinguish “agent became worse” from “decoder became more negative” within a
realistic session length, D2 is not merely difficult; it is non-identifiable without extra
supervision.

## C. Causal gap: workload as confounder, mediator and actuator

Workload can simultaneously:

- change actual team performance,
- change ErrP amplitude/decodability,
- change missingness through movement/attention,
- be caused by agent behaviour, and
- change the cost of explicit queries.

Conditioning naively on workload may block a real causal effect or open collider bias. The paper
needs two graphs: one for *estimating credit* and another for *controlling workload*. It should
specify which paths are intentionally blocked.

**Decisive experiment**

In simulation, give the policy an action that worsens workload but changes observed verdict
reliability while holding true contribution constant. Train against the unprotected estimator and
show evaluator gaming emerges. Then apply the structural defense and verify true performance,
observed credit and workload jointly.

## D. Foundation-model gap: offline accuracy is not the contract

Current EEG-FM literature does not establish:

- timestamp-to-verdict latency on target hardware,
- probability calibration across subjects,
- selective prediction under artifacts,
- recovery after within-session drift,
- usefulness of one-shot outputs to a downstream credit posterior,
- robustness to montage/site fingerprints, or
- neural increment above eye, pupil, HRV and behaviour.

**Minimum benchmark axes**

| Axis | Metric |
|---|---|
| Discrimination | AUROC/AUPRC/balanced accuracy, subject-disjoint |
| Calibration | Brier, NLL, ECE with confidence intervals |
| Selectivity | risk–coverage curve and rejected-epoch error |
| Latency | median/p95 end-to-end latency, including acquisition window |
| Adaptation | performance versus 0/1/5/10/20 subject labels |
| Drift | recovery time and cumulative calibration error after change points |
| Shortcut resistance | dataset/session identity probe, random init, label permutation |
| Downstream value | Shapley error or intervention utility at a fixed query budget |

## E. Evaluation gap: Shapley is an audit, not the sole truth

Exact Shapley is appropriate in the simulator but can disagree with practical debugging:

- correlated agents make marginal contributions policy-dependent;
- several distinct interventions may repair the same trajectory;
- an agent may be causally important but not the best place to intervene;
- human expectations can be wrong while simulator ground truth is correct.

**Recommendation**

Report at least three endpoint families:

1. **Attribution:** distance/rank correlation to exact Shapley in replay-exact GJC.
2. **Decision value:** success of replace/query/suppress interventions on future matched episodes.
3. **Human cost:** explicit interruptions, time, workload and trust.

## F. Incrementality gap: why EEG after cheap modalities?

The proposal correctly says wide channels are the denominator, but this must become an experimental
gate rather than a sentence.

**Ablation ladder**

1. task log + timeout;
2. + autonomous critic;
3. + gaze/pupil/HRV;
4. + mouse/controller/speech;
5. + EEG;
6. all channels with calibrated late fusion.

Claim a neural contribution only if step 5/6 improves downstream decision value or reduces
interruptions with uncertainty intervals, not merely if EEG has above-chance standalone accuracy.

## G. Generalization gap: GJC to LLM-MAS

GJC has synchronous motor control, continuous state, precise events and exact replay. LLM-MAS has
asynchronous tools, semantic events, long delays, text-mediated expectations and non-deterministic
models. Transfer is therefore not automatic.

**Bridge tasks**

1. GJC with counterbalanced human/agent roles.
2. Discrete cooperative planning with visible agent-labelled actions and exact replay.
3. Tool-using LLM agents with deterministic caches and explicit event markers.
4. Naturalistic LLM-MAS only after the onset/agency decoder is validated.

## H. Statistical and design threats

- Treat team, not trial, as the independent unit where appropriate.
- Avoid role/agent confounds in the Qin design by counterbalancing every role.
- Pre-register exclusion rules and report all rejected epochs as outcomes.
- Use nested subject/team splits for decoder tuning and final evaluation.
- Correct for multiple tasks/models/metrics or define one primary endpoint.
- Power the human study for the smallest useful neural increment, not for above-chance EEG.
- Include cap-sham and information-sham conditions to separate expectancy effects.
- Report failures and subgroup variability; avoid excluding “BCI illiterate” users from the main
  deployability claim.

## I. Ten questions to guide the next investigation

1. What observable event creates a reliable epoch when causal responsibility unfolds over seconds?
2. Is the signal about surprise, correctness, agency, or blame after controlling the other three?
3. How many anchor labels are minimally necessary for joint drift/credit identifiability?
4. Which existing estimators become mathematically undefined—not simply inefficient—under one
   physical observation?
5. What is the strongest behavioural/autonomous-critic baseline at the same latency?
6. At what channel capacity and drift rate does the posterior stop being decision-useful?
7. Can a policy really learn evaluator gaming within the available horizon, or is it only a
   theoretical pathology?
8. Does the proposed defense preserve useful workload-mediated adaptation?
9. Does a foundation model improve calibrated downstream utility over a compact subject-specific
   model after equal compute and labels?
10. Which claim still holds if the EEG decoder reaches only 60–65% balanced accuracy?

## Stop/go gates

- **Gate 1 — construct:** agent identity/agency is decodable beyond surprise and correctness.
- **Gate 2 — interface:** calibrated risk–coverage and p95 latency meet the task deadline.
- **Gate 3 — inference:** joint credit/reliability posterior is identifiable at realistic session
  length and anchor budget.
- **Gate 4 — increment:** EEG adds decision value over non-neural channels.
- **Gate 5 — safety:** evaluator gaming appears under the vulnerable design and is blocked without
  collapsing performance.
- **Gate 6 — transfer:** simulator gains predict intervention gains in a human or LLM-MAS bridge
  task.

