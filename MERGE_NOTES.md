# main / rl integration

This is an integration candidate, not a declaration of hardware readiness. Only `merge` was updated; `main`, `rl`, existing PR states and the companion backend were not changed.

## Source history

- main: fcbb026963c4285ff374bf63fed47a835943f289
- rl: 1ecdf243544cc857c268c6017ee03ab7d4f57878
- PR #3: e4d53fcd46f711d6d7ebdd63c15b0345ae9a3e81 (includes PR #2 and rl).
- Two-parent merge: 221953913fd54c367235d2a47b570b0730167bb3.
- Initial compatibility fixes: e758bf3b6c393f620686fe2a02b9ac168fb32edb.
- Tetris lifecycle / gaze-head integration: 7c75ac43ebb4cc1aff3f0a38db2055a785e16e42.

Main's LSL bridge on port 8771, N-back recording, training/export UI and task-specific head selection are retained, together with PR #3's gaze collection, collaborative Tetris, reconnect handling, bounded logs and diagnostics. The recorder keeps main's ArrayBuffer copy. Training and diagnostic Vite plugins and both model-service API families remain enabled.

## Model control and recording

Traditional `smr_control` and `gaze_smr` remain explicit tasks, with traditional SMR as the default. The existing remote Tetris layout is preserved; no separate, unlocated UI redesign is claimed to have been reconstructed.

Selection is distinct from application. The checkbox launcher, embedded panel and dedicated gaze page share task-specific preferences. Selecting a head does not restart the model. The UI shows selected versus running head; applying it starts the change. Running configuration includes head ID, revision, fingerprint and the paired gaze report.

A shared operation owner prevents concurrent launches and discards late HTTP success after cancellation. Service stop disables runtime reconnect before stopping the process. Emergency stop remains available during loading or recording. Changing URL, task, head, step or backend is restricted during recording, including direct browser API calls. Vite additionally coordinates model-mutation and recording leases across tabs. A model-transition rejection of recording start does not silently fall back to memory recording.

Transitions clear prediction/vote state and queued follow/drop actions. Task, ordered labels, revision and freshness must match before predictions drive actions. Gaze also checks subject, channel order and sample rate. Binary gaze masks inactive logits as well as probabilities before temporal filtering. Recording events include `brain_model_binding` with the applied configuration and action mapping.

## Historical gaze heads

Supported IDs are `gaze_smr_active.pt` paired with `gaze_smr_active.json`, and `gaze-smr/<archive>/head.pt` paired with that archive's `report.json`. Catalog validation includes task, revision, subject, montage, sample rate, active classes, report/head SHA-256 and exact encoder/LoRA availability. Invalid entries are not selectable. Allowlisted IDs and real-path checks reject traversal and symlink escapes. A changed report changes the configuration fingerprint even at the same path.

The launcher uses the selected report explicitly, not the current active report or an unrelated default adapter. Selection reads existing files; it does not overwrite the active deployment.

## Experiment behavior intentionally kept separate

`/tetris` retains pressure and teacher/follow control: gaze `down` means no brain-control action. Centered `/gaze-smr-tetris` and `/gaze-tetris` retain their own recording and signal-loss behavior: `down` means soft drop. Pure gaze uses its EEG-derived gaze classifier, not a REVE linear head. Navigation and mode text explain these differences. Shared model management does not collapse distinct experimental protocols or treat decoded game actions as ground-truth labels.

## Backend dependency

Gaze requires Wang-Shinan/NCC-OI-BCI PR #1 (reviewed head 9fae013e7e6da85115296b22eff096f1a88c1bd4), including `scripts/fit_gaze_smr_head.py` and the `gaze_smr` task. Set `NCC_OI_BCI_ROOT` to a compatible checkout. This work did not merge that PR, install weights, edit recordings or modify the backend repository.

## Validation and remaining work

The source published in 7c75ac43 passed isolated run 35128774926:

- Full `npm run build`, including TypeScript project checks and Vite production build.
- 42 Vitest files / 197 tests.
- 28 standalone tests: 10 launcher, 7 task-isolation and 11 lifecycle/gaze/report/operation-gate tests.
- Lint: successful exit with 24 warnings and zero errors, not a warning-free result.
- Chromium regression: launch traditional A; select B without applying; apply B; recording locks selectors/task/Mock; direct API bypass is rejected; stop does not reconnect; historical gaze head selection works; stop during delayed launch prevents later re-enabling. Screenshots and a JSON summary are retained as CI artifacts.

Browser regression uses mock HTTP/WebSocket responses and a recording-attachment fixture. It is not live EEG validation, real inference, montage calibration, a long-session stress test or decoder-accuracy evaluation. Build retains a bundle-size warning. The unchanged dependency graph reported two moderate and one high npm audit findings during installation; no unrelated dependency upgrade was made.

An additional local Python check passed the two grouping/split tests in `scripts/test_training_job.py`. Its H5/optimization/checkpoint test failed at import because `bci_dayloop` was unavailable; this is not counted as a passing backend integration test. That script's complete runner expects an NCC checkout argument, as shown below.

The permanent read-only `.github/workflows/merge-validation.yml` reruns build, tests, lint and browser regression. Temporary hash-locked edit-transport files and the write-enabled publishing workflow have been removed from the current tree.

Local frontend checks (Node 22.16+):

```bash
npm ci
npm run build
npm test
npm run lint
node --test scripts/test-reve-launch-options.mjs
node --experimental-strip-types --test scripts/test-brain-control-task.mjs
node --experimental-strip-types --test scripts/test-model-integration.mjs
```

For browser regression, install Playwright in a separate directory and set `PLAYWRIGHT_MODULE` to its `node_modules/playwright/index.mjs`, as CI does. Browser tooling is not added to the application lockfile.

With the companion backend and its dependencies installed, run `python scripts/test_training_job.py "$NCC_OI_BCI_ROOT"` from this repository, then `python -m pytest tests/test_gaze_smr_head.py -q` from the backend checkout. Validate real head switches, gaze fitting, LSL acquisition, N-back save/export, final event flush and long collaborative sessions before promotion to main.
