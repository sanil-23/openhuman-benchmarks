from datetime import date

from .models import STATUSES


def by_status(tasks, status):
    if status not in STATUSES:
        raise ValueError("invalid status: %r" % (status,))
    return [t for t in tasks if t.status == status]


def filter_by_tags(tasks, tags, mode="any"):
    wanted = set(tags)
    if mode == "any":
        return [t for t in tasks if t.tags & wanted]
    if mode == "all":
        return [t for t in tasks if wanted <= t.tags]
    raise ValueError("mode must be 'any' or 'all'")


def due_window(tasks, start=None, end=None):
    result = []
    for t in tasks:
        if t.due is None:
            continue
        if start is not None and t.due < start:
            continue
        if end is not None and t.due >= end:
            continue
        result.append(t)
    return result


def overdue(tasks, today):
    return [
        t for t in tasks
        if t.due is not None and t.due <= today and t.status != "done"
    ]


def sort_tasks(tasks):
    return sorted(tasks, key=lambda t: (-t.priority, t.due or date.min, t.id))
