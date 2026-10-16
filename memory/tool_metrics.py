"""Memory tool use per question, read from a run's gateway log (meter.jsonl).

Every agent model call's request carries the conversation so far, with each
memory tool call (assistant `tool_calls`) and its result (a `tool` message).
For each question this counts the `recall` and `fetch` calls (and any other
memory action) and the tokens their results added, plus the agent's model
calls and prompt tokens. A tool result seen in several requests is counted
once, at the largest size seen (the context ladder may shorten old results).
Tokens are o200k counts scaled by 1.04, the ratio measured against
DeepSeek's own count on this benchmark.

usage: python3 tool_metrics.py RUN_DIR SYSTEM [--json OUT]
"""
import json
import sys
from collections import defaultdict

import tiktoken

ENC = tiktoken.get_encoding("o200k_base")


def tokens(text):
    return round(len(ENC.encode(text)) * 1.04)


def per_question(run_dir, system):
    calls = defaultdict(list)
    for line in open(f"{run_dir}/meter.jsonl"):
        row = json.loads(line)
        phase = row.get("phase", "")
        if phase.startswith(system + "/") and row.get("status") == 200:
            calls[phase.split("/", 1)[1]].append(row)
    out = {}
    for qid, rows in calls.items():
        actions, results = {}, {}
        for row in rows:
            for message in (row.get("request") or {}).get("messages") or []:
                if message.get("role") == "assistant":
                    for call in message.get("tool_calls") or []:
                        fn = call.get("function") or {}
                        if fn.get("name") != "memory":
                            continue
                        try:
                            action = json.loads(fn.get("arguments") or "{}").get("action") or "unknown"
                        except json.JSONDecodeError:
                            action = "unknown"
                        actions[call.get("id")] = action
                if message.get("role") == "tool":
                    content = message.get("content")
                    content = content if isinstance(content, str) else json.dumps(content)
                    key = message.get("tool_call_id")
                    if key and len(content) > len(results.get(key, "")):
                        results[key] = content
        stats = {"recalls": 0, "recall_tokens": 0, "fetches": 0, "fetch_tokens": 0, "other_memory_calls": 0, "other_memory_tokens": 0}
        for key, action in actions.items():
            size = tokens(results.get(key, ""))
            if action == "recall":
                stats["recalls"] += 1; stats["recall_tokens"] += size
            elif action == "fetch":
                stats["fetches"] += 1; stats["fetch_tokens"] += size
            else:
                stats["other_memory_calls"] += 1; stats["other_memory_tokens"] += size
        stats["agent_model_calls"] = len(rows)
        stats["agent_prompt_tokens"] = sum((r.get("usage") or {}).get("prompt_tokens") or 0 for r in rows)
        out[qid] = stats
    return out


if __name__ == "__main__":
    run_dir, system = sys.argv[1], sys.argv[2]
    result = per_question(run_dir, system)
    if "--json" in sys.argv:
        json.dump(result, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
    for qid, s in sorted(result.items()):
        print(f"{qid:18} recalls {s['recalls']} ({s['recall_tokens']:,} tok)  fetches {s['fetches']} ({s['fetch_tokens']:,} tok)"
              f"  other {s['other_memory_calls']}  | agent calls {s['agent_model_calls']}, prompt {s['agent_prompt_tokens']:,}")
