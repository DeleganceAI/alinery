"""The matched process expressed directly in LangGraph's native Graph API."""

import operator
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send


class GraphState(TypedDict, total=False):
    question: str
    state: dict[str, Any]
    discovery: dict[str, Any]
    reads: Annotated[list[dict[str, Any]], operator.add]
    synthesis: dict[str, Any]
    decision: dict[str, Any]
    report: str


def build_graph(agent):
    async def frame(g):
        state = await agent("frame", {"question": g["question"]})
        if state["question"] != g["question"] or (state["round"], state["seen"], state["assessments"], state["synthesis"]) != (
            1, [], [], ""
        ):
            raise ValueError("Frame must produce the specified initial state")
        return {"state": state}

    async def discover(g):
        result = await agent("discover", {"state": g["state"]})
        known = set(g["state"]["seen"])
        fresh = []
        for source in result["sources"]:
            url = source["url"].strip()
            if url and url not in known:
                fresh.append({**source, "url": url})
                known.add(url)
        return {"discovery": {**result, "sources": fresh}}

    def dispatch(g):
        sources = g["discovery"]["sources"]
        return [Send("read", {"state": g["state"], "source": s}) for s in sources] or "finish_empty"

    async def read(g):
        assessment = await agent("read", g)
        source = g["source"]
        if any(assessment[k] != source[k] for k in ("id", "url", "title")):
            raise ValueError("A reader must preserve its source identity")
        return {"reads": [{"round": g["state"]["round"], "assessment": assessment}]}

    async def synthesize(g):
        current = [r["assessment"] for r in g["reads"] if r["round"] == g["state"]["round"]]
        by_url = {a["url"]: a for a in current}
        expected = [s["url"] for s in g["discovery"]["sources"]]
        if len(current) != len(expected) or set(by_url) != set(expected):
            raise ValueError("The entire discovery batch must finish before synthesis")
        assessments = [by_url[url] for url in expected]
        result = await agent("synthesize", {
            "state": g["state"], "discovery": g["discovery"], "assessments": assessments
        })
        state = {**g["state"], "seen": g["state"]["seen"] + expected,
                 "assessments": g["state"]["assessments"] + assessments,
                 "synthesis": result["text"]}
        return {"synthesis": result, "state": state}

    async def decide(g):
        result = await agent("decide", {"state": g["state"], "synthesis": g["synthesis"]})
        state = g["state"]
        if result["continue"]:
            if not result["queries"] or any(not query.strip() for query in result["queries"]):
                raise ValueError("A continuation must supply new queries")
            state = {**state, "round": state["round"] + 1, "queries": result["queries"]}
        elif not result["report"].strip():
            raise ValueError("A stop decision must include the complete report")
        return {"state": state, "decision": result, "report": result["report"]}

    async def finish_empty(g):
        result = await agent("finish_empty", {"state": g["state"], "notes": g["discovery"]["notes"]})
        if not result["report"].strip():
            raise ValueError("Empty discovery must still produce a nonblank report")
        return {"report": result["report"]}

    graph = StateGraph(GraphState)
    for name, fn in [("frame", frame), ("discover", discover), ("read", read),
                     ("synthesize", synthesize), ("decide", decide), ("finish_empty", finish_empty)]:
        graph.add_node(name, fn)
    graph.add_edge(START, "frame")
    graph.add_edge("frame", "discover")
    graph.add_conditional_edges("discover", dispatch, ["read", "finish_empty"])
    graph.add_edge("read", "synthesize")  # LangGraph's super-step joins every Send in this batch.
    graph.add_edge("synthesize", "decide")
    graph.add_conditional_edges("decide", lambda g: "discover" if g["decision"]["continue"] else END)
    graph.add_edge("finish_empty", END)
    return graph.compile()
