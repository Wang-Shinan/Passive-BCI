from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

CLASS_NAMES: tuple[str, ...] = ("任务一", "任务二", "任务三")
TASK2_INDEX = 1
TASK3_INDEX = 2

ROBOT_ID_TO_CLASS: dict[int, int] = {1: 0, 2: 1, 3: 2}
TASK_NAME_TO_CLASS: dict[str, int] = {
    "pen": 0,
    "doll": 1,
    "snack": 2,
    "任务一": 0,
    "任务二": 1,
    "任务三": 2,
    "task1": 0,
    "task2": 1,
    "task3": 2,
    "1": 0,
    "2": 1,
    "3": 2,
}
_SUCCESS = {"", "success", "ok", "completed", "done"}


@dataclass(frozen=True, slots=True)
class CompletedTask:
    class_id: int
    class_name: str
    robot_id: int | None
    task: str | None
    source: str | None
    accepted: bool
    reason: str | None = None


def _as_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value.strip())
        return None
    number = int(value)
    if float(value) != number:
        return None
    return number


def class_id_from_task_completed(payload: Mapping[str, Any]) -> int | None:
    robot_id = _as_int(payload.get("robot_id"))
    if robot_id in ROBOT_ID_TO_CLASS:
        return ROBOT_ID_TO_CLASS[robot_id]
    task = payload.get("task")
    if isinstance(task, str):
        key = task.strip()
        mapped = TASK_NAME_TO_CLASS.get(key.lower())
        if mapped is None:
            mapped = TASK_NAME_TO_CLASS.get(key)
        if mapped is not None:
            return mapped
    class_id = _as_int(payload.get("class_id"))
    if class_id in {0, 1, 2}:
        return class_id
    name = payload.get("class_name")
    if isinstance(name, str) and name in CLASS_NAMES:
        return CLASS_NAMES.index(name)
    return None


def parse_task_completed(payload: Mapping[str, Any]) -> CompletedTask | None:
    if payload.get("type") != "task_completed":
        return None
    status = payload.get("status")
    status_text = str(status).strip().lower() if status is not None else ""
    robot_id = _as_int(payload.get("robot_id"))
    task = payload.get("task") if isinstance(payload.get("task"), str) else None
    source = payload.get("source") if isinstance(payload.get("source"), str) else None
    class_id = class_id_from_task_completed(payload)
    if class_id is None:
        return CompletedTask(
            class_id=-1,
            class_name="",
            robot_id=robot_id,
            task=task,
            source=source,
            accepted=False,
            reason="unknown_task",
        )
    if status_text not in _SUCCESS:
        return CompletedTask(
            class_id=class_id,
            class_name=CLASS_NAMES[class_id],
            robot_id=robot_id,
            task=task,
            source=source,
            accepted=False,
            reason="not_success",
        )
    return CompletedTask(
        class_id=class_id,
        class_name=CLASS_NAMES[class_id],
        robot_id=robot_id,
        task=task,
        source=source,
        accepted=True,
    )


def dominant_class_index(completed: set[int]) -> int | None:
    has_task2 = TASK2_INDEX in completed
    has_task3 = TASK3_INDEX in completed
    if has_task3 and not has_task2:
        return TASK2_INDEX
    if has_task2 and not has_task3:
        return TASK3_INDEX
    return None


def swap_max_onto(probabilities: Sequence[float], target: int) -> list[float]:
    """Swap only 任务二/任务三 so the larger of those two sits on `target`. 任务一 is untouched."""
    probs = [float(value) for value in probabilities]
    pair = (TASK2_INDEX, TASK3_INDEX)
    if target not in pair or len(probs) <= max(pair):
        return probs
    other = TASK3_INDEX if target == TASK2_INDEX else TASK2_INDEX
    if probs[other] > probs[target]:
        probs[target], probs[other] = probs[other], probs[target]
    return probs


def apply_prediction_dominance(payload: Mapping[str, Any], target: int | None) -> dict[str, Any]:
    event = dict(payload)
    if target is None or event.get("type") != "prediction":
        return event
    probs = event.get("probabilities")
    names = event.get("class_names")
    if not isinstance(probs, list) or len(probs) < 3:
        return event
    if isinstance(names, list) and list(names[:3]) != list(CLASS_NAMES):
        if event.get("task") != "passive_rating":
            return event
    new_probs = swap_max_onto(probs, target)
    class_id = max(range(len(new_probs)), key=lambda index: new_probs[index])
    event["probabilities"] = new_probs
    event["class_id"] = class_id
    if isinstance(names, list) and class_id < len(names):
        event["class_name"] = names[class_id]
    else:
        event["class_name"] = CLASS_NAMES[class_id]
    event["confidence"] = float(new_probs[class_id])
    event["dominance_forced"] = new_probs != [float(value) for value in probs]
    event["dominance_class"] = CLASS_NAMES[target]
    return event


def task_completed_ack(parsed: CompletedTask, dominant: int | None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "task_completed_ack",
        "accepted": parsed.accepted,
        "class_id": parsed.class_id if parsed.class_id >= 0 else None,
        "class_name": parsed.class_name or None,
        "robot_id": parsed.robot_id,
        "task": parsed.task,
        "source": parsed.source,
        "dominant_class_id": dominant,
        "dominant_class_name": CLASS_NAMES[dominant] if dominant is not None else None,
    }
    if parsed.reason:
        payload["reason"] = parsed.reason
    return payload
