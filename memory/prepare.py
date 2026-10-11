"""Prepare a fixed, category-stratified 20-question text-only smoke subset.

Raw datasets remain local; hashes and selected IDs are committed. Ground truth
is kept in a separate file that the memory runner never reads.
"""
import hashlib
import json
import pathlib
import random
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent
SEED = 27
PINS = {
    "longmemeval": "2ec2a557f339b6c0369619b1ed5793734cc87533",
    "locomo": "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
    "longmemeval_scorer": "9e0b455f4ef0e2ab8f2e582289761153549043fc",
}

def date(value):
    for fmt in ["%Y/%m/%d (%a) %H:%M", "%Y/%m/%d (%a) %H:%M:%S", "%I:%M %p on %d %B, %Y"]:
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    raise ValueError(f"unrecognised timestamp: {value}")

def prepare():
    committed = ROOT/'manifest.json'
    if committed.exists():
        expected = json.loads(committed.read_text())['sha256']
        for name, digest in expected.items():
            actual = hashlib.sha256((ROOT/'source'/name).read_bytes()).hexdigest()
            if actual != digest:
                raise ValueError(f'pinned source hash mismatch: {name}')
    output = ROOT / "data"
    output.mkdir(exist_ok=True)
    lme = json.loads((ROOT / "source/longmemeval.json").read_text())
    loco = json.loads((ROOT / "source/locomo.json").read_text())
    rng = random.Random(SEED)
    # Pick one instance per category, plus abstention, from the shortest
    # quartile by bytes. This is a smoke subset, not a population estimate.
    groups = {}
    for row in lme:
        category = "abstention" if "_abs" in row["question_id"] else row["question_type"]
        groups.setdefault(category, []).append(row)
    tasks, refs = [], {}
    for category, rows in sorted(groups.items()):
        rows.sort(key=lambda r: len(json.dumps(r["haystack_sessions"])))
        row = rng.choice(rows[:max(1, len(rows)//4)])
        qid = row["question_id"]
        q = {"id": qid, "question": row["question"], "category": category, "question_date": row["question_date"]}
        sessions = []
        for sid, at, turns in zip(row["haystack_session_ids"], row["haystack_dates"], row["haystack_sessions"]):
            sessions.append({"id": sid, "date": at, "timestamp": date(at), "turns": [
                {"role": t["role"], "text": t["content"]} for t in turns]})
        tasks.append({"id": "lme-" + qid.replace('_', '-'), "dataset": "longmemeval", "sessions": sessions, "questions": [q]})
        refs[qid] = {"answer": row["answer"], "type": row["question_type"], "abstention": "_abs" in qid,
                     "answer_session_ids": row["answer_session_ids"]}
    # All LoCoMo questions share one complete dialogue; no questions or
    # answer evidence are present in the ingestion file.
    row = loco[0]
    conv = row["conversation"]
    sessions = []
    keys = sorted((k for k in conv if k.startswith('session_') and not k.endswith('_date_time')), key=lambda k: int(k.split('_')[1]))
    for k in keys:
        at = conv[k + '_date_time']
        sessions.append({"id": k, "date": at, "timestamp": date(at), "turns": [
            {"role": "user" if t["speaker"] == conv["speaker_a"] else "assistant",
             "text": f'{t["dia_id"]} {t["speaker"]}: {t["text"]}' + (f' [image caption: {t["blip_caption"]}]' if 'blip_caption' in t else '')} for t in conv[k]]})
    by_category = {}
    for index, q in enumerate(row["qa"]):
        by_category.setdefault(q["category"], []).append((index, q))
    for rows in by_category.values():
        rng.shuffle(rows)
    selected = []
    while len(selected) < 20-len(tasks):
        for cat in sorted(by_category):
            if by_category[cat] and len(selected) < 20-len(tasks):
                selected.append(by_category[cat].pop())
    questions = []
    for index, q in selected:
        qid = f'locomo-0-{index}'
        questions.append({"id": qid, "question": q["question"], "category": q["category"]})
        refs[qid] = {"answer": q.get("answer", "no information available"), "category": q["category"], "evidence": q["evidence"]}
    tasks.append({"id": "locomo-0", "dataset": "locomo", "sessions": sessions, "questions": questions})
    for task in tasks:
        (output / (task['id']+'.json')).write_text(json.dumps(task))
    (output / 'references.json').write_text(json.dumps(refs))
    manifest = {"seed": SEED, "pins": PINS, "selection": "shortest-quartile LME stratified; LoCoMo dialogue 0 category round-robin; text plus supplied captions",
                "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'source').iterdir() if p.is_file()},
                "references_sha256": hashlib.sha256((output/'references.json').read_bytes()).hexdigest(),
                "tasks": [{"id": t['id'], "sha256": hashlib.sha256((output/(t['id']+'.json')).read_bytes()).hexdigest(), "dataset": t['dataset'], "questions": [q['id'] for q in t['questions']],
                           "sessions": len(t['sessions']), "turns": sum(len(s['turns']) for s in t['sessions'])} for t in tasks]}
    (ROOT/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(json.dumps(manifest['tasks'], indent=2))

if __name__ == '__main__':
    prepare()
