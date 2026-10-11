# LongMemEval-V2 setup

This directory installs the unchanged [official artifact](https://github.com/xiaowu0162/LongMemEval-V2)
at code revision `2cc8c540bdb87fe6761629b585e727e1c4704520`, with the
[public dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2)
at revision `f152293e235517d504809563c833d7190b8c713b`.
Both releases use Apache-2.0. `pins.json` records these revisions and the
SHA-256 of the upstream checksum manifest. `requirements.lock` pins the
Python dependencies for Linux, including a CPU PyTorch build; no GPU or model weights
are required to validate data or exercise the no-retrieval harness.

Run from the benchmark worktree, with `git` and `uv` installed:

```sh
python3 longmemeval-v2/setup.py bootstrap
python3 longmemeval-v2/setup.py data
python3 longmemeval-v2/setup.py check
python3 longmemeval-v2/setup.py inventory
python3 longmemeval-v2/setup.py smoke
```

The installation, virtual environment, downloaded data and extracted
screenshots stay under `.cache/` and are excluded from Git. Download size is
about 7.1 GB; extraction requires additional disk space. The data command
resumes the full pinned snapshot, verifies every entry in its checksum
manifest before extraction, prepares screenshot links, and runs the official
validator for both tiers. It does not skip screenshot downloads merely
because the two JSONL files already exist.

The released checksum manifest has one stale entry: `README.md`. The other
36 entries, including both trajectory archives, questions, trajectories and
haystacks, match exactly. `pins.json` pins the released README's actual hash
as a documentation-only override; modifications to that README or any data
file still fail verification. Three integrity regression tests cover this.

`bootstrap` runs the seven upstream query-privacy tests. `smoke` runs the
official evaluation harness against a synthetic localhost reader, verifies
one correct and one wrong answer, checks score aggregation, and verifies that
gold answers and private question metadata do not reach the reader. It strips
API keys from the child environment and verifies screenshot delivery using a
synthetic PNG question.
Synthetic scores are discarded and
must never be published as benchmark results. These commands perform no paid
inference.

## Dataset coverage

| Domain | Questions | Questions with screenshots |
| --- | ---: | ---: |
| Web | 240 | 15 |
| Enterprise | 211 | 14 |
| Total | 451 | 29 |

Both domains cover static recall, dynamic tracking, procedures, gotchas and
flawed-premise detection. The public files contain 1,870 trajectories. Small
uses 100 trajectories per haystack; medium usually uses 500. Trajectory
screenshots remain relevant even when a question itself has no image.

## Running models and connecting OH

The official entry points are `.cache/longmemeval-v2/evaluation/harness.py`
and `evaluation/run_eval.py` in that checkout. `harness.py --help` lists
separate reader and evaluator endpoints. The paper uses Qwen3.5-9B as its
reader, Qwen3-Embedding-8B for embedding methods, and GPT-5.2 with medium
reasoning for LLM scoring. GLM 5.3 Flash results must be reported as a separate
configuration, with reader and judge identities and retrieval latency.

No paid launcher or OH adapter is included in this setup. The previous memory
audit's gateway accepts only text requests, whereas V2 prompts can contain
images. Do not remove images or bypass that gateway to obtain a purported
full V2 score. A subsequent paid integration needs a multimodal cost bound,
reader capability validation, and the existing session budget ledger. The
original $10 authorization has $2.2527659200000105 conservatively charged;
read the live ledger before spending rather than treating this snapshot as
an additional $10 allowance. The upstream shell wrappers can call paid
services directly and do not enforce our cap.

An OH backend should implement the official `Memory.insert(trajectory)` and
`Memory.query(query, query_image=None)` contract, return text/image evidence,
and isolate each haystack. The official harness intentionally keeps gold
answers, category labels and dataset question IDs out of the backend query
context. Its only lifecycle identifier is an opaque invocation ID. Preserve
those privacy guarantees, the screenshot modality, and the official scoring
functions when adding the adapter.
