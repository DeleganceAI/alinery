"""Run a real LangGraph with fixture or fresh Claude CLI agent calls."""

import argparse
import asyncio
import json
import sys
from importlib.metadata import version
from pathlib import Path

from agents import ClaudeAgent, FIXTURES, FixtureAgent, SHARED
from process import build_graph


async def run(agent, question, step_limit=1000, max_concurrency=8):
    graph = build_graph(agent)
    updates = []
    result = {}
    error = None
    try:
        async for mode, item in graph.astream(
            {"question": question, "reads": []},
            {"recursion_limit": step_limit, "max_concurrency": max_concurrency},
            stream_mode=["updates", "values"],
        ):
            if mode == "updates":
                updates.append(item)
            else:
                result = item
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc)}
    return {"engine": "langgraph", "version": version("langgraph"),
            "agent_adapter": type(agent).__name__, "events": agent.events,
            "native_updates": updates, "result": result, "error": error}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["fixture", "live"], default="fixture")
    parser.add_argument("--scenario", choices=list(FIXTURES["scenarios"]), default="normal")
    parser.add_argument("--question-file", type=Path, default=SHARED / "question.txt")
    parser.add_argument("--output", type=Path, default=Path("run.json"))
    parser.add_argument("--step-limit", type=int, default=1000, help="Operational safety limit, not a scientific stopping rule")
    parser.add_argument("--max-concurrency", type=int, default=8)
    args = parser.parse_args()
    agent = FixtureAgent(args.scenario) if args.mode == "fixture" else ClaudeAgent()
    evidence = asyncio.run(run(agent, args.question_file.read_text().strip(), args.step_limit, args.max_concurrency))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(evidence["error"] or evidence["result"].get("report", ""))
    return 1 if evidence["error"] else 0


if __name__ == "__main__":
    sys.exit(main())
