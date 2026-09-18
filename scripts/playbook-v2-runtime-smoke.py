#!/usr/bin/env python3
"""Throwaway real-daemon/runner/OMP smoke; run only after integration is stable.

Run under the parent hub supervisor:
  python3 scripts/playbook-v2-runtime-smoke.py --mode both
Requires freshly built alineryd/alinery-runner/alinery-mcp beside one another.
No fake daemon ACKs, no print mode, no forced-exit success, no provider credentials.
PTY uses public restate before releasing the fixture provider. Its initial RPC
preparation child pauses before exec so it cannot create a resume journal; only
the replacement real PTY OMP's ordinary exit counts. Rejected restate is failure.
The temporary exec observer records PID and predecessor liveness at launch;
it neither wraps completion nor replaces the real runner.
"""
import argparse
import ctypes
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import threading
import time


class SmokeFailure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise SmokeFailure(message)


def emit(event, **fields):
    print(json.dumps({"event": event, "monotonic_ns": time.monotonic_ns(), **fields}), flush=True)


def protected_interpreter():
    if sys.platform == "darwin":
        buffer = ctypes.create_string_buffer(4096)
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
        require(libproc.proc_pidpath(os.getpid(), buffer, len(buffer)) > 0, "cannot inspect actual Python executable")
        return str(Path(buffer.value.decode()).resolve())
    if sys.platform.startswith("linux"):
        return str(Path("/proc/self/exe").resolve())
    raise SmokeFailure("unsupported protected-host fixture platform")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def send(sock, request):
    if request.get("op") == "create_task":
        body = json.dumps(request["request"]).encode()
        sock.sendall(json.dumps({"op": "create_task", "body_bytes": len(body)}).encode() + b"\n")
        sock.sendall(body)
    else:
        sock.sendall(json.dumps(request).encode() + b"\n")
    response = bytearray()
    while not response.endswith(b"\n"):
        chunk = sock.recv(1)
        require(chunk, "daemon closed before reply")
        response.extend(chunk)
        require(len(response) <= 4 * 1024 * 1024, "oversized daemon reply")
    value = json.loads(response)
    require(not value.get("error"), f"{request['op']}: {value.get('error')}")
    return value


def rpc(path, request):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(15)
        sock.connect(str(path))
        return send(sock, request)


def authored_source():
    text = '+++\nversion = 2\nkey = "runtime-smoke"\ntitle = "Runtime smoke"\ndescription = "Ordinary shutdown proof"\ndefault_model = ""\ndefault_harness = "omp"\n'
    for step, previous in [("source", "ticket.md"), ("sink", "source.md")]:
        text += f'''[[step]]
key = "{step}"
title = "{step}"
short = ""
is_coding_step = true
auto_advance_default = {str(step == "sink").lower()}
inputs = [{{path = "{previous}", mode = "single"}}]
outputs = [{{path = "{step}.md"}}]
model = ""
harness = "omp"
'''
    text += '+++\n'
    for step in ["source", "sink"]:
        text += f'<!-- alinery:step {step} -->\nSMOKE_STEP={step}\nWrite the assigned required output using the write tool with content "real OMP {step} output". Then call alinery_phase_complete. If human permission is required, retry only after permission is granted. After acceptance do no further work; finish normally.\n'
    return text


# The actual provider boundary only: tools are selected from the real request's
# schema. Receipts and completion results can only come from runner -> daemon.
class Provider:
    def __init__(self, deadline):
        self.deadline = deadline
        self.release = {step: threading.Event() for step in ["source", "sink"]}
        self.lock_seen = threading.Event()
        self.granted = threading.Event()
        self.errors = []
        self.requests = 0
        self.lock = threading.Lock()

    def wait(self, event, label):
        require(event.wait(max(0, self.deadline - time.monotonic())), f"provider timeout: {label}")

    def reply(self, body):
        messages = body.get("messages", [])
        text = json.dumps(messages)
        markers = re.findall(r"SMOKE_STEP=(source|sink)", text)
        require(markers, "provider request missing actual assigned step prompt")
        step = markers[-1]
        self.wait(self.release[step], f"{step} transport ready")
        tools = {item["name"]: item for item in body.get("tools", [])}
        with self.lock:
            self.requests += 1
            serial = self.requests
        uses = [part for message in messages if isinstance(message.get("content"), list)
                for part in message["content"] if part.get("type") == "tool_use"]
        results = [part for message in messages if isinstance(message.get("content"), list)
                   for part in message["content"] if part.get("type") == "tool_result"]
        last_result = json.dumps(results[-1]) if results else ""
        require(not (results and results[-1].get("is_error")), f"{step}: real OMP tool returned error: {last_result[:1000]}")
        if "Human authorization is required" in last_result:
            self.lock_seen.set()
            self.wait(self.granted, "verified human grant")
        if "Alinery accepted phase completion" in last_result:
            # Ordinary shutdown is cooperative, not a no-next-provider-call fence.
            content, reason = [{"type": "text", "text": "Work complete."}], "end_turn"
        elif not any(use.get("name", "").split(".")[-1] == "write" for use in uses):
            names = [name for name in tools if name.split(".")[-1] == "write"]
            require(len(names) == 1, f"write tool absent/ambiguous; advertised tools: {list(tools)}")
            name = names[0]
            # Use the daemon-assigned physical path in the actual seed prompt.
            plain = "\n".join(part.get("text", "") for message in messages
                              for part in (message.get("content") if isinstance(message.get("content"), list)
                                           else [{"text": message.get("content", "")}]))
            assignments = re.findall(r"Write: (.+?) \(logical " + step + r"\.md;", plain)
            require(len(set(assignments)) == 1, f"{step}: missing or ambiguous authoritative write assignment")
            properties = tools[name].get("input_schema", {}).get("properties", {})
            path_key = "path" if "path" in properties else "file_path"
            require(path_key in properties and "content" in properties, f"unsupported real write schema: {properties}")
            args = {path_key: assignments[0], "content": f"real OMP {step} output\n"}
            if "i" in properties:
                args["i"] = "Writing runtime smoke output"
            required = set(tools[name]["input_schema"].get("required", []))
            require(required <= args.keys(), f"unsupported required write arguments: {required - args.keys()}")
            content, reason = [{"type": "tool_use", "id": f"toolu_smoke_{serial}", "name": name, "input": args}], "tool_use"
        else:
            names = [name for name in tools if name.split(".")[-1] == "alinery_phase_complete"]
            if names:
                require(len(names) == 1, "ambiguous real completion tool")
                name, arguments = names[0], {}
            else:
                # OMP 18 exposes extension tools as XD devices behind its real write tool.
                require("xd://alinery_phase_complete" in json.dumps(body.get("system", [])), "completion device not registered in the actual OMP system prompt")
                names = [name for name in tools if name.split(".")[-1] == "write"]
                require(len(names) == 1, "completion device needs the actual write tool")
                name = names[0]
                arguments = {"path": "xd://alinery_phase_complete", "content": "{}", "i": "Completing runtime smoke"}
            content, reason = [{"type": "tool_use", "id": f"toolu_smoke_{serial}", "name": name, "input": arguments}], "tool_use"
        emit("provider_response", step=step, number=serial, content_types=[part["type"] for part in content],
             tool_names=[part["name"] for part in content if "name" in part], result_roundtrip=bool(results))
        return {"id": f"msg_smoke_{serial}", "type": "message", "role": "assistant", "model": body.get("model"),
                "content": content, "stop_reason": reason, "stop_sequence": None,
                "usage": {"input_tokens": 100, "output_tokens": 20}}

    def handler(self):
        provider = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    require(0 < length <= 8 * 1024 * 1024, "invalid provider request size")
                    body = json.loads(self.rfile.read(length))
                    if self.path.split("?")[0].endswith("/messages/count_tokens"):
                        payload = json.dumps({"input_tokens": 100}).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                        return
                    require(self.path.split("?")[0] == "/v1/messages", f"unsupported provider route {self.path}")
                    response = provider.reply(body)
                    if body.get("stream"):
                        start = {**response, "content": [], "stop_reason": None, "usage": {"input_tokens": 100, "output_tokens": 0}}
                        events = [("message_start", {"type": "message_start", "message": start})]
                        for index, part in enumerate(response["content"]):
                            initial = {**part, "input": {}} if part["type"] == "tool_use" else {"type": "text", "text": ""}
                            delta = ({"type": "input_json_delta", "partial_json": json.dumps(part["input"])}
                                     if part["type"] == "tool_use" else {"type": "text_delta", "text": part["text"]})
                            events += [("content_block_start", {"type": "content_block_start", "index": index, "content_block": initial}),
                                       ("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}),
                                       ("content_block_stop", {"type": "content_block_stop", "index": index})]
                        events += [("message_delta", {"type": "message_delta", "delta": {"stop_reason": response["stop_reason"], "stop_sequence": None}, "usage": {"output_tokens": 20}}),
                                   ("message_stop", {"type": "message_stop"})]
                        payload = "".join(f"event: {name}\ndata: {json.dumps(value)}\n\n" for name, value in events).encode()
                        content_type = "text/event-stream"
                    else:
                        payload, content_type = json.dumps(response).encode(), "application/json"
                    self.send_response(200)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    # A deliberate pre-proof RPC->PTY restate can cancel a request.
                    pass
                except Exception as error:
                    provider.errors.append(str(error))
                    emit("provider_failure", error=str(error))
                    self.close_connection = True
                    self.send_error(500, "fixture failed; inspect smoke output")
        return Handler


# Exec, not a shell harness/receipt transport. The source PID is the actual OMP
# PID because both this observer and alinery-runner use exec replacement.
OBSERVER = '''#!{python}
import json, os, signal, sys, time
from pathlib import Path
root = Path({root!r})
sid = os.environ["ALINERY_SESSION_ID"]
state = json.loads((root / "observed-owners.json").read_text())
source = state.get("source")
prior_alive = None
if source and source["session_id"] != sid:
    try:
        os.kill(source["pid"], 0)
        prior_alive = True
    except ProcessLookupError:
        prior_alive = False
mode = "rpc" if "--mode" in sys.argv[1:] and sys.argv[sys.argv.index("--mode") + 1] == "rpc" else "pty"
preparation = {mode!r} == "pty" and mode == "rpc"
entry = {{"session_id": sid, "pid": os.getpid(), "monotonic_ns": time.monotonic_ns(),
         "mode": mode, "preparation_only": preparation, "source_alive_at_launch": prior_alive,
         "source_pid": source["pid"] if source else None}}
fd = os.open(root / "launches.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(entry) + "\\n").encode())
os.close(fd)
if preparation:
    # Public restate terminates this pre-exec child. No completion is emitted.
    while True:
        signal.pause()
os.execv({omp!r}, [{omp!r}] + sys.argv[1:])
'''


def launches(root):
    path = root / "launches.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def accepted_details(value):
    if isinstance(value, dict):
        if value.get("status") == "accepted" and value.get("receipt_id"):
            yield value["receipt_id"]
        for child in value.values():
            yield from accepted_details(child)
    elif isinstance(value, list):
        for child in value:
            yield from accepted_details(child)


def run_mode(args, mode):
    root = Path(tempfile.mkdtemp(prefix=f"av2-{mode}-", dir="/tmp")).resolve()
    repo = root / "repo"
    repo.mkdir()
    deadline = time.monotonic() + args.timeout
    provider = Provider(deadline)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), provider.handler())
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    daemon = None
    control = None
    stderr = None
    sock = repo / ".alinery/alineryd.sock"
    try:
        emit("mode_begin", mode=mode, temporary_root=str(root), provider_host="127.0.0.1")
        clean_env = {key: value for key, value in os.environ.items()
                     if key in {"PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "LOGNAME"}}
        clean_env.update(HOME=str(root / "home"), SHELL="/bin/sh", TERM="xterm-256color")
        (root / "home").mkdir()
        for command in [["git", "init", "-b", "main"], ["git", "config", "user.email", "smoke@example.invalid"],
                        ["git", "config", "user.name", "Runtime Smoke"]]:
            subprocess.run(command, cwd=repo, env=clean_env, check=True, capture_output=True, timeout=10)
        (repo / ".gitignore").write_text(".alinery/\n")
        subprocess.run(["git", "add", ".gitignore"], cwd=repo, env=clean_env, check=True, capture_output=True, timeout=10)
        subprocess.run(["git", "commit", "-m", "isolated smoke fixture"], cwd=repo, env=clean_env, check=True, capture_output=True, timeout=10)
        (repo / ".alinery").mkdir()
        (root / "observed-owners.json").write_text("{}")
        observer = root / "omp-exec-observer"
        observer.write_text(OBSERVER.format(python=str(Path(sys.executable).resolve()), root=str(root), omp=str(args.omp), mode=mode))
        observer.chmod(0o700)
        flags = ["--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-lsp", "--api-key", "fixture-not-a-secret"]
        (repo / ".alinery/harnesses.toml").write_text(
            '[[harness]]\nkey = "omp"\nname = "Real packaged OMP smoke"\n' +
            f'binary = {json.dumps(str(observer))}\nargs = {json.dumps(flags)}\n' +
            'model_arg = ["--model", "{model}"]\nprompt_injection = "arg"\nadapter = "omp"\n' +
            f'env = {{ ANTHROPIC_BASE_URL = "http://127.0.0.1:{server.server_port}", ANTHROPIC_API_KEY = "fixture-not-a-secret", NO_PROXY = "127.0.0.1,localhost" }}\n')
        app_config = root / "config/app.toml"
        app_config.parent.mkdir()
        app_config.write_text("")
        clean_env.update(ALINERY_RUNNER_PATH=str(args.runner), ALINERY_HOST_EXECUTABLE=protected_interpreter())
        server_thread.start()
        stderr = (root / "daemon.log").open("wb")
        daemon = subprocess.Popen([str(args.daemon), "--repo", str(repo), "--build-id", "v2-runtime-smoke",
                                   "--app-config", str(app_config)], env=clean_env, stdout=stderr, stderr=stderr, start_new_session=True)
        while True:
            require(time.monotonic() < deadline, "daemon readiness timeout")
            require(daemon.poll() is None, f"owned daemon exited at startup: {daemon.returncode}")
            if sock.exists():
                version = rpc(sock, {"op": "version"})
                break
            time.sleep(0.03)
        require(version.get("host_guard_ready"), "protected interpreter executable not accepted")
        emit("daemon_ready", mode=mode, protocol=version.get("protocol"), pid=daemon.pid)
        control = socket.socket(socket.AF_UNIX)
        control.settimeout(15)
        control.connect(str(sock))
        send(control, {"op": "ui_control"})
        terminal = rpc(sock, {"op": "create_execution_session", "request": {
            "task_slug": "", "target": {"kind": "auxiliary", "harness": "no-harness"}, "start": True}})
        require(not terminal.get("errors"), f"unrelated Terminal launch failed: {terminal.get('errors')}")
        terminal_id = terminal["session"]["id"]
        source = authored_source()
        library = repo / ".alinery/playbooks/runtime-smoke/playbook.md"
        library.parent.mkdir(parents=True)
        library.write_text(source)
        created = rpc(sock, {"op": "create_task", "request": {
            "name": "Runtime smoke", "requested_slug": "runtime-smoke", "description": "Only isolated real OMP work",
            "playbook": {"reference": {"scope": "repo", "key": "runtime-smoke"}, "source": library.read_text()},
            "launch_defaults": {"harness": "omp", "model": args.model}, "auto_advance_steps": ["sink"],
            "max_live_sessions": 1, "start": False}})
        require(created.get("creation") == "ready" and not created.get("errors"), f"task creation failed: {created.get('errors')}")
        slug = created["task"]["slug"]
        query = lambda: rpc(sock, {"op": "get_task_execution", "request": {"task_slug": slug}})
        initial = query()
        records = list(initial["state"]["executions"].values())
        require(len(records) == 1 and records[0]["candidate"]["step_key"] == "source", "unexpected initial production graph")
        owner = records[0]
        original_definition = initial["definition"]
        library.write_text("deliberately invalid changed library source\n")
        require(query()["definition"] == original_definition, "live task definition followed library edit")
        library.unlink()
        require(query()["definition"] == original_definition, "live task definition followed library delete")
        emit("retained_source", mode=mode, definition_identity=initial["state"]["definition_identity"], library_edit_and_delete=True)
        rpc(sock, {"op": "start_session", "request": {"task_slug": slug, "session_id": owner["owner_session_id"]}})
        prepared = set()
        restated = set()
        observed = set()
        granted = False
        completed = {}
        while time.monotonic() < deadline:
            require(daemon.poll() is None, "daemon exited during ordinary session completion")
            require(not provider.errors, f"provider failed: {provider.errors}")
            snapshot = query()
            for record in snapshot["state"]["executions"].values():
                step = record["candidate"]["step_key"]
                sid = record["owner_session_id"]
                state = record["lifecycle"]
                key = (record["id"], state, record.get("receipt_id"), record.get("shutdown_confirmed"))
                if key not in observed:
                    observed.add(key)
                    emit("execution", mode=mode, step=step, execution_id=record["id"], session_id=sid,
                         lifecycle=state, receipt_id=record.get("receipt_id"), shutdown_confirmed=record.get("shutdown_confirmed"), exit_code=record.get("exit_code"))
                require(state not in {"failed", "launch_failed", "interrupted"}, f"{step}: {state}: {record.get('error')}")
                if state == "running" and sid not in prepared:
                    if mode == "pty" and sid not in restated:
                        rpc(sock, {"op": "restate", "id": sid, "transport": "pty"})
                        restated.add(sid)
                    rows = [row for row in launches(root) if row["session_id"] == sid and row["mode"] == mode]
                    if not rows:
                        continue
                    status = rpc(sock, {"op": "status", "id": sid})
                    require(status.get("transport") == mode, f"requested {mode}, actual {status.get('transport')}")
                    row = rows[-1]
                    require(alive(row["pid"]), "actual OMP PID died before provider release")
                    if step == "source":
                        temp = root / "observed-owners.tmp"
                        temp.write_text(json.dumps({"source": {"session_id": sid, "pid": row["pid"]}}))
                        temp.replace(root / "observed-owners.json")
                    else:
                        successor_launches = [entry for entry in launches(root) if entry["session_id"] == sid]
                        require(all(entry["source_alive_at_launch"] is False for entry in successor_launches),
                                "successor launched while actual source PID still existed")
                    prepared.add(sid)
                    emit("omp_launch", step=step, **row)
                    provider.release[step].set()
                if step == "source" and provider.lock_seen.is_set() and not granted:
                    require(state == "running" and record.get("receipt_id") is None, "locked completion stopped or accepted the owner")
                    send(control, {"op": "allow_execution_completion", "request": {
                        "task_slug": slug, "execution_id": record["id"], "session_id": sid}})
                    granted = True
                    emit("human_grant", mode=mode, execution_id=record["id"], session_id=sid, peer_executable=str(Path(sys.executable).resolve()))
                    provider.granted.set()
                if state == "completed" and step not in completed:
                    require(record["shutdown_confirmed"] and record["receipt_id"], "completed without durable acceptance and shutdown")
                    require(record.get("exit_code") == 0, f"ordinary OMP exit was not zero: {record.get('exit_code')}")
                    rows = [row for row in launches(root) if row["session_id"] == sid and row["mode"] == mode]
                    require(rows and not alive(rows[-1]["pid"]), "completed before actual OMP PID disappeared")
                    history_dir = repo / ".alinery/tasks" / slug / "sessions" / (sid + ".omp")
                    receipts = set()
                    history_files = list(history_dir.glob("*.jsonl"))
                    for history in history_files:
                        for line in history.read_text().splitlines():
                            if line.strip():
                                receipts.update(accepted_details(json.loads(line)))
                    require(record["receipt_id"] in receipts, "accepted daemon receipt absent from retained real OMP tool-result history")
                    completed[step] = record
                    emit("normal_exit_and_history", mode=mode, step=step, pid=rows[-1]["pid"], receipt_id=record["receipt_id"],
                         exit_code=record["exit_code"], history_files=[str(path.relative_to(root)) for path in history_files])
            if len(completed) == 2:
                break
            time.sleep(0.025)
        require(len(completed) == 2, "ordinary shutdown timeout; finishing is not success; cleanup follows")
        require(granted, "human permission path was not exercised")
        status = rpc(sock, {"op": "status", "id": terminal_id})
        require(status.get("process", {}).get("state") not in {"exited", "stopped"}, "unrelated Terminal exited")
        # Exercise the actual unrelated shell, not just a stale metadata flag.
        marker = root / "terminal-still-live"
        rpc(sock, {"op": "write", "id": terminal_id, "data": f"printf alive > {marker}\n"})
        marker_deadline = min(deadline, time.monotonic() + 5)
        while not marker.exists() and time.monotonic() < marker_deadline:
            time.sleep(0.025)
        require(marker.exists() and marker.read_text() == "alive", "unrelated Terminal stopped accepting shell input")
        require(daemon.poll() is None, "daemon stopped with sink")
        emit("mode_pass", mode=mode, source_receipt=completed["source"]["receipt_id"], sink_receipt=completed["sink"]["receipt_id"],
             unrelated_terminal_live=True, daemon_live=True, provider_requests=provider.requests)
    except Exception:
        log = root / "daemon.log"
        if log.exists():
            emit("daemon_diagnostics", mode=mode, text=log.read_text(errors="replace")[-16000:])
        emit("launch_diagnostics", mode=mode, launches=launches(root))
        raise
    finally:
        provider.deadline = time.monotonic()
        for event in [*provider.release.values(), provider.granted]:
            event.set()
        if control is not None:
            control.close()
        if daemon is not None and daemon.poll() is None:
            # Teardown only our disposable daemon; never counts as proof of exit.
            emit("cleanup_owned_daemon", mode=mode, pid=daemon.pid)
            try:
                rpc(sock, {"op": "shutdown"})
                daemon.wait(timeout=10)
            except Exception as error:
                emit("cleanup_failure", mode=mode, error=str(error))
                daemon.terminate()
                try:
                    daemon.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait(timeout=5)
        if stderr is not None:
            stderr.close()
        if server_thread.is_alive():
            server.shutdown()
            server_thread.join(timeout=3)
        server.server_close()
        if args.keep:
            emit("retained_fixture", mode=mode, path=str(root))
        else:
            shutil.rmtree(root)


def main():
    workspace = Path(__file__).resolve().parents[1]
    binary_dir = workspace / "alinery-app/src-tauri/target/debug"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, default=binary_dir / "alineryd")
    parser.add_argument("--runner", type=Path, default=binary_dir / "alinery-runner")
    parser.add_argument("--omp", type=Path, default=Path("/Applications/Alinery.omp/omp"))
    parser.add_argument("--model", default="anthropic/claude-sonnet-4-20250514")
    parser.add_argument("--mode", choices=["pty", "rpc", "both"], default="both")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--keep", action="store_true", help="retain disposable fixture/logs for diagnosis")
    args = parser.parse_args()
    args.daemon = args.daemon.resolve()
    args.runner = args.runner.resolve()
    args.omp = args.omp.resolve()
    require(args.timeout > 0, "timeout must be positive")
    for binary in [args.daemon, args.runner, args.omp]:
        require(binary.is_file() and os.access(binary, os.X_OK), f"missing executable prerequisite: {binary}")
    require((args.runner.parent / "alinery-mcp").is_file(), "runner requires real alinery-mcp beside it")
    version = subprocess.run([str(args.omp), "--version"], check=True, capture_output=True, text=True, timeout=15).stdout.strip()
    pin = (workspace / "scripts/omp-pin.txt").read_text().strip().lstrip("v")
    require(re.search(r"(?<![\d.])" + re.escape(pin) + r"(?![\d.])", version), f"packaged OMP version {version!r} does not match repository pin {pin}")
    emit("runtime", binary=str(args.omp.resolve()), version=version, pin=pin,
         daemon=str(args.daemon.resolve()), runner=str(args.runner.resolve()), interpreter=sys.executable,
         script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    for mode in (["rpc", "pty"] if args.mode == "both" else [args.mode]):
        run_mode(args, mode)
    emit("smoke_pass", modes=["rpc", "pty"] if args.mode == "both" else [args.mode])


def interrupted(signum, _frame):
    raise SmokeFailure(f"supervisor interrupted smoke with signal {signum}")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        emit("smoke_failed", error=str(error))
        sys.exit(1)
