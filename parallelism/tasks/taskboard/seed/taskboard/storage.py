import json
import os
import tempfile
from datetime import date

from .board import Board
from .models import Task

SCHEMA_VERSION = 1


class StorageError(Exception):
    pass


class SchemaVersionError(StorageError):
    pass


def _encode_task(task):
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "due": task.due.isoformat() if task.due is not None else None,
        "tags": list(task.tags),
        "dependencies": list(task.dependencies),
    }


def _decode_task(data):
    due = data.get("due")
    return Task(
        id=data["id"],
        title=data["title"],
        status=data["status"],
        priority=data["priority"],
        due=date.fromisoformat(due) if due is not None else None,
        tags=set(data.get("tags", [])),
        dependencies=list(data.get("dependencies", [])),
    )


def save(board, path):
    payload = {
        "version": SCHEMA_VERSION,
        "next_id": board._next_id,
        "wip_limits": dict(board.wip_limits),
        "tasks": [_encode_task(t) for t in board.tasks()],
    }
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".taskboard-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except json.JSONDecodeError as exc:
        raise StorageError("invalid JSON: %s" % exc) from exc
    if not isinstance(payload, dict) or payload.get("version") != SCHEMA_VERSION:
        raise SchemaVersionError(
            "unsupported schema version: %r"
            % (payload.get("version") if isinstance(payload, dict) else None,)
        )
    tasks = [_decode_task(d) for d in payload["tasks"]]
    return Board.restore(tasks, payload["next_id"], payload.get("wip_limits"))
