"""Agent I/O only; process scheduling lives in process.py and LangGraph."""

import asyncio
import copy
import json
import time
from pathlib import Path

from jsonschema import validate

SHARED = Path(__file__).resolve().parents[1] / "shared"
PROMPTS = json.loads((SHARED / "prompts.json").read_text())
SCHEMAS = json.loads((SHARED / "schemas.json").read_text())
FIXTURES = json.loads((SHARED / "fixtures.json").read_text())


class Agent:
    def __init__(self):
        self.events = []

    async def __call__(self, phase, context):
        meta = {"phase": phase, "round": context.get("state", {}).get("round", 1),
                "source": context.get("source", {}).get("id")}
        self.events.append({**meta, "event": "start", "time": time.monotonic(), "input": copy.deepcopy(context)})
        try:
            result = await self.invoke(phase, context)
            validate(result, SCHEMAS[phase])
        except BaseException as error:
            self.events.append({**meta, "event": "error", "time": time.monotonic(), "error": str(error)})
            raise
        self.events.append({**meta, "event": "end", "time": time.monotonic(), "output": copy.deepcopy(result)})
        return result


class FixtureAgent(Agent):
    def __init__(self, scenario):
        super().__init__()
        self.base = copy.deepcopy(FIXTURES["responses"])
        self.overrides = copy.deepcopy(FIXTURES["scenarios"][scenario])

    async def invoke(self, phase, context):
        key = context["source"]["id"] if phase == "read" else str(context["state"]["round"]) if phase != "frame" else None
        if phase == "read":
            await asyncio.sleep(0.03 if key == "B" else 0.01)
        value = self.overrides.get(phase, self.base[phase]) if key is None else self.overrides.get(phase, {}).get(key, self.base[phase].get(key))
        if value is None:
            raise ValueError(f"Missing fixture: {phase}/{key}")
        if "__error__" in value:
            raise RuntimeError(value["__error__"])
        return copy.deepcopy(value)


class ClaudeAgent(Agent):
    """One new Claude Code process per authored-operation invocation."""
    async def invoke(self, phase, context):
        prompt = PROMPTS[phase] + "\n\nInput context (JSON):\n" + json.dumps(context)
        child = await asyncio.create_subprocess_exec(
            "claude", "-p", "--safe-mode", "--no-session-persistence",
            "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
            "--permission-mode", "dontAsk", "--output-format", "json",
            "--json-schema", json.dumps(SCHEMAS[phase]),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await child.communicate(prompt.encode())
        except BaseException:
            if child.returncode is None:
                child.terminate()
                await child.wait()
            raise
        if child.returncode:
            raise RuntimeError(f"Claude failed ({child.returncode}): {stderr.decode().strip() or stdout.decode().strip()}")
        envelope = json.loads(stdout)
        if envelope.get("is_error"):
            raise RuntimeError(f"Claude error: {envelope.get('result', envelope)}")
        if "structured_output" not in envelope:
            raise ValueError("Claude returned no structured_output")
        return envelope["structured_output"]
