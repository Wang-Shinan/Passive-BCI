"""Dataset registry aligned with Passive BCI control dimensions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

TaskKind = Literal["classification", "regression"]


@dataclass(frozen=True)
class DatasetSpec:
    key: str
    display_name: str
    dimension: str
    task: TaskKind
    n_classes: int | None
    label_names: tuple[str, ...]
    maps_to: tuple[str, ...]
    """Passive BCI front-end channels this dataset supports."""
    cos_zarr: str | None
    cos_raw: str | None
    cos_lance: str | None
    local_subdir: str
    notes: str
    available_on_cos: bool = True
    segment_sec: float | None = None
    sfreq: float = 200.0


DATASETS: dict[str, DatasetSpec] = {
    "workload": DatasetSpec(
        key="workload",
        display_name="Workload (MATB)",
        dimension="cognitive_load",
        task="classification",
        n_classes=3,
        label_names=("easy", "med", "diff"),
        maps_to=("cognitive_load", "stress"),
        cos_zarr="cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/Workload/Workload.zarr",
        cos_raw="cos:omni-eeg-1442740494/omni-eeg-01/raw_data/Workload",
        cos_lance="cos:omni-eeg-bench-1442740494/omni-downstream-dataset/lance_2.0/Workload",
        local_subdir="workload",
        notes="Labels from file suffix MATBeasy/med/diff → 0/1/2. Best match for Tetris regulate.",
        segment_sec=2.0,
        sfreq=200.0,
    ),
    "eegmat": DatasetSpec(
        key="eegmat",
        display_name="EEGMAT",
        dimension="cognitive_load_binary",
        task="classification",
        n_classes=2,
        label_names=("rest_or_low", "mental_arithmetic"),
        maps_to=("cognitive_load", "focus_score"),
        cos_zarr="cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/EEGMAT/EEGMAT.zarr",
        cos_raw="cos:omni-eeg-1442740494/omni-eeg-01/raw_data/EEGMAT",
        cos_lance="cos:omni-eeg-bench-1442740494/omni-downstream-dataset/lance_2.0/EEGMAT",
        local_subdir="eegmat",
        notes="Mental arithmetic binary labels 0/1; 36 subjects; NPD train/val/test available.",
        segment_sec=5.0,
        sfreq=200.0,
    ),
    "deap": DatasetSpec(
        key="deap",
        display_name="DEAP",
        dimension="affect",
        task="regression",
        n_classes=None,
        label_names=("valence", "arousal", "dominance", "liking"),
        maps_to=("relaxation_score", "arousal", "satisfaction", "engagement_score"),
        cos_zarr="cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/DEAP/DEAP.zarr",
        cos_raw="cos:omni-eeg-1442740494/omni-eeg-01/raw_data/DEAP",
        cos_lance="cos:omni-eeg-bench-1442740494/omni-downstream-dataset/lance_2.0/DEAP_arousal",
        local_subdir="deap",
        notes=(
            "Prefer raw participant_ratings.csv (V/A/D/Liking 1–9) + preprocessed python .dat. "
            "Existing zarr/lance often only binary valence — use ratings for regression."
        ),
        segment_sec=10.0,
        sfreq=200.0,
    ),
    "stew": DatasetSpec(
        key="stew",
        display_name="STEW",
        dimension="cognitive_load",
        task="classification",
        n_classes=2,
        label_names=("rest", "simkap_workload"),
        maps_to=("cognitive_load", "stress", "engagement_score"),
        cos_zarr=None,
        cos_raw=None,
        cos_lance=None,
        local_subdir="stew",
        notes=(
            "NOT found on current COS omni-eeg-01 / omni-eeg-bench. "
            "Expect IEEE DataPort STEW: rest vs SIMKAP + optional 1–9 workload ratings. "
            "Place under data/stew/ after manual download."
        ),
        available_on_cos=False,
        segment_sec=None,
        sfreq=128.0,
    ),
}


def list_datasets(*, cos_only: bool = False) -> list[DatasetSpec]:
    specs = list(DATASETS.values())
    if cos_only:
        specs = [s for s in specs if s.available_on_cos]
    return specs
