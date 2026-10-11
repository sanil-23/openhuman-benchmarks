//! Direct ingestion into the pinned OH memory engine, followed by a fresh
//! thread's real pre-turn lifecycle. This does not measure agent/tool selection.
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tinymemory_api::conformance::ReferenceEngine;
use tinymemory_api::{MemoryEngine, MemoryMeta, Role, StoreItem, Turn};
use tinymemory_integrations::cortex::{CortexCredential, CortexEngine};
use tinymemory_tools::{AgentMemory, MemoryLayout, PreTurn, RecallPolicy};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let task: Value = serde_json::from_slice(&std::fs::read(&args[2])?)?;
    let engine: Arc<dyn MemoryEngine> = match args[1].as_str() {
        "reference" => Arc::new(ReferenceEngine::new()),
        "cortex" => Arc::new(CortexEngine::direct(
            &std::env::var("CORTEX_DB_URL")?,
            CortexCredential::api_key("memory-bench-local"),
        )?),
        _ => return Err("engine must be reference or cortex".into()),
    };
    let layout =
        MemoryLayout::new(format!("project:bench-{}", task["id"].as_str().ok_or("id")?).parse()?)?;
    let node = layout.conversations("benchmark")?;
    let started = Instant::now();
    let mut stored = 0;
    let mut expected = HashSet::new();
    for (i, session) in task["sessions"]
        .as_array()
        .ok_or("sessions")?
        .iter()
        .enumerate()
    {
        let date = session["date"].as_str().unwrap_or("");
        let thread = format!("history-{i}");
        let mut items = Vec::new();
        // Store each turn independently, as the product lifecycle does. A
        // whole-session item would make reference retrieval return full history.
        for (j, row) in session["turns"]
            .as_array()
            .ok_or("turns")?
            .iter()
            .enumerate()
        {
            let role = if row["role"] == "assistant" {
                Role::Assistant
            } else {
                Role::User
            };
            let mut turn = Turn::new(
                role,
                format!(
                    "[session date: {date}] {}",
                    row["text"].as_str().ok_or("text")?
                ),
            );
            turn.at = session["timestamp"].as_str().and_then(|s| s.parse().ok());
            let meta = MemoryMeta {
                namespace: node.clone(),
                agent_id: Some("benchmark".into()),
                thread_id: Some(thread.clone()),
                turns: Some(tinymemory_api::TurnRange {
                    first: j as u32,
                    last: j as u32,
                }),
                observed_at: turn.at,
                ..Default::default()
            };
            items.push(StoreItem::Conversation {
                turns: vec![turn],
                meta,
            });
            stored += 1;
        }
        // Bound each bulk direct-ingest request to the engine's item limit.
        // Readability and enrichment settling are checked after all writes.
        for chunk in items.chunks(tinymemory_api::MAX_STORE_MANY) {
            for receipt in engine
                .store_many_with(chunk.to_vec(), tinymemory_api::WriteOptions::accepted())
                .await?
            {
                expected.insert(receipt.id);
            }
        }
        eprintln!(
            "{} session {}/{}; {stored} turns",
            task["id"],
            i + 1,
            task["sessions"].as_array().unwrap().len()
        );
    }
    // Accepted writes are asynchronous. Require every exact receipt id to
    // be readable before querying. Listing is not an indexing certificate:
    // retain server logs and audit indexed batch counts as well.
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        let mut readable = HashSet::new();
        let mut req =
            tinymemory_api::ListRequest::new(layout.conversations_filter(Some("benchmark")), 100);
        loop {
            let page = engine.list(req.clone()).await?;
            readable.extend(page.items.into_iter().map(|hit| hit.id));
            req.cursor = page.next_cursor;
            if req.cursor.is_none() {
                break;
            }
        }
        if expected.is_subset(&readable) {
            break;
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "only {} of {} ingested turn ids are readable",
                expected.intersection(&readable).count(),
                expected.len()
            )
            .into());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let mut enrichment = Value::Null;
    if args[1] == "cortex" {
        let url = std::env::var("CORTEX_DB_URL")?;
        let client = reqwest::Client::new();
        let deadline = Instant::now() + Duration::from_secs(600);
        let mut quiet = 0;
        let mut last_queued = None;
        loop {
            let usage: Value = client
                .get(format!("{url}/v1/admin/usage"))
                .bearer_auth("memory-bench-local")
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            enrichment = usage["enrichment_backlog"].clone();
            let pending = enrichment["jobs_pending"]
                .as_u64()
                .ok_or("missing enrichment pending count")?;
            let queued = enrichment["jobs_queued_total"]
                .as_u64()
                .ok_or("missing enrichment queued count")?;
            eprintln!(
                "{} enrichment at={} pending={pending} queued={queued}",
                task["id"],
                chrono::Utc::now().to_rfc3339()
            );
            quiet = if pending == 0 && last_queued == Some(queued) {
                quiet + 1
            } else {
                0
            };
            last_queued = Some(queued);
            if quiet >= 3 {
                break;
            }
            if Instant::now() >= deadline {
                return Err(format!("enrichment failed to drain: {enrichment}").into());
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }
    let ingest_ms = started.elapsed().as_millis();
    let mut policy = RecallPolicy::default();
    if let Some(budget) = args.get(3) {
        policy.budget_tokens = budget.parse()?;
    }
    if let Some(history) = args.get(4) {
        policy.history_limit = history.parse()?;
    }
    let memory = AgentMemory::new(engine.clone(), layout, "benchmark")?.with_policy(policy.clone());
    let mut probes = Vec::new();
    for (i, q) in task["questions"]
        .as_array()
        .ok_or("questions")?
        .iter()
        .enumerate()
    {
        let started = Instant::now();
        let text = format!(
            "{}{}",
            q["question"].as_str().ok_or("question")?,
            q["question_date"]
                .as_str()
                .map(|s| format!("\nCurrent date: {s}"))
                .unwrap_or_default()
        );
        let context = memory
            .pre_turn(PreTurn::new(format!("fresh-{i}"), 0, text))
            .await?;
        probes.push(json!({"id": q["id"], "pack": context.pack.markdown,
            "context": context.pack, "log_error": context.log_error,
            "query_ms": started.elapsed().as_millis()}));
        // pre_turn logs the question. Remove it so a later probe cannot
        // retrieve an earlier benchmark question from a different thread.
        if let Some(receipt) = context.logged {
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                let report = engine
                    .forget(tinymemory_api::ForgetTarget::Ids(vec![receipt.id.clone()]))
                    .await?;
                if report.forgotten == 1 {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("probe question never became removable".into());
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
    println!(
        "{}",
        json!({"engine": engine.descriptor().id, "mode": "direct-ingest/pre-turn",
        "stored_turns": stored, "write_wait": "accepted; all receipt ids listed; enrichment quiet for three polls",
        "policy": policy, "enrichment": enrichment, "ingest_ms": ingest_ms, "probes": probes})
    );
    Ok(())
}
