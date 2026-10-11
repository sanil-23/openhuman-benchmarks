# Memory audit results

Scored comparisons: 79/80. Coverage is partial; compare question counts before interpreting means.

| Dataset | System | Questions | Metric | Mean |
|---|---|---:|---|---:|
| longmemeval | no-memory | 7 | official-judge-prompt | 14.3% |
| longmemeval | full-context | 7 | official-judge-prompt | 71.4% |
| locomo | no-memory | 13 | official-category-f1/abstention | 18.5% |
| longmemeval | reference-memory | 7 | official-judge-prompt | 42.9% |
| locomo | full-context | 13 | official-category-f1/abstention | 28.5% |
| locomo | reference-memory | 13 | official-category-f1/abstention | 27.1% |
| locomo | oh-tinymemory-cortex-direct | 13 | official-category-f1/abstention | 22.2% |
| longmemeval | oh-tinymemory-cortex-direct | 6 | official-judge-prompt | 50.0% |

Questions scored by every arm (setup failures excluded from all arms here):

| Dataset | System | Matched questions | Mean |
|---|---|---:|---:|
| longmemeval | no-memory | 6 | 16.7% |
| longmemeval | full-context | 6 | 66.7% |
| longmemeval | reference-memory | 6 | 33.3% |
| longmemeval | oh-tinymemory-cortex-direct | 6 | 50.0% |
| locomo | no-memory | 13 | 18.5% |
| locomo | full-context | 13 | 28.5% |
| locomo | reference-memory | 13 | 27.1% |
| locomo | oh-tinymemory-cortex-direct | 13 | 22.2% |

Reported upstream cost: $2.0559. Budget charged including uncertain/in-flight reservations: $2.2528 of $10.

- Smoke subset; no population accuracy claim
- Direct TinyMemory lifecycle, not desktop/core wiring
- Aggregate quiet enrichment polls do not certify complete per-turn enrichment; native scores are snapshots
- Reference engine is a deterministic control, not an independent memory product
- memory-background costs include ingestion and recall; asynchronous work prevents exact phase attribution
- Core deadline comparison is diagnostic; the core timeout hook was not executed
- LoCoMo scores are official category-specific F1/abstention, not judge accuracy
