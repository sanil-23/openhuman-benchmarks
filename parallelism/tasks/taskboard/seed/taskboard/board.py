from .models import STATUSES, Task


class BoardError(Exception):
    pass


class UnknownTaskError(BoardError):
    pass


class WipLimitError(BoardError):
    pass


class DependencyError(BoardError):
    pass


class CycleError(DependencyError):
    pass


class Board:
    def __init__(self, wip_limits=None):
        self.wip_limits = {}
        for column, limit in (wip_limits or {}).items():
            if column not in STATUSES:
                raise ValueError("unknown column: %r" % (column,))
            if not isinstance(limit, int) or limit < 1:
                raise ValueError("limit must be a positive int")
            self.wip_limits[column] = limit
        self._tasks = {}
        self._next_id = 1

    @classmethod
    def restore(cls, tasks, next_id, wip_limits=None):
        board = cls(wip_limits)
        for task in tasks:
            board._tasks[task.id] = task
        board._next_id = next_id
        return board

    def add_task(self, title, priority=3, due=None, tags=None, depends_on=[]):
        for dep in depends_on:
            self._require(dep)
        self._check_wip("todo")
        task = Task(
            id=self._next_id,
            title=title,
            priority=priority,
            due=due,
            tags=set(tags or ()),
            dependencies=depends_on,
        )
        self._tasks[task.id] = task
        self._next_id += 1
        return task

    def get(self, task_id):
        return self._require(task_id)

    def tasks(self):
        return [self._tasks[i] for i in sorted(self._tasks)]

    def column(self, status):
        if status not in STATUSES:
            raise ValueError("invalid status: %r" % (status,))
        return [t for t in self.tasks() if t.status == status]

    def remove_task(self, task_id):
        task = self._require(task_id)
        del self._tasks[task_id]
        for other in self._tasks.values():
            if task_id in other.dependencies:
                other.dependencies.remove(task_id)
        return task

    def move(self, task_id, status):
        if status not in STATUSES:
            raise ValueError("invalid status: %r" % (status,))
        task = self._require(task_id)
        if task.status == status:
            return task
        if status in ("doing", "done"):
            for dep in task.dependencies:
                if self._tasks[dep].status != "done":
                    raise DependencyError(
                        "task %d is blocked by task %d" % (task_id, dep)
                    )
        self._check_wip(status)
        task.status = status
        return task

    def add_dependency(self, task_id, dep_id):
        task = self._require(task_id)
        self._require(dep_id)
        if task_id == dep_id or self._creates_cycle(task_id, dep_id):
            raise CycleError("task %d cannot depend on task %d" % (task_id, dep_id))
        if dep_id not in task.dependencies:
            task.dependencies.append(dep_id)

    def _creates_cycle(self, task_id, dep_id):
        return task_id in self._tasks[dep_id].dependencies

    def _check_wip(self, status):
        limit = self.wip_limits.get(status)
        if limit is not None and len(self.column(status)) > limit:
            raise WipLimitError("column %r is full" % (status,))

    def _require(self, task_id):
        try:
            return self._tasks[task_id]
        except KeyError:
            raise UnknownTaskError("no such task: %r" % (task_id,)) from None
