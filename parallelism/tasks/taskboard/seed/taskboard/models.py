from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional, Set

STATUSES = ("todo", "doing", "done")


@dataclass
class Task:
    id: int
    title: str
    status: str = "todo"
    priority: int = 3
    due: Optional[date] = None
    tags: Set[str] = field(default_factory=set)
    dependencies: List[int] = field(default_factory=list)

    def __post_init__(self):
        if self.status not in STATUSES:
            raise ValueError("invalid status: %r" % (self.status,))
        if isinstance(self.priority, bool) or not isinstance(self.priority, int):
            raise ValueError("priority must be an int")
        if not 1 <= self.priority <= 5:
            raise ValueError("priority must be between 1 and 5")
        if self.due is not None and not isinstance(self.due, date):
            raise TypeError("due must be a date or None")
        self.tags = set(self.tags)
