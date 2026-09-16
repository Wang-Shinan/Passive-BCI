# main / rl integration

This branch is an integration candidate, not a declaration of hardware readiness. Only `merge` was updated; `main`, `rl`, existing PR states and the companion backend were not changed.

## Source history

- main: fcbb026963c4285ff374bf63fed47a835943f289
- rl: 1ecdf243544cc857c268c6017ee03ab7d4f57878
- PR #3: e4d53fcd46f711d6d7ebdd63c15b0345ae9a3e81 (already includes PR #2 and rl).
- Two-parent merge commit: 221953913fd54c367235d2a47b570b0730167bb3.
- Initial compatibility commit: e758bf3b6c393f620686fe2a02b9ac168fb32edb.
- Tetris lifecycle / gaze-head integration: 7c75ac43ebb4cc1aff3f0a38db2055a785e16e42.

The integration retains main's LSL bridge on port 8771, N-back recording, training/export UI and task-specific head selection, together with PR #3's gaze collection, collaborative Tetris, reconnect handling, bounded logs and diagnostics. The recorder keeps main's ArrayBuffer copy. Both training and diagnostic Vite plugins and both model-service API families remain enabled.

## Tetris model control

Traditional `smr_control` and `gaze_smr` remain explicit tasks. Traditional SMR is the default. The existing remote Tetris layout is preserved, rather than claiming to reconstruct a separate UI redesign not found in these source refs.

Model selection is now distinct from the applied configuration. The checkbox launcher, embedded model panel and dedicated gaze page use the same task-specific preference. Changing a selection does not restart the model. The UI shows the selected and running head separately; an apply action starts the change. The running configuration includes head ID, revision, configuration fingerprint and, for gaze, its paired report.

A shared operation owner prevents concurrent launches and ignores late HTTP success after cancellation. All service stop buttons disable runtime reconnect before stopping the process. An emergency stop remains available during loading or recording. Changing the runtime URL, task, head, step or backend is restricted during recording. The browser API checks this directly; Vite additionally coordinates recording and model-mutation leases across tabs. Recording start cannot fall back silently to memory when the server rejects it due to a model transition.

Tetris clears prediction/vote state and queued follow/drop actions across transitions. Only fresh predictions with the expected task, ordered labels and matching revision drive actions. Gaze additionally validates subject, channel order and sample rate against its report. Binary gaze models mask inactive logits as well as probabilities before temporal filtering, so up/down cannot reappear through an older four-output score vector. Recording events include `brain_model_binding` with the applied configuration and action mapping.

## Historical gaze heads

Gaze head selection is no longer limited to the active file. Supported IDs are:

- `gaze_smr_active.pt`, paired with `gaze_smr_active.json`.
- `gaze-smr/<archive>/head.pt`, paired with that archive's `report.json`.

The catalog validates task, revision, subject, montage, sample rate, active classes, report/head SHA-256 and exact encoder/LoRA availability. Invalid entries are not selectable. IDs are allowlisted and paths cannot escape the head directory through traversal or symlinks. Changing a report changes the configuration fingerprint even when the path stays the same. The launcher takes the selected report explicitly; it does not silently substitute the current active report or a different default adapter. Files are read, not copied over the active deployment during selection.

## Experiment behavior intentionally kept separate

`/tetris` retains pressure control and teacher/follow gameplay: gaze `down` means no brain-control action. The centered `/gaze-smr-tetris` and `/gaze-tetris` sessions retain their own recording and signal-loss behavior: `down` means soft drop. Pure gaze still uses its EEG-derived gaze classifier rather than a REVE linear head. Navigation and mode text explain the distinction. Shared model management does not collapse different experimental protocols or label decoded game actions as ground truth.

## Backend dependency

Gaze functionality requires Wang-Shinan/NCC-OI-BCI PR #1 (reviewed head: 9fae013e7e6da85115296b22eff096f1a88c1bd4), including `scripts/fit_gaze_smr_head.py` and the `gaze_smr` REVE task. Point `NCC_OI_BCI_ROOT` to a compatible checkout. This work did not merge that PR, install weights, edit recordings, or change the backend repository.

## Validation and limits

The source published in 7c75ac43 passed the isolated validation run 35128774926:

- Full `npm run build` (TypeScript project checks and Vite production build).
- 42 Vitest files / 197 tests.
- 28 standalone tests: 10 launcher, 7 task isolation and 11 lifecycle/gaze/report/operation-gate tests.
- Lint: exit success, 24 warnings and zero errors. Warnings are not represented as a clean lint report.
- Chromium interaction regression: launch traditional head A; select B without applying; apply B; lock selectors/task/Mock during recording; reject a direct API bypass; stop without reconnect; apply a historical gaze head; stop during a delayed launch without later re-enabling runtime. The browser test records screenshots, a summary and failure diagnostics.

The browser regression uses mock HTTP/WebSocket service responses and a recording attachment fixture. It is not a live EEG test, real model inference, a montage calibration, a long-session stress test, or independent validation of decoder accuracy. Build retains a bundle-size warning. The unchanged dependency graph reported two moderate and one high npm audit findings during installation; no unrelated dependency upgrade was applied.

The permanent, read-only `.github/workflows/merge-validation.yml` reruns build, tests, lint and browser regression on `merge` pushes and relevant PRs. The temporary hash-locked edit transport and write-enabled publishing workflow used during this integration have been removed from the current tree.

Local checks (Node 22.16+):

```bash
npm ci
npm run build
npm test
npm run lint
node --test scripts/test-reve-launch-options.mjs
node --experimental-strip-types --test scripts/test-brain-control-task.mjs
node --experimental-strip-types --test scripts/test-model-integration.mjs
python -m pytest scripts/test_training_job.py -q
```

For browser regression, install Playwright in a separate directory and set `PLAYWRIGHT_MODULE` to that installation's `node_modules/playwright/index.mjs`, as the workflow does. Browser tooling is not added to the application lockfile. In the companion backend, run `python -m pytest tests/test_gaze_smr_head.py -q`, then perform real-device validation of head switches, gaze fitting, LSL acquisition, N-back save/export, final event flush and long collaborative sessions before promoting this branch.
