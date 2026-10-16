"""Off-manifest LongMemEval_M tasks: one ~1.5M-token chat history per question.

LongMemEval_M (`source/longmemeval_m.json`, the dataset's medium variant at the
same pinned commit as `longmemeval.json`) gives each question its own history
of about 500 sessions. This writes the chosen questions as task files in the
benchmark's task format (as prepare.py writes LongMemEval_S tasks) under
`data-m/`, with their references in `data-m/references.json`. They are not in
the pinned manifest: integration.mjs reads one with `--task-file`.

The source is a 2.7 GB JSON array, read one question at a time so it never
has to fit in memory at once.

usage: python3 -I prepare_lme_m.py QUESTION_ID [QUESTION_ID ...]
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
# Run with `python3 -I` (it reads a downloaded file), which leaves the
# script's own directory off the import path; prepare.py lives there.
sys.path.insert(0, str(ROOT))
from prepare import date  # noqa: E402
SOURCE = ROOT / "source" / "longmemeval_m.json"
OUT = ROOT / "data-m"


def rows(path, chunk=1 << 22):
    """The objects of a top-level JSON array, one at a time."""
    decoder = json.JSONDecoder()
    buffer = ""
    with open(path, encoding="utf-8") as f:
        while not buffer.lstrip().startswith("["):
            more = f.read(chunk)
            if not more:
                raise ValueError("not a JSON array")
            buffer += more
        buffer = buffer.lstrip()[1:]
        while True:
            buffer = buffer.lstrip().lstrip(",").lstrip()
            if buffer.startswith("]"):
                return
            try:
                row, end = decoder.raw_decode(buffer)
            except json.JSONDecodeError:
                more = f.read(chunk)
                if not more:
                    raise
                buffer += more
                continue
            yield row
            buffer = buffer[end:]


def main(wanted):
    OUT.mkdir(exist_ok=True)
    refs_path = OUT / "references.json"
    refs = json.loads(refs_path.read_text()) if refs_path.exists() else {}
    left = set(wanted)
    for row in rows(SOURCE):
        qid = row["question_id"]
        if qid not in left:
            continue
        category = "abstention" if "_abs" in qid else row["question_type"]
        q = {"id": qid, "question": row["question"], "category": category, "question_date": row["question_date"]}
        sessions = []
        for sid, at, turns in zip(row["haystack_session_ids"], row["haystack_dates"], row["haystack_sessions"]):
            sessions.append({"id": sid, "date": at, "timestamp": date(at), "turns": [
                {"role": t["role"], "text": t["content"]} for t in turns]})
        task = {"id": "lmem-" + qid.replace("_", "-"), "dataset": "longmemeval", "variant": "M",
                "sessions": sessions, "questions": [q]}
        (OUT / f"{task['id']}.json").write_text(json.dumps(task))
        refs[qid] = {"answer": row["answer"], "type": row["question_type"], "abstention": "_abs" in qid,
                     "answer_session_ids": row["answer_session_ids"]}
        turns = sum(len(s["turns"]) for s in sessions)
        chars = sum(len(t["text"]) for s in sessions for t in s["turns"])
        print(f"{task['id']}: {len(sessions)} sessions, {turns} turns, {chars} characters")
        left.discard(qid)
        if not left:
            break
    refs_path.write_text(json.dumps(refs, indent=1))
    if left:
        raise SystemExit(f"not found: {sorted(left)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
