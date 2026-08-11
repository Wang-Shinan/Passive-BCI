# Gated Joint Control: single-shot credit substrate

This directory implements the proposal's four immediate simulator amendments
as a deterministic, self-contained Python experiment.

## What is implemented

- Intermediate checkpoint deadlines, with paired checkpoint-on/off results.
- A first-class `BehavioralBit(completed, timed_out)` attached to every epoch.
- An `EpochVerdict` contract in which observed neutrality (`value=0.5`),
  artifact rejection, and no response are different states.
- Exact three-role Shapley ground truth from replay-exact policy substitution.
- A single-shot observation model `p(o | violation, workload, engagement)`.
- An explicitly assumed (not fitted) workload response `f(w, a)`.
- A Stage 1 accuracy curve at 100/90/80/70/65/55%.
- A Stage 2b simulated evaluator-degradation pathology and structural guard.

Tonic state conditions the observation model but has no edge into structural
credit. The guarded policy uses a frozen observation model, a two-sided
workload band, a human-independent task score, and verdict-supply logging.

## Run

```bash
cd gjc
python3 -m pip install -r requirements.txt
python3 selfcheck.py
python3 experiment.py --out_dir=run_1
python3 plot.py run_1
```

Outputs:

- `run_1/final_info.json`
- `run_1/Figure_1.png`
- `run_1/Figure_1.pdf`
- `run_1/Figure_2.png`
- `run_1/Figure_2.pdf`
- `figures.tex`

## Scope

The supplied workspace did not contain the `gjc/` implementation referenced by
the proposal, so this is a compact replacement rather than a patch to that
earlier simulator. Its workload dynamics are an assumed existence-proof model;
no human-calibrated magnitude is claimed.
