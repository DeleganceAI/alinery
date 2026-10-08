"""Run native-engine conformance cases and save inspectable evidence."""

import asyncio
import hashlib
import json
import platform
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from agents import FIXTURES, FixtureAgent, SHARED
from run import run

HERE = Path(__file__).resolve().parent


async def main():
    evidence_dir = HERE / "evidence"
    evidence_dir.mkdir(exist_ok=True)
    results = []
    for scenario, readers, syntheses, empty in [
        ("normal", {1: 2, 2: 1}, 2, 0),
        ("empty_first", {}, 0, 1),
        ("empty_second", {1: 2}, 1, 1),
        ("failed_reader", {1: 2}, 0, 0),
        ("one_reader", {1: 1}, 1, 0),
    ]:
        agent = FixtureAgent(scenario)
        evidence = await run(agent, FIXTURES["question"])
        starts = [e for e in agent.events if e["event"] == "start"]
        counts = Counter(e["phase"] for e in starts)
        assert counts["frame"] == 1
        assert dict(Counter(e["round"] for e in starts if e["phase"] == "read")) == readers
        assert counts["synthesize"] == syntheses
        assert counts["decide"] == syntheses
        assert counts["finish_empty"] == empty
        if scenario == "failed_reader":
            assert evidence["error"]["message"] == "SIMULATED reader B failed"
            assert any(e["phase"] == "read" and e["source"] == "A" and e["event"] == "end" for e in agent.events)
            assert not evidence["result"].get("report")
        else:
            assert evidence["error"] is None, evidence["error"]
            assert evidence["result"]["report"]
        for entry in starts:
            if entry["phase"] == "decide":
                expected_ids = ["A", "B", "C"] if entry["round"] == 2 else ["A"] if scenario == "one_reader" else ["A", "B"]
                assert [a["id"] for a in entry["input"]["state"]["assessments"]] == expected_ids
                assert entry["input"]["state"]["synthesis"] == entry["input"]["synthesis"]["text"]
            if entry["phase"] == "synthesize":
                finished = [e for e in agent.events if e["phase"] == "read" and e["event"] == "end" and e["round"] == entry["round"]]
                assert len(finished) == readers[entry["round"]]
                assert max(e["time"] for e in finished) < entry["time"]
                assert len(entry["input"]["assessments"]) == readers[entry["round"]]
                if entry["round"] == 2:
                    assert [a["id"] for a in entry["input"]["state"]["assessments"]] == ["A", "B"]
                    assert [a["id"] for a in entry["input"]["assessments"]] == ["C"]
        if readers.get(1) == 2:
            read_events = [e for e in agent.events if e["phase"] == "read" and e["round"] == 1]
            assert max(e["time"] for e in read_events if e["event"] == "start") < min(e["time"] for e in read_events if e["event"] == "end")
        (evidence_dir / f"{scenario}.json").write_text(json.dumps(evidence, indent=2) + "\n")
        results.append({"scenario": scenario, "passed": True, "reader_counts": readers, "phase_counts": dict(counts), "expected_failure": scenario == "failed_reader"})
    # Repeat URLs, including surrounding whitespace, do not create new workers.
    agent = FixtureAgent("normal")
    a = agent.base["discover"]["1"]["sources"][0]
    agent.base["discover"]["1"]["sources"].append({**a, "url": "  " + a["url"] + "  "})
    agent.base["discover"]["2"]["sources"].append(a)
    evidence = await run(agent, FIXTURES["question"])
    assert evidence["error"] is None, evidence["error"]
    assert [e["source"] for e in agent.events if e["phase"] == "read" and e["event"] == "start"] == ["A", "B", "C"]
    (evidence_dir / "duplicate_urls.json").write_text(json.dumps(evidence, indent=2) + "\n")
    results.append({"scenario": "duplicate_urls", "passed": True})
    for name, scenario, phase, key, updates, forbidden in [
        ("invalid_frame_question", "normal", "frame", None, {"question": "changed question"}, "discover"),
        ("invalid_reader_identity", "normal", "read", "B", {"title": "changed title"}, "synthesize"),
        ("invalid_continuation", "normal", "decide", "1", {"queries": [" "]}, "finish_empty"),
        ("invalid_stop_report", "one_reader", "decide", "1", {"report": " "}, "finish_empty"),
        ("invalid_empty_report", "empty_first", "finish_empty", "1", {"report": " "}, "read"),
    ]:
        agent = FixtureAgent(scenario)
        if key is None:
            agent.base[phase].update(updates)
        else:
            target = agent.overrides.get(phase, {}).get(key, agent.base[phase][key])
            agent.overrides.setdefault(phase, {})[key] = {**target, **updates}
        evidence = await run(agent, FIXTURES["question"])
        assert evidence["error"] is not None, name
        assert not any(e["phase"] == forbidden for e in agent.events), name
        assert not any(e["phase"] == "discover" and e["round"] == 2 for e in agent.events), name
        (evidence_dir / f"{name}.json").write_text(json.dumps(evidence, indent=2) + "\n")
        results.append({"scenario": name, "passed": True, "expected_failure": evidence["error"]})
    summary = {"verified_at": datetime.now(timezone.utc).isoformat(), "python": platform.python_version(),
               "engine": "langgraph", "version": evidence["version"], "runtime": "native StateGraph / Send, no scheduler shim",
               "inference": "deterministic synthetic fixtures; live Claude calls not run (CLI signed out)",
               "live_adapter_cli": "Claude Code 2.1.289 (installed --help inspected; live inference not tested)",
               "shared_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in SHARED.glob("*.json")},
               "cases": results}
    (evidence_dir / "verification.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
