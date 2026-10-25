# taskboard

A small kanban library. Python 3.10, standard library only. Public names are
importable from `taskboard`.

## Task (`taskboard.models`)

`Task(id, title, status="todo", priority=3, due=None, tags=<empty set>, dependencies=<empty list>)`
is a dataclass.

- `STATUSES` is `("todo", "doing", "done")`. Any other status raises `ValueError`.
- `priority` is an int from 1 to 5 inclusive (5 is most urgent). Anything else,
  including a bool or a non-int, raises `ValueError`.
- `due` is a `datetime.date` or `None`; anything else raises `TypeError`.
- `tags` is always stored as a `set` (any iterable is accepted).
- Every task has its own `tags` set and its own `dependencies` list.

## Board (`taskboard.board`)

`Board(wip_limits=None)`. `wip_limits` maps a column name to the maximum number
of tasks that column may hold (a positive int). Columns not listed are
unlimited. An unknown column or a limit below 1 raises `ValueError`.

- `add_task(title, priority=3, due=None, tags=None, depends_on=None)` creates a
  task in `todo` and returns it. Ids are 1, 2, 3, ... in creation order and are
  never reused (also not after removal). Every id in `depends_on` must exist
  (`UnknownTaskError` otherwise). `todo` obeys its WIP limit too.
- `get(id)` returns the task or raises `UnknownTaskError`.
- `tasks()` returns all tasks ordered by id; `column(status)` returns the tasks
  in one column ordered by id.
- `remove_task(id)` removes the task, returns it, and also drops its id from the
  `dependencies` of every other task.
- `move(id, status)` moves a task and returns it. Checks, in this order:
  1. An invalid status raises `ValueError`; an unknown id raises `UnknownTaskError`.
  2. Moving a task to the column it is already in does nothing (never an error).
  3. Moving to `doing` or `done` while any dependency is not `done` raises
     `DependencyError`. Moving to `todo` is never blocked by dependencies.
  4. If the target column already holds as many tasks as its limit,
     `WipLimitError` is raised. A column with limit N may hold exactly N tasks.
- `add_dependency(task_id, dep_id)` makes `task_id` depend on `dep_id`. Both must
  exist. If it would create a cycle of any length (a task depending on itself,
  A -> B -> A, A -> B -> C -> A, ...) it raises `CycleError` and changes nothing.
  Adding a dependency that already exists does nothing.
- Exceptions: `UnknownTaskError`, `WipLimitError`, `DependencyError`, `CycleError`
  all derive from `BoardError`; `CycleError` is a `DependencyError`.

## Queries (`taskboard.query`)

All functions take an iterable of tasks, return a new list and never modify
their input. Input order is preserved unless stated otherwise.

- `by_status(tasks, status)`: tasks with that status.
- `filter_by_tags(tasks, tags, mode="any")`: `"any"` keeps tasks sharing at least
  one tag with `tags`; `"all"` keeps tasks holding every tag in `tags` (an empty
  `tags` therefore matches everything in `"all"` mode and nothing in `"any"`
  mode). Another mode raises `ValueError`.
- `due_window(tasks, start=None, end=None)`: tasks whose due date `d` satisfies
  `start <= d < end` (start inclusive, end exclusive). A `None` bound is open.
  Tasks without a due date never match.
- `overdue(tasks, today)`: tasks whose due date is strictly before `today` and
  whose status is not `done`. A task due today is not overdue.
- `sort_tasks(tasks)`: orders by priority descending, then due date ascending
  with tasks that have no due date after all dated tasks of the same priority,
  then id ascending.

## Storage (`taskboard.storage`)

- `save(board, path)` writes JSON: `version` (`SCHEMA_VERSION`, 1), `next_id`,
  `wip_limits`, and `tasks` ordered by id. Each task has `id`, `title`,
  `status`, `priority`, `due` (ISO `YYYY-MM-DD` or `null`), `tags` (always
  present, a JSON list sorted alphabetically, `[]` when empty) and
  `dependencies` (a list, order kept). Output is deterministic.
- The write is atomic: data goes to a temporary file in the same directory and is
  moved over `path` with `os.replace`. If anything fails midway an existing file
  at `path` is left untouched and no temporary file is left behind.
- `load(path)` returns a `Board` equal in tasks, `next_id` and `wip_limits` to the
  saved one (tags are sets again, dates are `date` objects).
- A file whose `version` is missing or not 1 raises `SchemaVersionError` (a
  `StorageError`); a file that is not valid JSON raises `StorageError`.
