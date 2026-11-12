"""Exploratory, trial-blocked analysis of persisted focus feature summaries.

This does not reclassify invalid EEG trials as valid or infer raw EEG alignment.
Run again into a NEW output directory for a newly finalized recording.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path

import numpy as np
from scipy.stats import binomtest, mannwhitneyu


def fit_threshold(x, y):
    """Fit direction and threshold on training trials only, maximizing BA."""
    u = np.unique(x)
    cuts = np.r_[np.nextafter(u[0], -np.inf), (u[:-1] + u[1:]) / 2,
                 np.nextafter(u[-1], np.inf)]
    high = x[None, :] >= cuts[:, None]
    ba = (high[:, y == 1].mean(1) + (~high[:, y == 0]).mean(1)) / 2
    scores = np.r_[ba, 1 - ba]
    best = np.flatnonzero(np.isclose(scores, scores.max(), atol=1e-12, rtol=0))
    # Resolve ties deterministically, without looking at held-out trials.
    chosen = min(best, key=lambda k: (abs(cuts[k % len(cuts)] - np.median(x)), k))
    return float(cuts[chosen % len(cuts)]), 1 if chosen < len(cuts) else -1


def predict(x, threshold, direction):
    high = x >= threshold
    return high.astype(int) if direction == 1 else (~high).astype(int)


def cross_validate(x, y, blocks):
    pred = np.zeros(len(y), dtype=int)
    fits = []
    for block in np.unique(blocks):
        test = blocks == block
        threshold, direction = fit_threshold(x[~test], y[~test])
        pred[test] = predict(x[test], threshold, direction)
        fits.append({"held_out_block": int(block), "threshold": threshold,
                     "direction": "focus_high" if direction == 1 else "focus_low",
                     "correct": int(np.sum(pred[test] == y[test])),
                     "n": int(test.sum())})
    return pred, fits


def metrics(y, pred):
    tp = int(np.sum((y == 1) & (pred == 1)))
    tn = int(np.sum((y == 0) & (pred == 0)))
    fp = int(np.sum((y == 0) & (pred == 1)))
    fn = int(np.sum((y == 1) & (pred == 0)))
    ci = binomtest(tp + tn, len(y)).proportion_ci()
    return {"balanced_accuracy": (tp / (tp + fn) + tn / (tn + fp)) / 2,
            "accuracy": (tp + tn) / len(y), "tp": tp, "tn": tn, "fp": fp, "fn": fn,
            "descriptive_accuracy_ci95": [ci.low, ci.high]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--permutations", type=int, default=2000)
    args = parser.parse_args()
    # Refuse overwriting captured input or a previous report.
    args.output.mkdir(parents=False, exist_ok=False)
    source = {}
    captured = {}
    for name in ["events.jsonl", "eeg.json", "session.json"]:
        raw = (args.recording / name).read_bytes()
        (args.output / name).write_bytes(raw)
        source[name] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        captured[name] = raw.decode("utf-8")
    events = [json.loads(line) for line in captured["events.jsonl"].splitlines() if line.strip()]
    trials = [event["data"] for event in events if event["type"] == "focus_trial"]
    if len(trials) != 20 or [t["trialIndex"] for t in trials] != list(range(20)):
        raise ValueError("Expected one complete 20-trial sequence; inspect source before adapting analysis")
    y = np.array([int(t["label"] == "focus") for t in trials])
    blocks = np.arange(len(trials)) // 4
    for block in np.unique(blocks):
        if y[blocks == block].sum() != 2:
            raise ValueError("Expected two trials per class per chronological four-trial block")
    keys = ["mean", "last", "max"]
    features = np.array([[t["measuredFocusScore"][key] for t in trials] for key in keys])
    if not np.isfinite(features).all():
        raise ValueError("Non-finite summary; do not silently drop trials")
    results = {}
    observed_best = 0
    for key, x in zip(keys, features):
        pred, fits = cross_validate(x, y, blocks)
        threshold, direction = fit_threshold(x, y)
        descriptive = metrics(y, predict(x, threshold, direction))
        m = metrics(y, pred)
        observed_best = max(observed_best, m["balanced_accuracy"])
        results[key] = {
            "relax_mean": float(x[y == 0].mean()), "focus_mean": float(x[y == 1].mean()),
            "auc_focus_high": float(mannwhitneyu(x[y == 1], x[y == 0]).statistic / 100),
            "out_of_fold": m, "folds": fits, "predictions": pred.tolist(),
            "all_data_threshold_exploratory_not_validated": threshold,
            "all_data_direction": "focus_high" if direction == 1 else "focus_low",
            "in_sample_not_validation": descriptive}
    # Account for choosing the best of all three summaries; permute within each
    # chronological block, retaining balanced labels and rerunning threshold fits.
    rng = np.random.default_rng(20261105)
    null_best = []
    choices = list(itertools.combinations(range(4), 2))
    for _ in range(args.permutations):
        perm_y = np.zeros_like(y)
        for block in range(5):
            pair = choices[int(rng.integers(len(choices)))]
            perm_y[block * 4 + np.array(pair)] = 1
        null_best.append(max(float(np.mean(cross_validate(x, perm_y, blocks)[0] == perm_y))
                             for x in features))
    rates = [(t["sampleEnd"] - t["sampleStart"]) /
             ((t["collectEndPerfMs"] - t["collectStartPerfMs"]) / 1000) for t in trials]
    session = json.loads(captured["session.json"])
    report = {
        "recording": str(args.recording.resolve()), "input_hashes": source,
        "recording_status_at_capture": session["status"],
        "raw_eeg_bytes_at_capture": (args.recording / "eeg.bin").stat().st_size,
        "index_available_at_capture": (args.recording / "eeg.idx.json").exists(),
        "n_trials": len(trials), "n_focus": int(y.sum()), "n_relax": int((y == 0).sum()),
        "n_valid_trials": sum(bool(t["valid"]) for t in trials),
        "invalid_reasons": sorted(set(t["invalidReason"] for t in trials if not t["valid"])),
        "arrival_count_rate_hz": {"min": min(rates), "max": max(rates), "mean": float(np.mean(rates))},
        "evaluation": "leave-one-chronological-four-trial-block-out; thresholds and direction fit on other 16 trials",
        "results": results,
        "exploratory_familywise_permutation_p": (1 + sum(v >= observed_best - 1e-12 for v in null_best)) /
                                                (1 + len(null_best)),
        "permutations": len(null_best),
        "limitations": [
            "All invalid labels retained ONLY for exploratory diagnostics; no valid-trial accuracy claim.",
            "No raw EEG decoding or time alignment attempted without final sample index.",
            "mean/last/max are persisted online focus_score summaries, not independent EEG measurements.",
            "last is the last 1-second feature window, not one raw sample; mean pools the full collection period.",
            "Summary statistics cannot reconstruct rolling means, majority votes, confirmations, latency, or switch rate.",
            "No channel-selection metadata was persisted in this session; exact online mask cannot be recovered.",
            "Best-of-three performance remains exploratory; one small session cannot establish generalization.",
            "Binomial CI is descriptive only; cross-validation training sets overlap and trials may be dependent.",
        ],
    }
    (args.output / "summary-results.json").write_text(json.dumps(report, indent=2, ensure_ascii=True), encoding="utf-8")
    lines = ["id,label,valid,sample_start,sample_end,arrival_count_hz,feature_count,mean,last,max"]
    for trial, rate in zip(trials, rates):
        score = trial["measuredFocusScore"]
        lines.append(",".join(map(str, [trial["trialIndex"], trial["label"], trial["valid"],
                                       trial["sampleStart"], trial["sampleEnd"], rate, score["n"],
                                       score["mean"], score["last"], score["max"]])))
    (args.output / "trials.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
