# main / rl integration

This branch is an integration candidate, not a declaration of hardware readiness.

## Source history

- main: fcbb026963c4285ff374bf63fed47a835943f289
- rl: 1ecdf243544cc857c268c6017ee03ab7d4f57878
- PR #3: e4d53fcd46f711d6d7ebdd63c15b0345ae9a3e81 (already includes PR #2 and rl).
- Two-parent merge commit: 221953913fd54c367235d2a47b570b0730167bb3.

The integration preserves main's LSL bridge on port 8771, N-back recording, training/export UI and task-specific head selection, together with PR #3's gaze collection, collaborative Tetris, reconnect handling, bounded logs and diagnostics. The recorder keeps main's ArrayBuffer copy. Both training and diagnostic Vite plugins and both model-service API families remain enabled.

## Compatibility choices

The Tetris brain-control panel offers traditional `smr_control` and `gaze_smr`; the default remains traditional SMR. Disable brain control and finish recording before changing tasks. Service launch, prediction acceptance and the embedded model panel use the same task. Task changes, reconnects and restarts clear vote state and pending follow/drop actions. Task, label order, model revision and freshness are checked before predictions drive the game. Unexpected WebSocket drops can reconnect through the runtime hub; manually disabling it is not overridden by Tetris.

Traditional SMR continues to use the selected head from the training UI. Gaze uses only `gaze_smr_active.pt` plus its matching JSON report; generic/stale head preferences cannot override it. Historical gaze-head selection is deliberately not exposed until report selection is also implemented.

The gaze launcher validates the report task and head checksum when present, and resolves the exact adapter from `loraCheckpoint` or the recorded `encoderId`. It does not silently substitute the current default LoRA. Conflicting explicit flags, missing adapters and mismatched configurations fail before launch. Gaze fitting shares the launcher's NCC/Python discovery through `scripts/run-gaze-fit.mjs`.

## Backend dependency

Gaze functionality requires the changes in Wang-Shinan/NCC-OI-BCI PR #1 (reviewed head: 9fae013e7e6da85115296b22eff096f1a88c1bd4), including `scripts/fit_gaze_smr_head.py` and the `gaze_smr` REVE task. Point `NCC_OI_BCI_ROOT` to a compatible checkout. This integration does not merge or modify that backend repository, install weights, or change recordings.

## Validation

Executed in the editing environment: 10 dependency-free launcher tests and 7 task/prediction isolation tests passed; the new task helper passed isolated strict TypeScript checking, and the edited Tetris source passed TypeScript syntax parsing. These are not a full project build or a browser/EEG integration test.

The environment could access GitHub through the connected API but could not clone GitHub or install project dependencies. The following checks still need to run on a full local checkout (Node 22.16+ for the standalone TypeScript test):

```bash
npm ci
npm run build
npm test
npm run lint
node --test scripts/test-reve-launch-options.mjs
node --experimental-strip-types --test scripts/test-brain-control-task.mjs
python -m pytest scripts/test_training_job.py -q
```

In the companion backend checkout, run `python -m pytest tests/test_gaze_smr_head.py -q`. Then smoke-test both brain-control tasks, explicit disable/re-enable, model-head switches and reconnects, gaze fitting/activation, LSL acquisition, N-back save/export, recording final-event flush and a long collaborative Tetris session. Do not assume either PR's earlier test totals validate this merged tree.
