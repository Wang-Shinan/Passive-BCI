# Phase 4 — Reusable code and data

Checked: 2026-07-30. Repository activity and popularity are snapshots, not quality guarantees.

## Recommended reuse stack

| Priority | Repository | License / maturity snapshot | What is reusable | Main caveat |
|---:|---|---|---|---|
| 1 | [flowersteam/self_calibration_BCI_plosOne_2015](https://github.com/flowersteam/self_calibration_BCI_plosOne_2015) | GPL-3.0; 25 commits; tagged paper release; 4 stars | Online/offline ErrP pipeline, self-calibration logic, robust likelihood and planner; associated experiment data/code | Older MATLAB-heavy stack with submodules; GPL constraints; grid-task assumptions are strong |
| 2 | [YinuoQ/AINegativelyImpactsTeamPerformance](https://github.com/YinuoQ/AINegativelyImpactsTeamPerformance) | Python; 10 commits; no formal release; 0 stars | ADCT behavioural, EEG total-interdependence, pupil, speech and performance analysis; data layout documentation | Analysis scripts, not the task/simulator implementation; raw data are external; role confound remains |
| 3 | [liinc-lab/predictability_performance_and_ISC](https://github.com/liinc-lab/predictability_performance_and_ISC) | MIT; 104 commits; 0 stars | Multimodal preprocessing, ISC analyses, transformer action prediction, mixed-effects correlations; linked dataset | README clone URL differs from displayed owner; path/config cleanup likely needed |
| 4 | [elouayas/reve_eeg](https://github.com/elouayas/reve_eeg) | MIT; public code/weights; compact repository | Official REVE pretraining, linear probing, fine-tuning, preprocessing, Hugging Face export; montage-aware encoder | Requires Python 3.11 and substantial compute for training; real-time inference and calibrated abstention are not supplied |
| 5 | [xw1216/EEG-FM-Bench](https://github.com/xw1216/EEG-FM-Bench) | Public benchmark; 12 commits / 12 forks snapshot | Unified wrappers for BENDR, BIOT, CBraMod, EEGPT, LaBraM, CSBrain, REVE, plus EEGNet/Conformer; 14 datasets / 10 paradigms | Built for offline evaluation; dependencies and dataset licenses must be reconciled before extending |
| 6 | [braindecode/braindecode](https://github.com/braindecode/braindecode) | BSD-3-Clause core; mature, ~1.3k stars / 2,527 commits snapshot | Dataset loaders, preprocessing, windows, augmentation, compact and foundation models; REVE integration | Some bundled components have different licenses; streaming/event semantics need a separate layer |
| 7 | [NeuroTechX/EEG-ExPy](https://github.com/NeuroTechX/EEG-ExPy) | BSD-3-Clause; ~549 stars / 525 commits snapshot | Time-locked stimulus/EEG streaming, experiment templates, inexpensive hardware integration | Optimized for educational/consumer setups; API noted as under active development |

## Suggested architecture of a prototype

```text
GJC event log / LSL marker stream
        |
        +--> EEG-ExPy or lab acquisition bridge
        |
        +--> MNE/Braindecode preprocessing + artifact rejection
        |
        +--> {classical ErrP, compact EEGNet, REVE} encoders
        |
        +--> calibrated verdict + confidence + latency + rejected flag
        |
        +--> Iturrate-style online observation-model update
        |
        +--> posterior credit inference + query allocator
```

The Qin repositories should be treated as replication references and sources of task-specific
analysis conventions. The Iturrate repository is the architectural baseline. REVE and
EEG-FM-Bench supply representation baselines, while Braindecode supplies the common evaluation
surface.

## Data availability notes

- **Qin 2026:** paper points to OSF data; the GitHub repository documents expected multimodal files.
- **Qin 2025:** repository links a Dropbox dataset and supplies preprocessing/training scripts.
- **Iturrate 2015:** repository explicitly contains code and associated data and has a tagged paper
  release.
- **REVE:** redistributable portions of the pretraining data and pretrained weights are linked
  through the project/Hugging Face; full source datasets retain their own licenses.

## Minimum reproducibility checks before adoption

1. Freeze repository commit hashes and environment lock files.
2. Reproduce one published table/figure before modifying code.
3. Verify subject/team splits from raw identifiers, not cached tensors.
4. Check that event timestamps survive acquisition, resampling and windowing.
5. Treat rejected epochs as a separate outcome throughout the data model.
6. Add unit tests for calibration metrics, latency measurement and no-leak subject splits.
7. Audit licenses before moving GPL or non-commercial components into a shared implementation.

