//! Real isolated daemon/process tests. The shell is an external harness fixture,
//! not a substitute scheduler or completion implementation.
use alinery_core::{
    daemon_client::{DaemonClient, UiControlConnection},
    execution::{read_execution_state, CompletionOutcome, ExecutionLifecycle, ExecutionRecord, TaskExecutionState},
    task_creation::*,
    RUNNER_EVENT_PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn shell_seed_capture(root: &std::path::Path) -> String {
    format!(
        r#"#!/bin/sh
pwd > '{0}/cwd-'"$ALINERY_SESSION_ID"
printf '{{"type":"ready"}}\n'
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{0}/seed-input-'"$ALINERY_SESSION_ID"
  case "$line" in *'"id":"internal-seed"'*) break;; esac
done
"#,
        root.display()
    )
}

struct Fixture {
    root: PathBuf,
    child: Child,
    client: DaemonClient,
    provider: Option<Child>,
}
impl Fixture {
    fn new() -> Self {
        Self::new_with_stock(None)
    }
    fn stock(scenario: &str) -> Self {
        Self::new_with_stock(Some(scenario))
    }
    fn new_with_stock(scenario: Option<&str>) -> Self {
        let root = PathBuf::from(format!("/tmp/al-v2-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".alinery")).unwrap();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "fixture@example.invalid"],
            vec!["config", "user.name", "Fixture"],
            vec!["commit", "--allow-empty", "-qm", "initial"],
        ] {
            assert!(alinery_core::git_cmd(&root).args(args).status().unwrap().success());
        }
        let runner = root.join("runner");
        fs::write(
            &runner,
            format!(
                "#!/bin/sh\nprintf '%s' \"$ALINERY_EVENT_TOKEN\" > '{}/token-'\"$ALINERY_SESSION_ID\"\nshift 4\nexec \"$@\"\n",
                root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();
        let harness = root.join("harness");
        fs::write(
            &harness,
            format!(
                "{}\nwhile [ ! -f '{}/release-'\"$ALINERY_SESSION_ID\" ]; do sleep 0.02; done\nprintf '{{\"type\":\"fixture_final_output\"}}\\n'\n",
                shell_seed_capture(&root),
                root.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&harness, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            root.join(".alinery/harnesses.toml"),
            format!(
                "[[harness]]\nkey='omp'\nname='Fixture'\nbinary='{}'\nargs=[]\nmodel_arg=[]\nprompt_injection='arg'\nadapter='omp'\n",
                harness.display()
            ),
        )
        .unwrap();
        let mut provider = None;
        let runner = if let Some(scenario) = scenario {
            use std::io::BufRead;
            let required = |name: &str| {
                let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} must name the actual stock acceptance prerequisite")));
                assert!(path.is_absolute() && path.is_file(), "{name} must be an absolute executable file: {}", path.display());
                assert_ne!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0, "{name} is not executable");
                path.canonicalize().unwrap()
            };
            let runner = required("ALINERY_TEST_RUNNER");
            let omp = required("OMP_BIN");
            let version = Command::new(&omp).arg("--version").output().expect("stock OMP must run");
            assert!(version.status.success(), "stock OMP --version failed");
            assert!(String::from_utf8_lossy(&version.stdout).contains("18.1.13"), "stock OMP pin changed");
            for binary in [&runner, &omp] {
                let hash = Command::new("shasum")
                    .args(["-a", "256"])
                    .arg(binary)
                    .output()
                    .expect("shasum is required for stock binary evidence");
                assert!(hash.status.success());
                eprintln!("stock binary {}", String::from_utf8_lossy(&hash.stdout).trim());
            }
            eprintln!("stock case {scenario}: {}", String::from_utf8_lossy(&version.stdout).trim());
            let control_dir = root.join("provider");
            fs::create_dir_all(&control_dir).unwrap();
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runner/tests/practical_continuation_provider.mjs");
            assert!(script.is_file(), "missing deterministic provider fixture");
            let mut child = Command::new("node")
                .arg(script)
                .args(["--port", "0", "--scenario", scenario, "--control-dir"])
                .arg(&control_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("Node provider prerequisite must start");
            let stdout = child.stdout.take().unwrap();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            thread::spawn(move || {
                let mut line = String::new();
                let result = std::io::BufReader::new(stdout).read_line(&mut line).map(|_| line);
                let _ = sender.send(result);
            });
            let banner = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("provider startup timed out")
                .expect("provider stdout");
            let banner: Value = serde_json::from_str(&banner).expect("provider must print JSON startup");
            let port = banner["port"].as_u64().expect("provider must report port");
            let (agent_dir, _) = alinery_core::omp_home_dirs(&root.join("app.toml"));
            fs::create_dir_all(&agent_dir).unwrap();
            fs::write(agent_dir.join("models.json"), serde_json::to_vec(&json!({"providers":{"continuation-local":{
                "baseUrl":format!("http://127.0.0.1:{port}/v1"),"apiKey":"loopback-only","api":"openai-completions",
                "models":[
                    {"id":"fixture","name":"Fixture","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32768,"maxTokens":2048},
                    {"id":"fixture-next","name":"Fixture next","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32768,"maxTokens":2048}
                ]
            }}})).unwrap()).unwrap();
            let harness_args = if scenario == "partial_capability" {
                let fault = root.join("partial-native-boundary.mjs");
                let trace = serde_json::to_string(&root.join("partial-boundary.trace")).unwrap();
                // Stock loader awaits every extension factory before constructing
                // AgentSession and emitting session_start. Fault the public lookup
                // in the factory, not in an order-dependent session_start handler.
                fs::write(
                    &fault,
                    format!(
                        r#"import {{ appendFileSync }} from "node:fs";
export default function (api) {{
  const prototype = api.pi?.AgentSession?.prototype;
  const original = prototype?.getToolByName;
  if (typeof original !== "function") throw new Error("Fixture requires public AgentSession.getToolByName");
  function missingWrite(name, ...args) {{
    if (name === "write") {{
      appendFileSync({trace}, "missing-write\n");
      return undefined;
    }}
    return Reflect.apply(original, this, [name, ...args]);
  }}
  prototype.getToolByName = missingWrite;
  appendFileSync({trace}, "factory-installed\n");
  api.on("session_start", () => appendFileSync({trace}, "fixture-session-start\n"));
  api.on("session_shutdown", () => {{
    if (prototype.getToolByName === missingWrite) prototype.getToolByName = original;
  }});
}}
"#
                    ),
                )
                .unwrap();
                vec!["--extension".to_string(), fault.to_string_lossy().into_owned()]
            } else if scenario == "cancellation_unwind" {
                let extension = root.join("native-write-unwind-fixture.mjs");
                let directory = serde_json::to_string(&root).unwrap();
                // This ordinary custom device is reached only through actual
                // native eval -> native write delegation. It does not replace
                // native scheduling, approval, signal or provider behavior.
                fs::write(
                    &extension,
                    format!(
                        r#"import {{ existsSync, writeFileSync }} from "node:fs";
import {{ setTimeout as delay }} from "node:timers/promises";
export default function (api) {{
  api.registerTool({{
    name: "fixture_unwind", label: "Fixture native unwind",
    description: "Isolated acceptance fixture: retain a native write callback through cancellation unwind.",
    parameters: api.zod.z.object({{}}),
    async execute(_id, _input, signal) {{
      if (!signal) throw new Error("Native write did not forward its cancellation signal");
      writeFileSync({directory} + "/native-child-entered", "entered");
      await new Promise(resolve => {{
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, {{ once: true }});
      }});
      writeFileSync({directory} + "/native-child-cancelled", "observed cancellation");
      while (!existsSync({directory} + "/native-child-release")) await delay(10);
      writeFileSync({directory} + "/native-child-settled", "actual callback settled");
      return {{ content: [{{ type: "text", text: "Native write unwind settled." }}], details: {{}} }};
    }}
  }});
}}
"#
                    ),
                )
                .unwrap();
                vec!["--extension".to_string(), extension.to_string_lossy().into_owned()]
            } else if scenario == "native_tools_and_nested_completion" {
                let extension = root.join("native-write-barrier-fixture.mjs");
                let directory = serde_json::to_string(&root).unwrap();
                fs::write(
                    &extension,
                    format!(
                        r#"import {{ existsSync, readFileSync, writeFileSync }} from "node:fs";
import {{ randomUUID }} from "node:crypto";
import {{ setTimeout as delay }} from "node:timers/promises";
export default function (api) {{
  const prototype = api.pi?.AgentSession?.prototype;
  const lookup = prototype?.getToolByName;
  if (typeof lookup !== "function") throw new Error("Fixture requires public canonical tool lookup");
  const decorated = new WeakSet();
  const sessions = new WeakMap();
  let stopped = false;
  function lookupWithBarrier(...args) {{
    if (this.sessionManager) sessions.set(this.sessionManager, this);
    const tool = Reflect.apply(lookup, this, args);
    if (args[0] === "write" && tool && !decorated.has(tool)) {{
      decorated.add(tool);
      const execute = tool.execute;
      const owningManager = this.sessionManager;
      tool.execute = function (...nativeArgs) {{
        const arm = {directory} + "/native-write-arm.json";
        if (!existsSync(arm)) return Reflect.apply(execute, this, nativeArgs);
        const target = JSON.parse(readFileSync(arm, "utf8"));
        if (target.omp_session_id !== owningManager.getSessionId() || nativeArgs[1]?.path !== target.path) {{
          return Reflect.apply(execute, this, nativeArgs);
        }}
        return (async () => {{
          writeFileSync({directory} + "/native-write-before-effects", "entered actual delegate");
          while (!existsSync({directory} + "/native-write-release-effects")) await delay(10);
          const result = await Reflect.apply(execute, this, nativeArgs);
          writeFileSync({directory} + "/native-write-after-effects", "original native effects completed");
          while (!existsSync({directory} + "/native-write-release-return")) await delay(10);
          return result;
        }})();
      }};
    }}
    return tool;
  }}
  prototype.getToolByName = lookupWithBarrier;
  api.on("session_start", (_event, context) => {{
    writeFileSync({directory} + "/native-write-owner.json", JSON.stringify({{ omp_session_id: context.sessionManager.getSessionId() }}));
    void (async () => {{
      while (!stopped && !existsSync({directory} + "/native-write-arm.json")) await delay(10);
      if (stopped) return;
      // Direct public canonical invocation; no fabricated or stale native
      // AgentToolContext, and no claim to exercise approval UI or agent batching.
      const input = JSON.parse(readFileSync({directory} + "/native-write-arm.json", "utf8"));
      if (input.omp_session_id !== context.sessionManager.getSessionId()) return;
      const session = sessions.get(context.sessionManager);
      const tool = session?.getToolByName("write");
      if (typeof tool?.execute !== "function") throw new Error("Fixture requires the captured primary canonical write");
      if (typeof session.buildAskReanswerContext !== "function") throw new Error("Fixture requires the public standalone native context factory");
      const nativeContext = session.buildAskReanswerContext(context.ui);
      await Reflect.apply(tool.execute, tool, [randomUUID(), {{ path: input.path, content: input.content }}, new AbortController().signal, undefined, nativeContext]);
      writeFileSync({directory} + "/native-write-returned", "actual invocation returned");
    }})().catch(error => writeFileSync({directory} + "/native-write-fixture-error", String(error)));
  }});
  api.on("session_shutdown", () => {{
    stopped = true;
    if (prototype.getToolByName === lookupWithBarrier) prototype.getToolByName = lookup;
  }});
}}
"#
                    ),
                )
                .unwrap();
                vec!["--extension".to_string(), extension.to_string_lossy().into_owned()]
            } else if scenario == "native_async_delivery" {
                let config = root.join("native-async-delivery.yaml");
                // Public opt-in for this subcase only. Keep the native 60s
                // threshold and normal steering-triggered background behavior.
                fs::write(&config, "eval:\n  autoBackground:\n    enabled: true\n").unwrap();
                vec!["--config".to_string(), config.to_string_lossy().into_owned()]
            } else {
                Vec::new()
            };
            fs::write(
                root.join(".alinery/harnesses.toml"),
                format!(
                    "[[harness]]\nkey='omp'\nname='Stock OMP'\nbinary={}\nargs={}\nmodel_arg=['--model','{{model}}']\nprompt_injection='arg'\nadapter='omp'\n",
                    serde_json::to_string(&omp).unwrap(),
                    serde_json::to_string(&harness_args).unwrap()
                ),
            )
            .unwrap();
            provider = Some(child);
            if scenario == "missing_or_partial_capability" {
                // Negative installation fixture: exec the same stock binary
                // without the production runner's extension installation.
                eprintln!("negative stock fixture deliberately omits extension installation");
                root.join("runner")
            } else {
                runner
            }
        } else {
            runner
        };
        let child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args(["--repo", root.to_str().unwrap(), "--app-config", root.join("app.toml").to_str().unwrap()])
            .env("ALINERY_RUNNER_PATH", &runner)
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .env("HOME", root.join("home"))
            .stdout(Stdio::null())
            .stderr(if scenario.is_some() {
                Stdio::from(fs::File::create(root.join("daemon.stderr.log")).unwrap())
            } else {
                Stdio::inherit()
            })
            .spawn()
            .unwrap();
        let client = DaemonClient {
            socket_path: root.join(".alinery/alineryd.sock"),
        };
        wait(|| client.version_checked().is_ok());
        Self { root, child, client, provider }
    }
    fn create(&self, start: bool, automatic: bool) -> CreateTaskReply {
        self.create_with(&definition(), 1, if automatic { &["first", "second", "join"] } else { &["second", "join"] }, start)
    }
    fn create_with(&self, source: &str, capacity: u32, enabled: &[&str], start: bool) -> CreateTaskReply {
        self.client.create_task(&serde_json::from_value(json!({"name":"Fixture","requested_slug":"fixture","description":"ticket","playbook":{"reference":{"scope":"bundled","key":"fixture"},"source":source},"max_live_sessions":capacity,"auto_advance_steps":enabled,"start":start})).unwrap()).unwrap()
    }
    fn create_named(&self, slug: &str) -> CreateTaskReply {
        self.client.create_task(&serde_json::from_value(json!({"name":slug,"requested_slug":slug,"description":"ticket","playbook":{"reference":{"scope":"bundled","key":"fixture"},"source":definition()},"max_live_sessions":1,"auto_advance_steps":[],"start":false})).unwrap()).unwrap()
    }
    fn stop(&mut self) {
        self.client.call(&json!({"op":"shutdown"})).unwrap();
        assert!(self.child.wait().unwrap().success());
    }
    fn spawn_lane(&mut self, lane: &str, config: &str) {
        self.client.socket_path = alinery_core::alineryd_socket_path(&self.root, Some(lane));
        self.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args([
                "--repo",
                self.root.to_str().unwrap(),
                "--app-config",
                self.root.join(config).to_str().unwrap(),
                "--socket-namespace",
                lane,
            ])
            .env("ALINERY_RUNNER_PATH", self.root.join("runner"))
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
    }
    fn state(&self) -> TaskExecutionReply {
        self.client.get_task_execution(&GetTaskExecutionRequest { task_slug: "fixture".into() }).unwrap()
    }
    fn runner_event(&self, session: &str, event: Value) -> Value {
        let token = fs::read_to_string(self.root.join(format!("token-{session}"))).unwrap();
        self.client
            .call(&json!({"op":"event","version":RUNNER_EVENT_PROTOCOL_VERSION,"session_id":session,"token":token,"event":event}))
            .unwrap()
    }
    fn bind(&self, session: &str) -> Value {
        let mut control = Value::Null;
        wait(|| {
            control = self.runner_event(session, json!({"type":"continuation_poll"}))["control"].clone();
            control.is_object()
        });
        if control["available"] != true {
            let bind = json!({
                "type":"continuation_bind","omp_session_id":"fixture",
                "groups":["primary_control","native_tools","admitted_queue","public_entries"],
                "operation_id":uuid::Uuid::new_v4().to_string(),
                "expected_capability_revision":control["capability_revision"]
            });
            wait(|| {
                control = self.runner_event(session, bind.clone())["control"].clone();
                control.is_object()
            });
        }
        // This shell fixture explicitly simulates native settlement. Only the
        // stock tests below establish actual extension/native authority.
        let mut proof = String::new();
        wait(|| {
            proof = fs::read_to_string(self.root.join(format!("seed-input-{session}")))
                .ok()
                .and_then(|text| {
                    text.lines().find_map(|line| {
                        let payload: Value = serde_json::from_str(line).ok()?;
                        if payload["id"] != "internal-seed" {
                            return None;
                        }
                        let header = payload["message"].as_str()?.strip_prefix("\u{001e}ALINERY:")?.split_once('\u{001f}')?.0;
                        serde_json::from_str::<Value>(header).ok()?["proof"].as_str().map(str::to_owned)
                    })
                })
                .unwrap_or_default();
            !proof.is_empty()
        });
        wait(|| {
            let entered = self.runner_event(session, json!({"type":"native_work_entered","process_incarnation":control["process_incarnation"],"operation_id":"fixture-seed","dispatch_id":"internal-seed","dispatch_proof":proof}));
            entered["control"].is_object()
        });
        let consumed = self.runner_event(
            session,
            json!({"type":"native_dispatch_consumed","process_incarnation":control["process_incarnation"],"dispatch_id":"internal-seed"}),
        );
        assert!(consumed["control"].is_object(), "{consumed}");
        self.runner_event(
            session,
            json!({"type":"native_work_settled","process_incarnation":control["process_incarnation"],"operation_id":"fixture-seed"}),
        )["control"]
            .clone()
    }
    fn event(&self, session: &str) -> Value {
        let state = self.persisted();
        if let Some(record) = state.executions.values().find(|record| record.owner_session_id == session && record.receipt_id.is_some()) {
            let process: Value =
                serde_json::from_slice(&fs::read(self.root.join(".alinery/tasks/fixture/sessions").join(format!("{session}.execution-process.json"))).unwrap()).unwrap();
            return self.runner_event(
                session,
                json!({"type":"readiness_reported","process_incarnation":process["incarnation"],"expected_work_revision":record.work_revision}),
            );
        }
        let control = self.bind(session);
        let ready = self.runner_event(
            session,
            json!({"type":"readiness_reported","process_incarnation":control["process_incarnation"],"expected_work_revision":control["work_revision"]}),
        );
        if ready["completion"]["status"] == "requested" {
            self.runner_event(
                session,
                json!({"type":"continuation_finalize","process_incarnation":control["process_incarnation"],"ready_revision":ready["completion"]["ready_revision"]}),
            )
        } else {
            ready
        }
    }
    fn continue_request(&self, record: &ExecutionRecord, ready_revision: u64) -> ContinueExecutionRequest {
        ContinueExecutionRequest {
            task_slug: "fixture".into(),
            execution_id: record.id.clone(),
            session_id: record.owner_session_id.clone(),
            process_incarnation: self.bind(&record.owner_session_id)["process_incarnation"].as_str().unwrap().into(),
            ready_revision,
        }
    }
    fn outputs(&self, record: &alinery_core::execution::ExecutionRecord) {
        for output in &record.outputs {
            fs::write(self.root.join(".alinery/tasks/fixture/artifacts").join(&output.relative_path), "accepted evidence").unwrap();
        }
    }
    fn assert_terminal_ready(&self, record: &ExecutionRecord) {
        let state = self.persisted();
        let current = &state.executions[&record.id];
        assert_eq!(current.lifecycle, ExecutionLifecycle::Running);
        assert_eq!(current.ready_revision, Some(current.work_revision));
        assert_eq!(
            current.ready_assessment.as_ref().unwrap().terminality,
            alinery_core::playbook_scheduler::Terminality::Terminal
        );
        assert!(current.receipt_id.is_none());
        assert!(current.continuation_requested_revision.is_none());
        assert!(!current.shutdown_confirmed);
        assert!(!state
            .occurrences
            .values()
            .any(|occurrence| occurrence.producer_execution_id.as_deref() == Some(record.id.as_str())));
    }
    fn release(&self, id: &str) {
        fs::write(self.root.join(format!("release-{id}")), "exit").unwrap();
    }
    fn persisted(&self) -> TaskExecutionState {
        read_execution_state(&self.root, "fixture").unwrap()
    }
    fn wait_state(&self, expected: &str, mut condition: impl FnMut(&TaskExecutionState) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let state = self.persisted();
            if condition(&state) {
                return;
            }
            assert!(Instant::now() < until, "{expected}; persisted state:\n{state:#?}\n{}", self.failure_diagnostics());
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn start(&self, record: &ExecutionRecord) -> CreateExecutionSessionReply {
        self.client
            .start_session(&StartSessionRequest {
                task_slug: "fixture".into(),
                session_id: record.owner_session_id.clone(),
            })
            .unwrap()
    }
    fn accept(&self, record: &ExecutionRecord) -> Value {
        self.wait_state(&format!("{} ({}) must be Running before acceptance", record.candidate.step_key, record.id), |state| {
            state.executions[&record.id].lifecycle == ExecutionLifecycle::Running
        });
        wait(|| self.root.join(format!("token-{}", record.owner_session_id)).exists());
        self.outputs(record);
        let mut outcome = self.event(&record.owner_session_id);
        if outcome["completion"]["status"] == "ready" {
            let mut ui = UiControlConnection::connect(&self.client).unwrap();
            let request = self.continue_request(record, outcome["completion"]["ready_revision"].as_u64().unwrap());
            assert!(matches!(ui.continue_execution(&request).unwrap(), CompletionOutcome::Requested { .. }));
            outcome = self.runner_event(
                &record.owner_session_id,
                json!({"type":"continuation_finalize","process_incarnation":request.process_incarnation,"ready_revision":request.ready_revision}),
            );
        }
        assert_eq!(outcome["completion"]["status"], "accepted");
        assert_eq!(self.persisted().executions[&record.id].lifecycle, ExecutionLifecycle::Finishing);
        outcome
    }
    fn finish(&self, record: &ExecutionRecord) {
        self.accept(record);
        self.release(&record.owner_session_id);
        self.wait_state(&format!("{} ({}) must complete after fixture release", record.candidate.step_key, record.id), |state| {
            state.executions[&record.id].lifecycle == ExecutionLifecycle::Completed
        });
        assert!(self.persisted().executions[&record.id].shutdown_confirmed);
    }
    fn restart_quiescent(&mut self) {
        let state = self.persisted();
        assert!(state.executions.values().all(|record| {
            (record.lifecycle == ExecutionLifecycle::Queued && !record.start_requested) || (record.lifecycle == ExecutionLifecycle::Completed && record.shutdown_confirmed)
        }));
        self.client.call(&json!({"op":"shutdown"})).unwrap();
        assert!(self.child.wait().unwrap().success());
        self.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args(["--repo", self.root.to_str().unwrap(), "--app-config", self.root.join("app.toml").to_str().unwrap()])
            .env("ALINERY_RUNNER_PATH", self.root.join("runner"))
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        wait(|| self.client.version_checked().is_ok());
    }
}

impl Fixture {
    fn failure_diagnostics(&self) -> String {
        let mut evidence = format!(
            "fixture root: {}\ncontinuation: {:?}\n",
            self.root.display(),
            self.client
                .get_task_execution(&GetTaskExecutionRequest { task_slug: "fixture".into() })
                .map(|reply| reply.continuation)
        );
        for directory in [self.root.clone(), self.root.join(".alinery/tasks/fixture/sessions")] {
            for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
                if entry.file_name().to_string_lossy().ends_with("stderr.log") {
                    let text = fs::read_to_string(entry.path()).unwrap_or_default();
                    let tail: String = text.chars().rev().take(8192).collect::<String>().chars().rev().collect();
                    evidence.push_str(&format!("stderr {}:\n", entry.path().display()));
                    for line in tail.lines() {
                        evidence.push_str(if line.contains("ALINERY:") { "<dispatch-bearing diagnostic redacted>" } else { line });
                        evidence.push('\n');
                    }
                }
            }
        }
        let mut requests: Vec<_> = fs::read_dir(self.root.join("provider"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("request-"))
            .map(|entry| entry.path())
            .collect();
        requests.sort();
        for path in requests.into_iter().rev().take(8) {
            if let Ok(Ok(request)) = fs::read(&path).map(|bytes| serde_json::from_slice::<Value>(&bytes)) {
                evidence.push_str(&format!("provider {} native tool results:\n", path.display()));
                for message in request["body"]["messages"].as_array().into_iter().flatten().filter(|message| message["role"] == "tool") {
                    let text = message["content"].to_string();
                    if !text.contains("ALINERY:") {
                        evidence.extend(text.chars().take(4096));
                        evidence.push('\n');
                    }
                }
            }
        }
        evidence
    }
    fn stock_request(&self, index: usize) -> Value {
        assert!(self.provider.is_some(), "stock driver cannot use the shell authority fixture");
        let path = self.root.join(format!("provider/request-{index}.json"));
        let until = Instant::now() + Duration::from_secs(45);
        loop {
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(request) = serde_json::from_slice(&bytes) {
                    return request;
                }
            }
            assert!(Instant::now() < until, "stock provider request {index} missing\n{}", self.failure_diagnostics());
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn stock_respond(&self, index: usize, response: Value) {
        self.stock_request(index);
        let target = self.root.join(format!("provider/response-{index}.json"));
        let temporary = target.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec(&response).unwrap()).unwrap();
        fs::rename(temporary, target).unwrap();
    }
    fn stock_tool(&self, index: usize, name: &str, args: Value) {
        let request = self.stock_request(index);
        assert!(
            request["body"]["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["function"]["name"] == name)),
            "actual stock provider request does not expose {name}: {request}"
        );
        self.stock_respond(
            index,
            json!({"tool_calls":[{"id":format!("fixture-tool-{index}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]}),
        );
    }
    fn stock_completion(&self, index: usize, nested: bool) {
        if nested {
            self.stock_tool(
                index,
                "eval",
                json!({
                    "language":"js",
                    "code":"await tool.write({ path: 'xd://alinery_phase_complete', content: '{}' });",
                    "title":"Report readiness through nested native delegation"
                }),
            );
            return;
        }
        let request = self.stock_request(index);
        if request["body"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "alinery_phase_complete")
        {
            self.stock_tool(index, "alinery_phase_complete", json!({}));
        } else {
            self.stock_tool(index, "write", json!({"path":"xd://alinery_phase_complete","content":"{}"}));
        }
    }
    fn stock_write_and_ready(&self, record: &ExecutionRecord, index: usize, contents: &str, nested: bool) -> usize {
        let path = self.root.join(".alinery/tasks/fixture/artifacts").join(&record.outputs[0].relative_path);
        self.stock_tool(index, "write", json!({"path":path,"content":contents}));
        self.stock_report_ready(record, index + 1, nested)
    }
    fn stock_report_ready(&self, record: &ExecutionRecord, index: usize, nested: bool) -> usize {
        self.stock_completion(index, nested);
        // Completion called under a live selected public/tool ancestor cannot
        // synchronously wait for that ancestor, nor publish while it may resume.
        let response = self.stock_request(index + 1);
        assert!(
            self.persisted().executions[&record.id].receipt_id.is_none(),
            "completion accepted under a resumable native ancestor: {response}"
        );
        self.stock_respond(index + 1, json!({"content":"The requested work is ready for review."}));
        self.wait_state("actual native settlement must report readiness or automatic acceptance", |state| {
            let record = &state.executions[&record.id];
            record.ready_revision.is_some() || record.receipt_id.is_some()
        });
        index + 2
    }
    fn stock_continue(&self, record: &ExecutionRecord) {
        let snapshot = self.state();
        let current = &snapshot.state.executions[&record.id];
        let capability = &snapshot.continuation[&record.id];
        assert!(capability.available, "actual stock capability missing: {:?}", capability.reason);
        let request = ContinueExecutionRequest {
            task_slug: "fixture".into(),
            execution_id: record.id.clone(),
            session_id: record.owner_session_id.clone(),
            process_incarnation: capability.process_incarnation.clone(),
            ready_revision: current.ready_revision.expect("stock readiness"),
        };
        let mut ui = UiControlConnection::connect(&self.client).unwrap();
        assert!(matches!(ui.continue_execution(&request).unwrap(), CompletionOutcome::Requested { .. }));
        self.wait_state("stock extension must finalize the exact requested generation", |state| {
            state.executions[&record.id].receipt_id.is_some()
        });
        self.wait_state("ordinary stock shutdown must reap and drain", |state| state.executions[&record.id].shutdown_confirmed);
    }
    fn stock_send(&self, record: &ExecutionRecord, id: &str, kind: &str, message: &str) {
        let result = self
            .client
            .call(&json!({"op":"rpc_write","id":record.owner_session_id,"payload":{"id":id,"type":kind,"message":message}}))
            .unwrap();
        assert_eq!(result["dispatch"]["status"], "written", "{result}");
    }
}

fn stock_definition() -> String {
    "+++\nversion=2\nkey='fixture'\ntitle='Stock continuation'\ndescription=''\ndefault_model='continuation-local/fixture'\ndefault_harness='omp'\n\
[[step]]\nkey='first'\ntitle='First'\nshort=''\ninputs=[]\noutputs=[{path='one.md'}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n\
[[step]]\nkey='next'\ntitle='Next'\nshort=''\ninputs=[{path='one.md',mode='single'}]\noutputs=[{path='next.md'}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n\
+++\n<!-- alinery:step first -->\nWrite your assigned output and report readiness.\n<!-- alinery:step next -->\nRead the assigned input, then write your assigned output and report completion.\n".into()
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_manual_revision() {
    let fixture = Fixture::stock("manual_revision");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let next_request = fixture.stock_write_and_ready(first, 1, "original evidence", false);
    let ready = fixture.persisted();
    {
        use std::io::{BufRead, Write};
        let mut stream = std::os::unix::net::UnixStream::connect(&fixture.client.socket_path).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(stream, "{}", json!({"op":"rpc_attach","id":first.owner_session_id,"attach_id":994})).unwrap();
        let mut reader = std::io::BufReader::new(stream);
        let mut pending = std::collections::BTreeSet::new();
        let mut native_auto_compaction = None;
        for payload in [
            json!({"id":"viewer-state","type":"get_state"}),
            json!({"id":"viewer-history","type":"get_messages_page","limit":20}),
            json!({"id":"viewer-commands","type":"get_available_commands"}),
            json!({"id":"viewer-subscription","type":"set_subagent_subscription","level":"events"}),
            json!({"id":"viewer-subagents","type":"get_subagents"}),
            json!({"id":"viewer-models","type":"get_available_models"}),
            json!({"id":"viewer-branches","type":"get_branch_messages"}),
            json!({"id":"viewer-last-text","type":"get_last_assistant_text"}),
        ] {
            pending.insert(payload["id"].as_str().unwrap().to_string());
            let result = fixture.client.call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":payload})).unwrap();
            assert_eq!(result["dispatch"]["status"], "written", "{result}");
        }
        while !pending.is_empty() {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0, "native viewer response stream ended");
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["type"] == "response" && event["id"].as_str().is_some_and(|id| pending.remove(id)) {
                assert_eq!(event["success"], true, "actual native viewer request failed: {event}");
                if event["id"] == "viewer-state" {
                    native_auto_compaction = event["data"]["autoCompactionEnabled"].as_bool();
                }
            }
        }
        let observed = fixture.persisted();
        assert_eq!(observed.executions[&first.id].work_revision, ready.executions[&first.id].work_revision);
        assert_eq!(observed.executions[&first.id].ready_revision, ready.executions[&first.id].ready_revision);
        assert_eq!(observed.executions[&first.id].continuation_requested_revision, None);
        // A genuinely changed preference is work, unlike merely opening the
        // viewer with a matching setting. Its exact native ACK settles intake,
        // but a later actual review/completion must establish fresh readiness.
        let result = fixture
            .client
            .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{
                "id":"viewer-explicit-compaction-change","type":"set_auto_compaction",
                "enabled":!native_auto_compaction.expect("native get_state exposes autoCompactionEnabled")
            }}))
            .unwrap();
        assert_eq!(result["dispatch"]["status"], "written");
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0, "native setter response stream ended");
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["type"] == "response" && event["id"] == "viewer-explicit-compaction-change" {
                assert_eq!(event["success"], true, "{event}");
                break;
            }
        }
        let revised = fixture.persisted();
        assert!(revised.executions[&first.id].work_revision > ready.executions[&first.id].work_revision);
        assert!(revised.executions[&first.id].ready_revision.is_none());
    }
    assert_eq!(ready.executions[&first.id].lifecycle, ExecutionLifecycle::Running);
    assert!(ready.executions[&first.id].receipt_id.is_none());
    fixture.stock_send(first, "review-exact", "prompt", "Revise the assigned artifact to revised evidence.");
    let request = fixture.stock_request(next_request);
    assert!(request["body"]["messages"].to_string().contains("Revise the assigned artifact"));
    assert!(fixture.persisted().executions[&first.id].ready_revision.is_none());
    let next_request = fixture.stock_write_and_ready(first, next_request, "revised evidence", false);
    assert!(fixture.persisted().executions[&first.id].work_revision > ready.executions[&first.id].work_revision);
    fixture.stock_continue(first);
    fixture.wait_state("one eligible successor consumes revised handoff", |state| {
        state.executions.values().any(|r| r.candidate.step_key == "next")
    });
    let state = fixture.persisted();
    let successors: Vec<_> = state.executions.values().filter(|r| r.candidate.step_key == "next").collect();
    assert_eq!(successors.len(), 1);
    let occurrence = &state.occurrences[&successors[0].candidate.inputs["one.md"][0]];
    assert_eq!(occurrence.producer_execution_id.as_deref(), Some(first.id.as_str()));
    assert_eq!(
        fs::read_to_string(fixture.root.join(".alinery/tasks/fixture/artifacts").join(&occurrence.relative_path)).unwrap(),
        "revised evidence"
    );
    fixture.stock_tool(
        next_request,
        "read",
        json!({"path":fixture.root.join(".alinery/tasks/fixture/artifacts").join(&occurrence.relative_path)}),
    );
    assert!(fixture.stock_request(next_request + 1)["body"]["messages"].to_string().contains("revised evidence"));
    fixture.stock_respond(next_request + 1, json!({"content":"I read the revised evidence."}));
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_native_tools_and_nested_completion() {
    let fixture = Fixture::stock("native_tools_and_nested_completion");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.stock_write_and_ready(first, 1, "native delegated write", true);
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    let ready = fixture.state();
    let ready_record = &ready.state.executions[&first.id];
    let old_continue = ContinueExecutionRequest {
        task_slug: "fixture".into(),
        execution_id: first.id.clone(),
        session_id: first.owner_session_id.clone(),
        process_incarnation: ready.continuation[&first.id].process_incarnation.clone(),
        ready_revision: ready_record.ready_revision.expect("genuine native readiness before standalone delegate"),
    };
    let artifact = fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path);
    let arm = fixture.root.join("native-write-arm.json");
    let pending_arm = arm.with_extension("tmp");
    let native_session_id = {
        use std::io::{BufRead, Write};
        let mut stream = std::os::unix::net::UnixStream::connect(&fixture.client.socket_path).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(stream, "{}", json!({"op":"rpc_attach","id":first.owner_session_id,"attach_id":995})).unwrap();
        let mut reader = std::io::BufReader::new(stream);
        let sent = fixture
            .client
            .call(&json!({"op":"rpc_write","id":first.owner_session_id,
            "payload":{"id":"native-owner-query","type":"get_state"}}))
            .unwrap();
        assert_eq!(sent["dispatch"]["status"], "written");
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0, "native identity response stream ended");
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["type"] == "response" && event["id"] == "native-owner-query" {
                assert_eq!(event["success"], true, "{event}");
                break event["data"]["sessionId"].as_str().expect("actual native get_state sessionId").to_string();
            }
        }
    };
    let native_owner: Value = serde_json::from_slice(&fs::read(fixture.root.join("native-write-owner.json")).unwrap()).unwrap();
    assert_eq!(
        native_owner["omp_session_id"], native_session_id,
        "fixture callback must belong to the observed actual primary session"
    );
    fs::write(
        &pending_arm,
        serde_json::to_vec(&json!({
            "omp_session_id":native_session_id,"path":artifact,"content":"Standalone native delegate revision"
        }))
        .unwrap(),
    )
    .unwrap();
    fs::rename(pending_arm, arm).unwrap();
    let fixture_error = fixture.root.join("native-write-fixture-error");
    fixture.wait_state("standalone actual native delegate must reach its pre-effect barrier", |_| {
        assert!(!fixture_error.exists(), "{}", fs::read_to_string(&fixture_error).unwrap_or_default());
        fixture.root.join("native-write-before-effects").exists()
    });
    let entered = fixture.persisted();
    assert!(
        entered.executions[&first.id].work_revision > old_continue.ready_revision,
        "native delegate admission itself must advance generation without a daemon review"
    );
    assert!(entered.executions[&first.id].ready_revision.is_none());
    assert!(entered.executions[&first.id].receipt_id.is_none());
    assert_eq!(fs::read_to_string(&artifact).unwrap(), "native delegated write", "native file effects must still be held");
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    assert!(matches!(ui.continue_execution(&old_continue).unwrap(), CompletionOutcome::Stale { .. }));
    fs::write(fixture.root.join("native-write-release-effects"), "").unwrap();
    fixture.wait_state("original native write must execute before the return barrier", |_| {
        assert!(!fixture_error.exists(), "{}", fs::read_to_string(&fixture_error).unwrap_or_default());
        fixture.root.join("native-write-after-effects").exists()
    });
    assert_eq!(fs::read_to_string(&artifact).unwrap(), "Standalone native delegate revision");
    assert!(!fixture.root.join("native-write-returned").exists());
    assert!(fixture.persisted().executions[&first.id].ready_revision.is_none());
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fs::write(fixture.root.join("native-write-release-return"), "").unwrap();
    fixture.wait_state("actual selected delegate invocation must return", |_| {
        assert!(!fixture_error.exists(), "{}", fs::read_to_string(&fixture_error).unwrap_or_default());
        fixture.root.join("native-write-returned").exists()
    });
    fixture.wait_state("settled native work renews readiness without another completion call", |state| {
        let record = &state.executions[&first.id];
        record.ready_revision == Some(record.work_revision) && record.work_revision > old_continue.ready_revision
    });
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fixture.stock_send(
        first,
        "after-standalone-native-write",
        "prompt",
        "Review the native delegate revision and report readiness.",
    );
    fixture.stock_report_ready(first, 4, false);
    fixture.stock_continue(first);
    drop(fixture);

    // Exercise a real selected eval job through native auto-backgrounding and
    // its later delivery turn, not just the producer promise or enqueue ACK.
    let fixture = Fixture::stock("native_async_delivery");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    use std::io::{BufRead, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(&fixture.client.socket_path).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(45))).unwrap();
    writeln!(stream, "{}", json!({"op":"rpc_attach","id":first.owner_session_id,"attach_id":993})).unwrap();
    let mut reader = std::io::BufReader::new(stream);
    let mut native_event = |accept: &dyn Fn(&Value) -> bool| -> Value {
        loop {
            let mut line = String::new();
            let bytes = reader
                .read_line(&mut line)
                .unwrap_or_else(|error| panic!("native event deadline: {error}\n{}", fixture.failure_diagnostics()));
            assert_ne!(bytes, 0, "native RPC stream ended\n{}", fixture.failure_diagnostics());
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if accept(&event) {
                    return event;
                }
            }
        }
    };
    let artifact = fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path);
    fixture.stock_tool(1, "write", json!({"path":artifact,"content":"Before actual async delivery."}));
    let entered = fixture.root.join("selected-job-entered");
    let release = fixture.root.join("selected-job-release");
    let produced = fixture.root.join("selected-job-produced");
    let code =
        format!(
        "await Bun.write({}, 'entered'); while (!(await Bun.file({}).exists())) await Bun.sleep(10); await Bun.write({}, 'produced'); display('selected-native-delivery-ready');",
        serde_json::to_string(&entered).unwrap(), serde_json::to_string(&release).unwrap(), serde_json::to_string(&produced).unwrap()
    );
    fixture.stock_tool(2, "eval", json!({"language":"js","code":code,"timeout":0,"title":"Known selected native delivery"}));
    fixture.wait_state("actual native eval must enter before requesting native auto-backgrounding", |_| entered.exists());
    // Native foreground-wait explicitly backgrounds on queued steering. This
    // retains its normal scheduler and default threshold, without a test flag.
    fixture.stock_send(first, "background-steer", "steer", "Report readiness while the selected job remains pending.");
    let background = native_event(&|event| event["type"] == "tool_execution_end" && event["toolCallId"] == "fixture-tool-2");
    assert_eq!(
        background["result"]["details"]["async"]["state"], "running",
        "native eval must actually return a background handle"
    );
    assert_eq!(background["result"]["details"]["async"]["type"], "eval");
    let job_id = background["result"]["details"]["async"]["jobId"]
        .as_str()
        .expect("actual native selected job identity")
        .to_string();
    fixture.stock_completion(3, false);
    let waiting = fixture.stock_request(4);
    assert!(
        waiting["body"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| { message["role"] == "tool" && message["content"].to_string().to_lowercase().contains("waiting") }),
        "completion must not accept or report ready while the selected producer is held"
    );
    fixture.stock_respond(4, json!({"content":"Waiting for the actual selected job result."}));
    // Observe this actual model reply and its native turn boundary. This is
    // not session_stop, aggregate Idle, or proof the outer prompt/job settled.
    let origin_reply = |message: &Value| message["role"] == "assistant" && message["responseId"] == "loopback-4" && message["stopReason"] == "stop";
    native_event(&|event| event["type"] == "message_end" && origin_reply(&event["message"]));
    native_event(&|event| event["type"] == "turn_end" && origin_reply(&event["message"]));
    native_event(&|event| event["type"] == "agent_end" && event["messages"].as_array().is_some_and(|messages| messages.iter().any(origin_reply)));
    assert!(!produced.exists());
    assert!(fixture.persisted().executions[&first.id].last_ready_revision.is_none());
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fs::write(&release, "release actual native producer").unwrap();
    let delivery = native_event(&|event| {
        event["type"] == "message_start"
            && event["message"]["customType"] == "async-result"
            && event["message"]["details"]["jobs"]
                .as_array()
                .is_some_and(|jobs| jobs.iter().any(|job| job["jobId"] == job_id))
    });
    assert!(delivery["message"]["details"]["jobs"].as_array().unwrap().iter().any(|job| job["jobId"] == job_id));
    let continuation = fixture.stock_request(5);
    assert!(
        continuation["body"]["messages"].to_string().contains("selected-native-delivery-ready"),
        "the actual delivery model turn must receive the produced result"
    );
    let held = fixture.persisted();
    assert!(held.executions[&first.id].ready_revision.is_none());
    assert!(
        held.executions[&first.id].last_ready_revision.is_none(),
        "producer settlement/enqueue must never briefly publish readiness before delivery settles"
    );
    assert!(held.executions[&first.id].receipt_id.is_none());
    fixture.stock_write_and_ready(first, 5, "Revised by the actual async-result continuation.", false);
    assert_eq!(fs::read_to_string(artifact).unwrap(), "Revised by the actual async-result continuation.");
    fixture.stock_continue(first);
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_automatic_and_terminal() {
    for (terminal, auto_approve_all) in [(false, false), (true, false), (true, true)] {
        let fixture = Fixture::stock("automatic_and_terminal");
        let source = if terminal {
            format!(
                "{}+++\n<!-- alinery:step first -->\nWrite your output.\n",
                stock_definition().split("[[step]]\nkey='next'").next().unwrap()
            )
        } else {
            stock_definition()
        };
        let created = fixture.create_with(&source, 1, if auto_approve_all { &[] } else { &["first"] }, true);
        if auto_approve_all {
            alinery_core::with_task_mutation_lock_waiting(&fixture.root, "fixture auto approval", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
                let mut state = fixture.persisted();
                alinery_core::execution::set_execution_auto_approve_all(&mut state, true);
                alinery_core::execution::write_execution_state_unlocked(&fixture.root, "fixture", &mut state)
            })
            .unwrap();
        }
        let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
        let index = fixture.stock_write_and_ready(first, 1, "automatic native handoff", false);
        if terminal {
            fixture.assert_terminal_ready(first);
            let revision = fixture.persisted().executions[&first.id].work_revision;
            fixture.stock_send(first, "terminal-followup", "prompt", "Revise the final output with the requested follow-up.");
            fixture.stock_write_and_ready(first, index, "revised terminal output", false);
            fixture.assert_terminal_ready(first);
            assert!(fixture.persisted().executions[&first.id].work_revision > revision);
            assert_eq!(
                fs::read_to_string(fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path)).unwrap(),
                "revised terminal output"
            );
            continue;
        }
        fixture.wait_state("nonterminal automatic work accepts without a desktop gesture", |state| {
            state.executions[&first.id].receipt_id.is_some()
        });
        fixture.wait_state("automatic acceptance still requires successful exit and drain", |state| {
            state.executions[&first.id].shutdown_confirmed
        });
    }
}

#[test]
fn held_dispatch_flush_does_not_hold_registry_and_makes_old_continue_stale() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("harness"), format!(
        "{1}\nwhile [ ! -f '{0}/drain-'\"$ALINERY_SESSION_ID\" ]; do sleep 0.01; done\nwhile IFS= read -r line; do printf '%s\\n' \"$line\" >> '{0}/read-'\"$ALINERY_SESSION_ID\"; done\n",
        fixture.root.display(), shell_seed_capture(&fixture.root)
    )).unwrap();
    let source = definition().replace("is_coding_step=true", "is_coding_step=false");
    let created = fixture.create_with(&source, 2, &[], false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    fixture.start(first);
    fixture.start(second);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let ready = fixture.event(&first.owner_session_id);
    let request = fixture.continue_request(first, ready["completion"]["ready_revision"].as_u64().unwrap());
    let (sent, received) = std::sync::mpsc::sync_channel(1);
    let socket = fixture.client.socket_path.clone();
    let session_id = first.owner_session_id.clone();
    let writer = thread::spawn(move || {
        let client = DaemonClient { socket_path: socket };
        sent.send(client.call(&json!({"op":"rpc_write","id":session_id,"payload":{"id":"held-review","type":"prompt","message":"x".repeat(1024 * 1024)}})))
            .unwrap();
    });
    fixture.wait_state("durable invalidation must precede a blocked kernel write", |state| {
        state.executions[&first.id].work_revision > request.ready_revision
    });
    assert!(
        matches!(received.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)),
        "the real child pipe must still be held"
    );
    let (continued, continuation) = std::sync::mpsc::sync_channel(1);
    let socket = fixture.client.socket_path.clone();
    let continue_thread = thread::spawn(move || {
        let client = DaemonClient { socket_path: socket };
        let mut ui = UiControlConnection::connect(&client).unwrap();
        continued.send(ui.continue_execution(&request)).unwrap();
    });
    let other = fixture.client.call(&json!({"op":"status","id":second.owner_session_id})).unwrap();
    assert_eq!(other["process"]["state"], "alive");
    let other_write = fixture
        .client
        .call(&json!({"op":"rpc_write","id":second.owner_session_id,"payload":{"id":"unrelated-observation","type":"get_state"}}))
        .unwrap();
    assert_eq!(other_write["dispatch"]["status"], "written");
    assert!(matches!(continuation.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
    fs::write(fixture.root.join(format!("drain-{}", first.owner_session_id)), "").unwrap();
    assert_eq!(received.recv_timeout(Duration::from_secs(10)).unwrap().unwrap()["dispatch"]["status"], "written");
    assert!(matches!(
        continuation.recv_timeout(Duration::from_secs(10)).unwrap().unwrap(),
        CompletionOutcome::Stale { .. }
    ));
    writer.join().unwrap();
    continue_thread.join().unwrap();
    let captured = fixture.root.join(format!("read-{}", first.owner_session_id));
    wait(|| fs::read_to_string(&captured).is_ok_and(|text| text.lines().any(|line| serde_json::from_str::<Value>(line).is_ok_and(|value| value["id"] == "held-review"))));
    let before = fs::read(&captured).unwrap();
    let duplicate = fixture
        .client
        .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{"id":"held-review","type":"prompt","message":"do not send twice"}}))
        .unwrap();
    assert_eq!(duplicate["dispatch"]["status"], "written");
    assert_eq!(fs::read(captured).unwrap(), before, "dispatch retry must not resend an already-written frame");
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_missing_or_partial_capability() {
    let fixture = Fixture::stock("missing_or_partial_capability");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    {
        use std::io::{BufRead, Write};
        let mut stream = std::os::unix::net::UnixStream::connect(&fixture.client.socket_path).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        writeln!(stream, "{}", json!({"op":"rpc_attach","id":first.owner_session_id,"attach_id":991})).unwrap();
        let mut reader = std::io::BufReader::new(stream);
        loop {
            let mut line = String::new();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0, "stock RPC readiness stream ended");
            if serde_json::from_str::<Value>(&line).is_ok_and(|value| value["type"] == "ready") {
                break;
            }
        }
    }
    assert!(
        !fixture.root.join("provider/request-1.json").exists(),
        "protected seed must wait for authenticated installation"
    );
    let snapshot = fixture.state();
    let capability = &snapshot.continuation[&first.id];
    assert!(!capability.available, "stock Idle without the extension must not grant authority");
    assert!(snapshot.state.executions[&first.id].receipt_id.is_none());
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let outcome = ui
        .continue_execution(&ContinueExecutionRequest {
            task_slug: "fixture".into(),
            execution_id: first.id.clone(),
            session_id: first.owner_session_id.clone(),
            process_incarnation: capability.process_incarnation.clone(),
            ready_revision: 0,
        })
        .unwrap();
    assert!(matches!(outcome, CompletionOutcome::Unavailable { .. }));
    let installed = Fixture::stock("manual_revision");
    let created = installed.create_with(&stock_definition(), 1, &[], true);
    let owner = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    installed.stock_request(1);
    assert!(
        installed.state().continuation[&owner.id].available,
        "production installation must independently establish all four groups"
    );
    installed.stock_respond(1, json!({"content":"Installed."}));

    let partial = Fixture::stock("partial_capability");
    let created = partial.create_with(&stock_definition(), 1, &[], true);
    let owner = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    partial.wait_state("the shipped adapter must report the actual missing native delegation boundary", |_| {
        partial
            .client
            .call(&json!({"op":"status","id":owner.owner_session_id}))
            .is_ok_and(|status| status["playbook"]["reason"].as_str().is_some_and(|reason| reason.contains("Native same-tool delegation")))
    });
    partial.wait_state("all actual session_start callbacks must run before inspecting the factory-order trace", |_| {
        fs::read_to_string(partial.root.join("partial-boundary.trace")).is_ok_and(|trace| trace.lines().any(|line| line == "fixture-session-start"))
    });
    let trace = fs::read_to_string(partial.root.join("partial-boundary.trace")).unwrap();
    assert_eq!(trace.lines().next(), Some("factory-installed"));
    assert!(trace.lines().any(|line| line == "missing-write"));
    assert!(trace.lines().any(|line| line == "fixture-session-start"));
    let snapshot = partial.state();
    assert!(
        !snapshot.continuation[&owner.id].available,
        "partial real installation must not advertise the full capability set"
    );
    assert!(snapshot.continuation[&owner.id].reason.is_some());
    assert!(!partial.root.join("provider/request-1.json").exists(), "failed binding cannot release the protected seed");
    // An ordinary review remains possible; invoke the shipped completion tool
    // through the actual provider and native tool runner, never a forged event.
    partial.stock_send(owner, "partial-ready-attempt", "prompt", "Report whether this execution can become ready.");
    partial.stock_tool(1, "write", json!({"path":"xd://alinery_phase_complete","content":"{}"}));
    let native_result = partial.stock_request(2);
    assert!(
        native_result["body"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| { message["role"] == "tool" && message["content"].to_string().contains("Native same-tool delegation") }),
        "the actual completion tool must expose the missing selected boundary"
    );
    partial.stock_respond(2, json!({"content":"Protected continuation is unavailable."}));
    let state = partial.persisted();
    assert!(state.executions[&owner.id].ready_revision.is_none());
    assert!(state.executions[&owner.id].continuation_requested_revision.is_none());
    assert!(state.executions[&owner.id].receipt_id.is_none());
    let mut ui = UiControlConnection::connect(&partial.client).unwrap();
    assert!(matches!(
        ui.continue_execution(&ContinueExecutionRequest {
            task_slug: "fixture".into(),
            execution_id: owner.id.clone(),
            session_id: owner.owner_session_id.clone(),
            process_incarnation: snapshot.continuation[&owner.id].process_incarnation.clone(),
            ready_revision: state.executions[&owner.id].work_revision,
        })
        .unwrap(),
        CompletionOutcome::Unavailable { .. }
    ));
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_queue_and_send_now() {
    let fixture = Fixture::stock("queue_and_send_now");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.stock_write_and_ready(first, 1, "before queued revision", false);
    fixture.stock_send(first, "active-review", "prompt", "Hold this active review.");
    fixture.stock_request(4);
    fixture.stock_send(first, "earlier-useful", "follow_up", "Earlier useful queued review.");
    fixture.stock_send(first, "selected-queue", "follow_up", "Selected queued review.");
    let response = fixture
        .client
        .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{
            "id":"send-now","type":"abort_and_prompt","message":"Selected queued review.","transfer_dispatch_id":"selected-queue"
        }}))
        .unwrap();
    assert_eq!(response["dispatch"]["status"], "written");
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    let replacement = fixture.stock_request(5);
    assert!(replacement["body"]["messages"].to_string().contains("Selected queued review."));
    fixture.stock_respond(5, json!({"content":"Selected review handled."}));
    let earlier = fixture.stock_request(6);
    assert!(
        earlier["body"]["messages"].to_string().contains("Earlier useful queued review."),
        "Send now discarded earlier useful work"
    );
    fixture.stock_write_and_ready(first, 6, "both queued reviews handled", false);
    fixture.stock_continue(first);
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_cancellation_unwind() {
    let fixture = Fixture::stock("cancellation_unwind");
    let created = fixture.create_with(&stock_definition(), 1, &[], true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let entered = fixture.root.join("native-child-entered");
    let release = fixture.root.join("native-child-release");
    let settled = fixture.root.join("native-child-settled");
    let output = fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path);
    fixture.stock_tool(1, "write", json!({"path":output,"content":"Actual native publication before cancellation."}));
    fixture.stock_tool(
        2,
        "eval",
        json!({"language":"js","code":"await tool.write({ path: 'xd://fixture_unwind', content: '{}' });","timeout":60,"title":"Hold native write cancellation unwind"}),
    );
    fixture.wait_state("native eval must enter the actual native write callback", |_| entered.exists());
    let aborted = fixture
        .client
        .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{"id":"cancel-native","type":"abort"}}))
        .unwrap();
    assert_eq!(aborted["dispatch"]["status"], "written");
    fixture.wait_state("native write must observe the actual abort signal while its callback remains entered", |_| {
        fixture.root.join("native-child-cancelled").exists()
    });
    assert!(!settled.exists());
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fixture.stock_send(first, "after-cancel", "prompt", "Report completion only after the entered child actually settles.");
    fixture.stock_completion(3, false);
    let waiting = fixture.stock_request(4);
    assert!(
        waiting["body"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| { message["role"] == "tool" && message["content"].to_string().to_lowercase().contains("waiting") }),
        "completion under actual cancellation unwind must remain Waiting"
    );
    assert!(!settled.exists());
    assert!(fixture.persisted().executions[&first.id].ready_revision.is_none());
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fixture.stock_respond(4, json!({"content":"Waiting for the entered native write callback to settle."}));
    fs::write(&release, "release actual child").unwrap();
    fixture.wait_state("native callback must actually resolve after its explicit release", |_| settled.exists());
    fixture.wait_state("readiness can follow only actual native callback settlement", |state| {
        state.executions[&first.id].ready_revision.is_some()
    });
    fixture.stock_continue(first);
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_nonchat_and_pty() {
    let fixture = Fixture::stock("nonchat_and_pty");
    let created = fixture.create_with(&stock_definition(), 1, &[], false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let skill_dir = PathBuf::from(&created.task.as_ref().unwrap().worktree).join(".omp/skills/continuation-fixture");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: continuation-fixture\ndescription: Isolated continuation acceptance skill\n---\nPerform the skill review of the assigned output.\n",
    )
    .unwrap();
    fixture.start(first);
    fixture.stock_write_and_ready(first, 1, "initial native review", false);
    for payload in [
        json!({"id":"stock-model-change","type":"set_model","provider":"continuation-local","modelId":"fixture-next"}),
        json!({"id":"stock-thinking-change","type":"set_thinking_level","level":"off"}),
    ] {
        let response = fixture.client.call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":payload})).unwrap();
        assert_eq!(response["dispatch"]["status"], "written", "{response}");
    }
    fixture.stock_send(first, "actual-skill", "prompt", "/skill:continuation-fixture revise the assigned output");
    let skill = fixture.stock_request(4);
    assert_eq!(skill["body"]["model"], "fixture-next", "the actual native provider request must use the changed model");
    assert!(skill["body"]["messages"].to_string().contains("skill review"), "stock skill route was not actually entered");
    fixture.stock_write_and_ready(first, 4, "skill revision", false);
    let old = fixture.state();
    let old_request = ContinueExecutionRequest {
        task_slug: "fixture".into(),
        execution_id: first.id.clone(),
        session_id: first.owner_session_id.clone(),
        process_incarnation: old.continuation[&first.id].process_incarnation.clone(),
        ready_revision: old.state.executions[&first.id].ready_revision.unwrap(),
    };
    fixture.client.call(&json!({"op":"restate","id":first.owner_session_id,"transport":"pty"})).unwrap();
    // Restate ACK proves spawn, not input initialization. This is a startup
    // barrier only; native Idle is never used as submitted-work settlement.
    fixture.wait_state("replacement PTY must authenticate its new binding and finish native startup", |_| {
        let snapshot = fixture.state();
        let bound = snapshot
            .continuation
            .get(&first.id)
            .is_some_and(|capability| capability.available && capability.process_incarnation != old_request.process_incarnation);
        bound
            && fixture
                .client
                .call(&json!({"op":"status","id":first.owner_session_id}))
                .is_ok_and(|status| status["transport"] == "pty" && status["process"]["state"] == "alive" && status["agent"]["state"] == "idle")
    });
    let raw = fixture
        .client
        .call(&json!({"op":"write","id":first.owner_session_id,"dispatch_id":"raw-review","data":"Revise the output using this PTY review."}))
        .unwrap();
    assert_eq!(raw["dispatch"]["status"], "written");
    let scrollback = alinery_core::session_scrollback_path(&fixture.root, "fixture", &first.owner_session_id);
    fixture.wait_state("actual native editor must display the raw text before submitting a distinct Enter", |_| {
        fs::read_to_string(&scrollback).is_ok_and(|text| text.contains("Revise the output using this PTY review."))
    });
    let submit = fixture
        .client
        .call(&json!({"op":"write","id":first.owner_session_id,"dispatch_id":"raw-submit","data":"\r"}))
        .unwrap();
    assert_eq!(submit["dispatch"]["status"], "written");
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    assert!(matches!(ui.continue_execution(&old_request).unwrap(), CompletionOutcome::Stale { .. }));
    let mut request_index = 7;
    let mut title_seen = false;
    let primary_request = |index: &mut usize, title_seen: &mut bool| {
        loop {
            let request = fixture.stock_request(*index);
            if request["body"]["tools"].as_array().is_some() {
                return request;
            }
            // Native TUI title generation is real normal behavior, not part of
            // the primary tool turn. Answer its observed protocol without
            // disabling the feature or treating arbitrary requests as titles.
            assert!(!*title_seen, "unexpected additional tool-less provider request: {request}");
            let messages = request["body"]["messages"].as_array().expect("native title messages");
            assert!(
                messages
                    .iter()
                    .any(|message| message["role"] == "system" && message["content"].to_string().contains("<title>")),
                "unexpected tool-less native request: {request}"
            );
            assert!(
                messages
                    .iter()
                    .any(|message| message["role"] == "user" && message["content"].to_string().contains("Revise the output using this PTY review.")),
                "title request must name this actual PTY input"
            );
            fixture.stock_respond(*index, json!({"content":"<title>Review assigned PTY output</title>"}));
            *title_seen = true;
            *index += 1;
        }
    };
    let primary = primary_request(&mut request_index, &mut title_seen);
    assert!(primary["body"]["messages"].to_string().contains("Revise the output using this PTY review."));
    fixture.stock_tool(
        request_index,
        "write",
        json!({
            "path":fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path),
            "content":"PTY revised evidence"
        }),
    );
    request_index += 1;
    primary_request(&mut request_index, &mut title_seen);
    fixture.stock_completion(request_index, false);
    request_index += 1;
    primary_request(&mut request_index, &mut title_seen);
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
    fixture.stock_respond(request_index, json!({"content":"The PTY revision is ready for review."}));
    let snapshot = fixture.state();
    assert!(
        snapshot.state.executions[&first.id].ready_revision.is_none(),
        "raw PTY intake must not manufacture native settlement"
    );
    let blocked = ui
        .continue_execution(&ContinueExecutionRequest {
            task_slug: "fixture".into(),
            execution_id: first.id.clone(),
            session_id: first.owner_session_id.clone(),
            process_incarnation: snapshot.continuation[&first.id].process_incarnation.clone(),
            ready_revision: snapshot.state.executions[&first.id].work_revision,
        })
        .unwrap();
    assert!(!matches!(blocked, CompletionOutcome::Accepted { .. } | CompletionOutcome::Requested { .. }));
    let request = prepare_human_end(&fixture, first);
    let ended = human_control(&fixture, "end_execution", request);
    assert_eq!(ended["completion"]["status"], "accepted", "{ended}");
    let stopped = fixture.persisted();
    assert!(stopped.executions[&first.id].shutdown_confirmed);
    assert_eq!(stopped.executions[&first.id].lifecycle, ExecutionLifecycle::Completed);
    assert_eq!(
        fs::read_to_string(fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path)).unwrap(),
        "PTY revised evidence"
    );
}

#[test]
#[ignore = "requires OMP_BIN stock v18.1.13 and ALINERY_TEST_RUNNER compiled production runner"]
fn stock_continuation_graph_release_and_failure() {
    let fixture = Fixture::stock("graph_release_and_failure");
    let source = definition()
        .replace("default_model=''", "default_model='continuation-local/fixture'")
        .replace("is_coding_step=true", "is_coding_step=false");
    let created = fixture.create_with(&source, 1, &[], false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    fixture.start(first);
    fixture.stock_write_and_ready(first, 1, "first native join input", false);
    fixture.stock_continue(first);
    assert!(!fixture.persisted().executions.values().any(|r| r.candidate.step_key == "join"));
    assert_eq!(fixture.persisted().executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    fixture.start(second);
    fixture.stock_write_and_ready(second, 4, "second native join input", false);
    // Fail only the future child launch. Accepted producer receipts remain
    // immutable and no automatic retry is allowed to manufacture success.
    fs::write(
        fixture.root.join(".alinery/harnesses.toml"),
        "[[harness]]\nkey='omp'\nname='Missing'\nbinary='/missing/stock-successor'\nargs=[]\nmodel_arg=[]\nprompt_injection='arg'\nadapter='omp'\n",
    )
    .unwrap();
    fixture.stock_continue(second);
    fixture.wait_state("failed native successor remains explicit", |state| {
        state
            .executions
            .values()
            .any(|r| r.candidate.step_key == "join" && r.lifecycle == ExecutionLifecycle::LaunchFailed)
    });
    let before = fixture.persisted();
    assert!(before.executions[&first.id].receipt_id.is_some() && before.executions[&second.id].receipt_id.is_some());
    assert_eq!(before.executions.values().filter(|r| r.candidate.step_key == "join").count(), 1);
    assert_ne!(serde_json::to_value(fixture.state().assessment).unwrap()["status"], "complete");

    let fanout = Fixture::stock("graph_release_and_failure");
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Fanout'\ndescription=''\ndefault_model='continuation-local/fixture'\ndefault_harness='omp'\n".to_string();
    for (key, inputs, outputs) in [
        ("seed", "[]", "[{path='request-*.md'},{path='summary.md'}]"),
        ("worker", "[{path='request-*.md',mode='each'}]", "[{path='result-*.md'}]"),
        ("review", "[{path='summary.md',mode='single'}]", "[{path='review.md'}]"),
        ("collect", "[{path='result-*.md',mode='complete'},{path='review.md',mode='single'}]", "[{path='answer.md'}]"),
    ] {
        source.push_str(&format!(
            "[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs={outputs}\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n"
        ));
    }
    source.push_str("+++\n");
    for key in ["seed", "worker", "review", "collect"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nWrite assigned outputs.\n"));
    }
    let created = fanout.create_with(&source, 1, &[], true);
    let seed = created.executions.iter().find(|r| r.candidate.step_key == "seed").unwrap();
    let artifacts = fanout.root.join(".alinery/tasks/fixture/artifacts");
    let family = seed.outputs.iter().find(|o| o.selector == "request-*.md").unwrap();
    let summary = seed.outputs.iter().find(|o| o.selector == "summary.md").unwrap();
    fanout.stock_tool(1, "write", json!({"path":artifacts.join(family.relative_path.replace('*',"alpha")),"content":"2"}));
    fanout.stock_tool(2, "write", json!({"path":artifacts.join(family.relative_path.replace('*',"beta")),"content":"3"}));
    fanout.stock_tool(3, "write", json!({"path":artifacts.join(&summary.relative_path),"content":"Review both members."}));
    let mut index = fanout.stock_report_ready(seed, 4, false);
    let assessment = serde_json::to_value(&fanout.state().executions[&seed.id]).unwrap();
    let destinations = assessment["destinations"].as_array().unwrap();
    assert_eq!(destinations.len(), 2, "fanout members must not duplicate destination types");
    assert!(destinations.iter().any(|d| d["step_key"] == "worker") && destinations.iter().any(|d| d["step_key"] == "review"));
    fanout.stock_continue(seed);
    let mut completed = std::collections::BTreeSet::new();
    for _ in 0..4 {
        fanout.wait_state("capacity must launch exactly one next native owner", |state| {
            state.executions.values().any(|r| r.lifecycle == ExecutionLifecycle::Running && !completed.contains(&r.id))
        });
        let state = fanout.persisted();
        assert_eq!(state.executions.values().filter(|r| r.lifecycle.holds_capacity()).count(), 1);
        let record = state
            .executions
            .values()
            .find(|r| r.lifecycle == ExecutionLifecycle::Running && !completed.contains(&r.id))
            .unwrap()
            .clone();
        if record.candidate.step_key == "worker" {
            let source = &state.occurrences[&record.candidate.inputs["request-*.md"][0]];
            assert_eq!(source.producer_execution_id.as_deref(), Some(seed.id.as_str()));
        }
        if record.candidate.step_key == "collect" {
            assert_eq!(record.candidate.inputs["result-*.md"].len(), 2);
            let producers: std::collections::BTreeSet<_> = record.candidate.inputs["result-*.md"]
                .iter()
                .map(|id| state.occurrences[id].producer_execution_id.clone())
                .collect();
            assert_eq!(producers.len(), 2, "complete collection must retain both actual worker producers");
        }
        fanout.stock_tool(
            index,
            "write",
            json!({"path":artifacts.join(record.outputs[0].relative_path.replace('*',"answer")),"content":format!("native {}",record.candidate.step_key)}),
        );
        index = fanout.stock_report_ready(&record, index + 1, false);
        if record.candidate.step_key == "collect" {
            fanout.assert_terminal_ready(&record);
            break;
        }
        fanout.stock_continue(&record);
        fanout.wait_state("native graph child must exit and drain", |state| state.executions[&record.id].shutdown_confirmed);
        completed.insert(record.id);
    }

    let looping = Fixture::stock("graph_release_and_failure");
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Loop'\ndescription=''\ndefault_model='continuation-local/fixture'\ndefault_harness='omp'\n".to_string();
    for (key, inputs, outputs) in [
        ("seed", "[]", "[{path='plan.md'}]"),
        ("loop", "[{path='plan.md',mode='single'}]", "[{path='plan.md'},{path='report.md'}]"),
    ] {
        source.push_str(&format!(
            "[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs={outputs}\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n"
        ));
    }
    source.push_str("+++\n<!-- alinery:step seed -->\nWrite the starting plan.\n<!-- alinery:step loop -->\nContinue with a fresh plan or stop by publishing only the report.\n");
    let created = looping.create_with(&source, 1, &[], true);
    let seed = created.executions.iter().find(|r| r.candidate.step_key == "seed").unwrap();
    let mut index = looping.stock_write_and_ready(seed, 1, "initial plan", false);
    looping.stock_continue(seed);
    let mut previous_producer = seed.id.clone();
    for continue_loop in [true, false] {
        looping.wait_state("fresh loop binding must launch", |state| {
            state
                .executions
                .values()
                .any(|r| r.candidate.step_key == "loop" && r.lifecycle == ExecutionLifecycle::Running)
        });
        let state = looping.persisted();
        let record = state
            .executions
            .values()
            .find(|r| r.candidate.step_key == "loop" && r.lifecycle == ExecutionLifecycle::Running)
            .unwrap()
            .clone();
        assert_eq!(
            state.occurrences[&record.candidate.inputs["plan.md"][0]].producer_execution_id.as_deref(),
            Some(previous_producer.as_str())
        );
        for output in record.outputs.iter().filter(|output| continue_loop || output.selector == "report.md") {
            looping.stock_tool(index, "write", json!({"path":looping.root.join(".alinery/tasks/fixture/artifacts").join(&output.relative_path),"content":if output.selector == "plan.md" {"fresh continuation"} else {"final report"}}));
            index += 1;
        }
        index = looping.stock_report_ready(&record, index, false);
        if continue_loop {
            looping.stock_continue(&record);
            looping.wait_state("loop pass must exit after acceptance", |state| state.executions[&record.id].shutdown_confirmed);
        } else {
            looping.assert_terminal_ready(&record);
        }
        previous_producer = record.id;
    }
    let final_state = looping.persisted();
    assert_eq!(
        final_state.executions.values().filter(|r| r.candidate.step_key == "loop").count(),
        2,
        "intentional omission must not manufacture another pass"
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.client.call(&json!({"op":"shutdown"}));
        let _ = self.child.wait();
        if let Some(provider) = self.provider.as_mut() {
            let _ = provider.kill();
            let _ = provider.wait();
        }
        if std::thread::panicking() {
            eprintln!("Retained failed fixture evidence at {}", self.root.display());
        } else {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
fn wait(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < until, "fixture condition timed out");
        thread::sleep(Duration::from_millis(10));
    }
}
fn definition() -> String {
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("first", "[]", "one.md"),
        ("second", "[]", "two.md"),
        ("join", "[{path='one.md',mode='single'},{path='two.md',mode='single'}]", "joined.md"),
    ] {
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step=true\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["first", "second", "join"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nWrite your assigned outputs.\n"));
    }
    source
}

#[test]
fn completion_bookkeeping_acceptance_busy_then_lost_ack_replays_immutable_receipt() {
    use std::{io::Write, os::unix::net::UnixStream};
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("owner running", |state| state.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let token = fs::read_to_string(fixture.root.join(format!("token-{}", first.owner_session_id))).unwrap();
    let control = fixture.bind(&first.owner_session_id);
    let event = json!({"op":"event","version":RUNNER_EVENT_PROTOCOL_VERSION,"session_id":first.owner_session_id,"token":token,
        "event":{"type":"readiness_reported","process_incarnation":control["process_incarnation"],"expected_work_revision":control["work_revision"]}});
    alinery_core::with_task_mutation_lock(&fixture.root, "fixture acceptance contention", || {
        assert!(fixture.client.call(&event).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("task mutation busy during accept execution completion"));
        assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
        Ok(())
    })
    .unwrap();
    // Submit the same event and deliberately abandon the response. The daemon,
    // not the transport fixture, commits the immutable publication receipt.
    let mut stream = UnixStream::connect(&fixture.client.socket_path).unwrap();
    writeln!(stream, "{event}").unwrap();
    drop(stream);
    fixture.wait_state("acceptance must commit even without an ACK consumer", |state| {
        state.executions[&first.id].receipt_id.is_some()
    });
    let committed = fixture.persisted();
    let replay = fixture.event(&first.owner_session_id);
    assert_eq!(replay["completion"]["receipt_id"].as_str(), committed.executions[&first.id].receipt_id.as_deref());
    assert_eq!(fixture.persisted(), committed, "receipt replay cannot reopen or republish acceptance");
    assert!(!committed.executions[&first.id].shutdown_confirmed);
    fixture.release(&first.owner_session_id);
    fixture.wait_state("confirmation follows actual exit", |state| {
        state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed
    });
}

#[test]
fn completion_bookkeeping_retries_exit_after_contention_and_restarts_from_drain_proof() {
    for restart in [false, true] {
        let mut fixture = Fixture::new();
        let created = fixture.create(false, true);
        let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
        fixture.start(first);
        let accepted = fixture.accept(first);
        let repo = fixture.root.clone();
        alinery_core::with_task_mutation_lock(&repo, "fixture hold across exit", || {
            fixture.release(&first.owner_session_id);
            wait(|| {
                fixture
                    .client
                    .call(&json!({"op":"status","id":first.owner_session_id}))
                    .is_ok_and(|value| value["process"]["state"] == "exited")
            });
            // Exceed the production commit's contention deadline. The callback
            // must fail, not merely wait successfully for this lock's release.
            thread::sleep(alinery_core::TASK_MUTATION_CONTENTION_WAIT + Duration::from_millis(250));
            assert!(!fixture.persisted().executions[&first.id].shutdown_confirmed);
            if restart {
                fixture.child.kill().unwrap();
                fixture.child.wait().unwrap();
            }
            Ok(())
        })
        .unwrap();
        if restart {
            fixture.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
                .args(["--repo", fixture.root.to_str().unwrap(), "--app-config", fixture.root.join("app.toml").to_str().unwrap()])
                .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
                .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            wait(|| fixture.client.version_checked().is_ok());
        }
        fixture.wait_state("exit confirmation must recover without worker prompt", |state| {
            state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed
        });
        let state = fixture.persisted();
        assert_eq!(state.executions[&first.id].receipt_id.as_deref(), accepted["completion"]["receipt_id"].as_str());
        assert!(state.executions[&first.id].shutdown_confirmed);
        assert_eq!(state.executions[&first.id].exit_code, Some(0));
        assert_eq!(state.executions.len(), 2, "an incomplete join cannot launch");
        let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
        fixture.start(second);
        fixture.finish(second);
        fixture.wait_state("exactly one successor after both confirmations", |state| {
            state.executions.values().filter(|r| r.candidate.step_key == "join").count() == 1
        });
    }
}

#[test]
fn completion_bookkeeping_never_journals_exit_before_output_drain() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("harness"), format!(
        "{1}\nwhile [ ! -f '{0}/release-'\"$ALINERY_SESSION_ID\" ]; do sleep 0.02; done\n(while [ ! -f '{0}/drain' ]; do sleep 0.02; done; printf '{{\"type\":\"last\"}}\\n') &\ntouch '{0}/parent-exiting'\nexit 0\n",
        fixture.root.display(), shell_seed_capture(&fixture.root))).unwrap();
    let created = fixture.create(false, true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.accept(first);
    fixture.release(&first.owner_session_id);
    wait(|| fixture.root.join("parent-exiting").exists());
    thread::sleep(Duration::from_millis(150));
    assert!(!fixture.persisted().executions[&first.id].shutdown_confirmed);
    assert!(!fs::read_dir(fixture.root.join(".alinery/tasks/fixture/sessions")).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".execution-exit.json")));
    fs::write(fixture.root.join("drain"), "").unwrap();
    fixture.wait_state("drained exit must complete", |state| state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed);
}

#[test]
#[ignore = "subprocess retaining output until the explicit drain latch"]
fn human_end_output_holder() {
    let root = PathBuf::from(std::env::var("ALINERY_REPO").unwrap());
    assert_ne!(unsafe { libc::setsid() }, -1);
    fs::write(root.join("held-output"), "").unwrap();
    while !root.join("release-output").exists() {
        thread::sleep(Duration::from_millis(10));
    }
    println!("drained human end output");
}

#[test]
fn human_end_holds_claims_until_output_drain_and_retries_exact_authorization() {
    let fixture = Fixture::new();
    let helper = std::env::current_exe().unwrap().display().to_string().replace('\'', "'\\''");
    fs::write(
        fixture.root.join("harness"),
        format!(
            "#!/bin/sh\n'{helper}' --ignored --exact human_end_output_holder --nocapture &\n{}\nwhile :; do sleep 1; done\n",
            shell_seed_capture(&fixture.root).trim_start_matches("#!/bin/sh\n"),
        ),
    )
    .unwrap();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    wait(|| fixture.root.join("held-output").exists());
    fixture.outputs(first);
    let request = prepare_human_end(&fixture, first);
    let mut stale = request.clone();
    stale["work_revision"] = json!(request["work_revision"].as_u64().unwrap() + 1);
    assert_eq!(human_control(&fixture, "end_execution", stale)["completion"]["status"], "stale");
    let pending = human_control(&fixture, "end_execution", request.clone());
    assert_eq!(pending["completion"]["status"], "waiting", "{pending}");
    let state = fixture.persisted();
    assert!(!state.executions[&first.id].shutdown_confirmed);
    assert!(state.executions[&first.id].receipt_id.is_none());
    assert!(state.executions[&first.id].lifecycle.holds_capacity());
    assert!(!state.executions.values().any(|r| r.candidate.step_key == "join"));
    let input = fixture
        .client
        .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{"id":"late-human-end","type":"prompt","message":"must not run"}}))
        .unwrap();
    assert_eq!(input["dispatch"]["status"], "not_sent");
    fs::write(fixture.root.join("release-output"), "").unwrap();
    fixture.wait_state("output drain must prove shutdown", |s| s.executions[&first.id].shutdown_confirmed);
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none(), "drain alone must never accept");
    let ended = human_control(&fixture, "end_execution", request);
    assert_eq!(ended["completion"]["status"], "accepted", "{ended}");
}

fn human_control(fixture: &Fixture, op: &str, request: Value) -> Value {
    human_control_message(fixture, json!({"op":op,"request":request}))
}

fn human_control_message(fixture: &Fixture, message: Value) -> Value {
    use std::io::{BufRead, Write};
    let mut stream = std::os::unix::net::UnixStream::connect(&fixture.client.socket_path).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(100))).unwrap();
    writeln!(stream, "{}", json!({"op":"ui_control"})).unwrap();
    let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], true);
    writeln!(stream, "{message}").unwrap();
    line.clear();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

fn prepare_human_end(fixture: &Fixture, record: &ExecutionRecord) -> Value {
    let request = json!({"task_slug":"fixture","execution_id":record.id,"session_id":record.owner_session_id});
    assert!(fixture.client.call(&json!({"op":"prepare_end_execution","request":request,"caller":"ui"})).unwrap()["error"].is_string());
    let result = human_control(fixture, "prepare_end_execution", request);
    assert!(result["preparation"]["request"].is_object(), "{result}");
    result["preparation"]["request"].clone()
}

#[test]
fn human_end_stops_before_acceptance_preserves_exit_and_replays_once() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("owner running", |s| s.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    fixture.outputs(first);
    let request = prepare_human_end(&fixture, first);
    assert!(fixture.client.call(&json!({"op":"end_execution","request":request,"caller":"ui"})).unwrap()["error"].is_string());
    assert!(!fixture.persisted().executions[&first.id].shutdown_confirmed);
    let mut stale = request.clone();
    stale["process_incarnation"] = json!("retired");
    assert_eq!(human_control(&fixture, "end_execution", stale)["completion"]["status"], "stale");
    let ended = human_control(&fixture, "end_execution", request.clone());
    assert_eq!(ended["completion"]["status"], "accepted", "{ended}");
    let state = fixture.persisted();
    let record = &state.executions[&first.id];
    assert!(record.shutdown_confirmed);
    assert_eq!(record.lifecycle, ExecutionLifecycle::Completed);
    assert_ne!(record.exit_code, Some(0), "intentional kill must not invent success");
    assert!(record.receipt_id.is_some());
    assert_eq!(human_control(&fixture, "end_execution", request)["completion"], ended["completion"]);
    assert_eq!(fixture.persisted().executions[&first.id].receipt_id, record.receipt_id);
    assert_eq!(fixture.persisted().occurrences, state.occurrences);
    let publications: Vec<_> = state.occurrences.values().filter(|o| o.producer_execution_id.as_deref() == Some(&first.id)).collect();
    assert_eq!(publications.len(), first.outputs.len());
    for output in &first.outputs {
        assert!(publications.iter().any(|o| o.relative_path == output.relative_path && o.selector == output.selector));
    }
    let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    fixture.start(second);
    fixture.wait_state("remaining root starts after stopped handoff", |s| {
        s.executions[&second.id].lifecycle == ExecutionLifecycle::Running
    });
    fixture.finish(second);
    fixture.wait_state("one successor receives both exact accepted publications", |s| {
        let successors: Vec<_> = s.executions.values().filter(|r| r.candidate.step_key == "join").collect();
        successors.len() == 1 && publications.iter().all(|o| successors[0].candidate.inputs.values().flatten().any(|id| id == &o.id))
    });
}
#[test]
fn human_end_invalid_outputs_stays_stopped_and_can_be_replaced() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("owner running", |s| s.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    let request = prepare_human_end(&fixture, first);
    let ended = human_control(&fixture, "end_execution", request.clone());
    assert_eq!(ended["completion"]["status"], "invalid_outputs", "{ended}");
    let state = fixture.persisted();
    assert!(state.executions[&first.id].shutdown_confirmed);
    assert!(state.executions[&first.id].receipt_id.is_none());
    assert!(!state.executions.values().any(|r| r.candidate.step_key == "join"));
    assert_eq!(prepare_human_end(&fixture, first), request, "stopped invalid work remains explicitly reviewable");
    let replacement = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: first.candidate.step_key.clone(),
                execution_id: Some(first.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_ne!(replacement.session.id, first.owner_session_id);
    assert_eq!(human_control(&fixture, "end_execution", request)["completion"]["status"], "stale");
}

#[test]
fn human_end_stopped_nonzero_exit_requires_new_explicit_authorization() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("harness"),
        format!(
            "{}\nwhile [ ! -f '{}/release-'\"$ALINERY_SESSION_ID\" ]; do sleep 0.02; done\nexit 23\n",
            shell_seed_capture(&fixture.root),
            fixture.root.display(),
        ),
    )
    .unwrap();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.bind(&first.owner_session_id);
    fixture.outputs(first);
    fixture.release(&first.owner_session_id);
    fixture.wait_state("unrelated failed process is proven stopped", |s| s.executions[&first.id].shutdown_confirmed);
    let failed = fixture.persisted();
    assert_eq!(failed.executions[&first.id].exit_code, Some(23));
    assert_eq!(failed.executions[&first.id].lifecycle, ExecutionLifecycle::Failed);
    assert!(failed.executions[&first.id].receipt_id.is_none());
    let request = prepare_human_end(&fixture, first);
    let ended = human_control(&fixture, "end_execution", request);
    assert_eq!(ended["completion"]["status"], "accepted", "{ended}");
    assert_eq!(fixture.persisted().executions[&first.id].exit_code, Some(23));
}

#[test]
fn manual_completion_reports_ready_without_publishing_or_releasing_join() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|record| record.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("manual owner is running", |state| state.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let before = fixture.persisted();

    let outcome = fixture.event(&first.owner_session_id);
    assert_eq!(
        outcome["completion"]["status"], "ready",
        "valid manual work must become reviewable without a finish approval"
    );
    let revision = outcome["completion"]["ready_revision"].as_u64().expect("ready identifies the validated work revision");
    let ready = fixture.persisted();
    assert_eq!(ready.executions[&first.id].lifecycle, ExecutionLifecycle::Running);
    assert!(ready.executions[&first.id].receipt_id.is_none());
    assert!(!ready.executions[&first.id].shutdown_confirmed);
    assert_eq!(ready.occurrences, before.occurrences, "review drafts must not become accepted publications");
    assert!(!ready.executions.values().any(|record| record.candidate.step_key == "join"));
    let observed = serde_json::to_value(fixture.state()).unwrap();
    assert_eq!(observed["state"]["executions"][&first.id]["ready_revision"], revision);
}

#[test]
fn manual_one_step_completion_stays_ready_without_publishing_or_exiting() {
    let fixture = Fixture::new();
    let source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n[[step]]\nkey='only'\ntitle='Only'\nshort=''\ninputs=[]\noutputs=[{path='result.md'}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n+++\n<!-- alinery:step only -->\nWrite your assigned output.\n";
    let created = fixture.create_with(source, 1, &[], false);
    let only = created.executions.iter().find(|record| record.candidate.step_key == "only").unwrap();
    fixture.start(only);
    fixture.wait_state("terminal owner is running", |state| state.executions[&only.id].lifecycle == ExecutionLifecycle::Running);
    wait(|| fixture.root.join(format!("token-{}", only.owner_session_id)).exists());
    fixture.outputs(only);

    let outcome = fixture.event(&only.owner_session_id);
    assert_eq!(outcome["completion"]["status"], "ready");
    fixture.assert_terminal_ready(only);
    assert_eq!(fixture.event(&only.owner_session_id)["completion"], outcome["completion"]);
    fixture.assert_terminal_ready(only);
}

#[test]
fn continuation_requires_authenticated_current_capability() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|record| record.candidate.step_key == "first").unwrap();
    fixture.start(first);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let process: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .root
                .join(".alinery/tasks/fixture/sessions")
                .join(format!("{}.execution-process.json", first.owner_session_id)),
        )
        .unwrap(),
    )
    .unwrap();
    let report = json!({"type":"readiness_reported","process_incarnation":process["incarnation"],"expected_work_revision":fixture.persisted().executions[&first.id].work_revision});
    assert_eq!(fixture.runner_event(&first.owner_session_id, report.clone())["completion"]["status"], "unavailable");
    let bootstrap = fixture.runner_event(&first.owner_session_id, json!({"type":"continuation_poll"}));
    let partial = fixture.runner_event(
        &first.owner_session_id,
        json!({"type":"continuation_bind","omp_session_id":"fixture","groups":["primary_control"],
            "operation_id":uuid::Uuid::new_v4().to_string(),"expected_capability_revision":bootstrap["control"]["capability_revision"]}),
    );
    assert_eq!(partial["control"]["available"], false);
    assert_eq!(fixture.runner_event(&first.owner_session_id, report)["completion"]["status"], "unavailable");
    let ready = fixture.event(&first.owner_session_id);
    assert_eq!(ready["completion"]["status"], "ready");
    let request = fixture.continue_request(first, ready["completion"]["ready_revision"].as_u64().unwrap());
    assert!(fixture.client.call(&json!({"op":"continue_execution","caller":"ui","request":request})).unwrap()["error"].is_string());
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let mut wrong = request.clone();
    wrong.process_incarnation = "retired-process".into();
    assert!(matches!(ui.continue_execution(&wrong).unwrap(), CompletionOutcome::Stale { .. }));
    assert!(matches!(ui.continue_execution(&request).unwrap(), CompletionOutcome::Requested { .. }));
    let denied = fixture
        .client
        .call(&json!({"op":"rpc_write","id":first.owner_session_id,"payload":{"id":"losing-review","type":"prompt","message":"must remain recoverable"}}))
        .unwrap();
    assert_eq!(denied["dispatch"]["status"], "not_sent");
    assert!(fixture.persisted().executions[&first.id].receipt_id.is_none());
}

#[test]
fn auxiliary_sessions_inherit_current_settings_without_overriding_explicit_models_or_terminal() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/global'\n").unwrap();
    fixture.create(false, true);
    let create = |harness: &str, model: Option<&str>| {
        fixture
            .client
            .create_execution_session(&CreateExecutionSessionRequest {
                task_slug: "fixture".into(),
                target: ExecutionSessionTarget::Auxiliary {
                    harness: harness.into(),
                    model: model.map(str::to_owned),
                    prompt: None,
                },
                launch_override: None,
                prompt_extra: None,
                handoff_artifact: None,
                start: false,
            })
            .unwrap()
            .session
    };
    assert_eq!(create("omp", None).model, "provider/global");
    assert_eq!(create("omp", Some("")).model, "provider/global");
    assert_eq!(create("omp", Some("provider/explicit")).model, "provider/explicit");
    assert_eq!(create("no-harness", None).model, "");

    fs::write(fixture.root.join(".alinery/config.toml"), "[defaults]\nmodel='provider/repository'\n").unwrap();
    let repository_session = create("omp", None);
    assert_eq!(repository_session.model, "provider/repository");
    fs::write(fixture.root.join(".alinery/config.toml"), "[defaults]\nmodel=''\n").unwrap();
    assert_eq!(create("omp", None).model, "");
    let saved = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "fixture", &repository_session.id)).unwrap();
    assert_eq!(saved.model, "provider/repository", "settings changes must not rewrite existing sessions");
}

#[test]
fn subtask_manager_inherits_chat_default_instead_of_retained_task_model() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/old'\n").unwrap();
    fixture.create(false, true);
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nharness='omp'\nmodel='provider/current'\n").unwrap();
    let manager = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::SubtaskManager {
                subtask_slug: None,
                recover: false,
                harness: "omp".into(),
                model: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_eq!(manager.session.model, "provider/current");
}

#[test]
fn held_roots_and_coding_capacity_are_durable_and_individual_start_isolated() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    assert_eq!(created.creation, "ready");
    assert_eq!(created.sessions.len(), 2);
    assert!(created.executions.iter().all(|r| !r.start_requested && r.lifecycle == ExecutionLifecycle::Queued));
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let second = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    let started = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(started.start, "started");
    assert!(!fixture.state().state.executions[&second.id].start_requested);
    let queued = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: second.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(queued.start, "queued");
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let outcome = fixture.event(&first.owner_session_id);
    assert_eq!(outcome["completion"]["status"], "accepted");
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["receipt_id"], outcome["completion"]["receipt_id"]);
    let state = fixture.state().state;
    assert_eq!(state.executions[&first.id].lifecycle, ExecutionLifecycle::Finishing);
    assert_eq!(state.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    fixture.release(&first.owner_session_id);
    wait(|| fixture.state().state.executions[&second.id].lifecycle == ExecutionLifecycle::Running);
    assert!(fixture.state().state.executions[&first.id].shutdown_confirmed);
    assert!(!fixture.state().state.executions.values().any(|r| r.candidate.step_key == "join"));
    fixture.outputs(second);
    wait(|| fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    assert_eq!(fixture.event(&second.owner_session_id)["completion"]["status"], "accepted");
    fixture.release(&second.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .any(|r| r.candidate.step_key == "join" && r.lifecycle == ExecutionLifecycle::Running)
    });
}

#[test]
fn only_retained_authenticated_ui_channel_continues_the_current_owner() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    let ready = fixture.event(&first.owner_session_id);
    assert_eq!(ready["completion"]["status"], "ready");
    let request = fixture.continue_request(first, ready["completion"]["ready_revision"].as_u64().unwrap());
    assert!(fixture.client.call(&json!({"op":"continue_execution","caller":"ui","request":request})).unwrap()["error"].is_string());
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let mut stale = request.clone();
    stale.process_incarnation = "retired-incarnation".into();
    assert!(matches!(ui.continue_execution(&stale).unwrap(), CompletionOutcome::Stale { .. }));
    assert!(matches!(ui.continue_execution(&request).unwrap(), CompletionOutcome::Requested { .. }));
    let granted = fixture.persisted();
    fs::write(fixture.root.join(".alinery/tasks/fixture/artifacts").join(&first.outputs[0].relative_path), "").unwrap();
    let finalize = json!({"type":"continuation_finalize","process_incarnation":request.process_incarnation,"ready_revision":request.ready_revision});
    assert_eq!(fixture.runner_event(&first.owner_session_id, finalize.clone())["completion"]["status"], "invalid_outputs");
    let invalid = fixture.persisted();
    assert_eq!(invalid.executions[&first.id].lifecycle, ExecutionLifecycle::Running);
    assert!(invalid.executions[&first.id].continuation_requested_revision.is_none());
    assert!(invalid.executions[&first.id].receipt_id.is_none());
    assert_eq!(invalid.occurrences, granted.occurrences);
    fixture.outputs(first);
    assert_eq!(fixture.runner_event(&first.owner_session_id, finalize)["completion"]["status"], "stale");
    let renewed = fixture.event(&first.owner_session_id);
    assert_eq!(renewed["completion"]["status"], "ready");
    assert!(matches!(ui.continue_execution(&request).unwrap(), CompletionOutcome::Stale { .. }));
    let fresh = fixture.continue_request(first, renewed["completion"]["ready_revision"].as_u64().unwrap());
    assert!(matches!(ui.continue_execution(&fresh).unwrap(), CompletionOutcome::Requested { .. }));
    let accepted = fixture.runner_event(
        &first.owner_session_id,
        json!({"type":"continuation_finalize","process_incarnation":fresh.process_incarnation,"ready_revision":fresh.ready_revision}),
    );
    assert_eq!(accepted["completion"]["status"], "accepted");
    let finishing = fixture.persisted();
    assert_eq!(finishing.executions[&first.id].lifecycle, ExecutionLifecycle::Finishing);
    assert!(!finishing.executions[&first.id].shutdown_confirmed);
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["receipt_id"], accepted["completion"]["receipt_id"]);
    fixture.release(&first.owner_session_id);
    fixture.wait_state("accepted owner exits", |state| state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed);
    assert!(!fixture.persisted().executions.values().any(|r| r.candidate.step_key == "join"));
}

#[test]
fn failed_start_is_retained_and_requires_explicit_stopped_owner_recovery() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    fs::write(
        fixture.root.join(".alinery/harnesses.toml"),
        "[[harness]]\nkey='omp'\nname='Missing'\nbinary='/nonexistent/alinery-fixture'\nargs=[]\nmodel_arg=[]\nadapter='omp'\n",
    )
    .unwrap();
    let first = &created.executions[0];
    let failed = fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    assert_eq!(failed.start, "failed");
    assert!(failed.execution.as_ref().unwrap().shutdown_confirmed);
    assert!(fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone()
        })
        .is_err());
    let recovered = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: first.candidate.step_key.clone(),
                execution_id: Some(first.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: Some(alinery_core::LaunchChoices {
                harness: "omp".into(),
                model: "corrected-model".into(),
            }),
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    assert_ne!(recovered.session.id, first.owner_session_id);
    assert_eq!(recovered.execution.as_ref().unwrap().outputs, first.outputs);
    assert_eq!(recovered.execution.as_ref().unwrap().launch.model, "corrected-model");
    assert_eq!(recovered.execution.unwrap().previous_session_ids, vec![first.owner_session_id.clone()]);
}

#[test]
fn repeated_explicit_manual_runs_are_independent_and_do_not_replace_the_ordinary_binding() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    let ordinary = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let request = CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "first".into(),
            execution_id: None,
            input_occurrence_ids: Some(Vec::new()),
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    };
    let one = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let two = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let three = fixture.client.create_execution_session(&request).unwrap().execution.unwrap();
    let ids: std::collections::BTreeSet<_> = [&ordinary.id, &one.id, &two.id, &three.id].into_iter().collect();
    assert_eq!(ids.len(), 4);
    assert_ne!(one.outputs, two.outputs);
    assert_ne!(two.outputs, three.outputs);
    assert_eq!(fixture.state().state.executions[&ordinary.id].outputs, ordinary.outputs);
}

#[test]
fn crash_after_acceptance_never_turns_an_unproven_owner_into_a_handoff() {
    let mut fixture = Fixture::new();
    let created = fixture.create(false, true);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: first.owner_session_id.clone(),
        })
        .unwrap();
    wait(|| fixture.root.join(format!("token-{}", first.owner_session_id)).exists());
    fixture.outputs(first);
    assert_eq!(fixture.event(&first.owner_session_id)["completion"]["status"], "accepted");
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    // Let only this fixture's orphan child exit. The new daemon has no wait/drain
    // proof and must not infer a completed handoff from the accepted receipt.
    fixture.release(&first.owner_session_id);
    fixture.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
        .args(["--repo", fixture.root.to_str().unwrap(), "--app-config", fixture.root.join("app.toml").to_str().unwrap()])
        .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
        .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    wait(|| fixture.client.version_checked().is_ok());
    let recovered = fixture.state().state;
    assert_eq!(recovered.executions[&first.id].lifecycle, ExecutionLifecycle::Interrupted);
    assert!(recovered.executions[&first.id].receipt_id.is_some());
    assert!(!recovered.executions[&first.id].shutdown_confirmed);
    let result = fixture.client.create_execution_session(&CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "first".into(),
            execution_id: Some(first.id.clone()),
            input_occurrence_ids: None,
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    });
    assert!(result.is_err(), "accepted uncertain work cannot be reopened");
    assert!(!fixture.state().state.executions.values().any(|r| r.candidate.step_key == "join"));
}

#[test]
fn malformed_defaults_reject_provisioning_but_legacy_defaults_allow_it() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("app.toml"), "[global.defaults]\nplaybook = 17\n").unwrap();
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Invalid configuration", "requested_slug": "invalid-config",
        "playbook": { "reference": { "scope": "repo", "key": "fixture" }, "source": definition() },
        "start": false
    }))
    .unwrap();
    let result = fixture.client.create_task(&request);
    assert!(result.is_err(), "invalid settings must reject before creation, got {result:?}");
    assert!(!fixture.root.join(".alinery/tasks/invalid-config").exists());
    assert!(!fixture.root.join(".alinery/worktrees/invalid-config").exists());
    assert!(!alinery_core::git_cmd(&fixture.root)
        .args(["show-ref", "--verify", "--quiet", "refs/heads/invalid-config"])
        .status()
        .unwrap()
        .success());

    let legacy = "[global.defaults]\nplaybook = 'superdevelop'\n";
    fs::write(fixture.root.join("app.toml"), legacy).unwrap();
    let created = fixture.client.create_task(&request).unwrap();
    assert_eq!(created.creation, "ready");
    assert_eq!(
        created.task.unwrap().playbook_ref.unwrap(),
        alinery_core::playbook::PlaybookRef {
            scope: alinery_core::playbook::PlaybookScope::Repo,
            key: "fixture".into(),
        }
    );
    assert!(fixture.root.join(".alinery/tasks/invalid-config/task.md").is_file());
    assert_eq!(fs::read_to_string(fixture.root.join("app.toml")).unwrap(), legacy);
}

#[test]
fn project_startup_requires_stopped_owner_and_preserves_uncertain_execution() {
    struct Lane {
        child: Child,
        client: DaemonClient,
    }
    impl Drop for Lane {
        fn drop(&mut self) {
            let _ = self.client.call(&json!({"op": "shutdown"}));
            let _ = self.child.wait();
        }
    }
    let mut fixture = Fixture::new();
    let created = fixture.create(false, true);
    let first = created.executions.iter().find(|record| record.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.accept(first);
    let spawn_other = || {
        Command::new(env!("CARGO_BIN_EXE_alineryd"))
            .args([
                "--repo",
                fixture.root.to_str().unwrap(),
                "--app-config",
                fixture.root.join("app.toml").to_str().unwrap(),
                "--socket-namespace",
                "other",
            ])
            .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
            .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    };
    let state = fixture.persisted();
    let mut blocked = spawn_other();
    assert!(!blocked.wait().unwrap().success());
    assert!(!alinery_core::alineryd_socket_path(&fixture.root, Some("other")).exists());
    let sessions = || {
        fs::read_dir(fixture.root.join(".alinery/tasks/fixture/sessions"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>()
    };
    let before = sessions();
    fs::remove_file(&fixture.client.socket_path).unwrap();
    let mut blocked_without_socket = spawn_other();
    assert!(!blocked_without_socket.wait().unwrap().success(), "live lock must block even without socket");
    assert_eq!(fixture.persisted().owning_lane, state.owning_lane);
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    fixture.release(&first.owner_session_id);
    let other = Lane {
        child: spawn_other(),
        client: DaemonClient {
            socket_path: alinery_core::alineryd_socket_path(&fixture.root, Some("other")),
        },
    };
    wait(|| other.client.version_checked().is_ok());
    let transferred = fixture.persisted();
    assert_eq!(transferred.owning_lane, "other");
    assert_eq!(transferred.executions[&first.id].lifecycle, ExecutionLifecycle::Interrupted);
    assert_eq!(transferred.executions[&first.id].receipt_id, state.executions[&first.id].receipt_id);
    assert!(!transferred.executions[&first.id].shutdown_confirmed);
    assert_eq!(transferred.executions[&first.id].owner_session_id, first.owner_session_id);
    assert_eq!(transferred.occurrences, state.occurrences);
    assert_eq!(transferred.collections, state.collections);
    assert_eq!(sessions(), before);
    let auxiliary = other
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Auxiliary {
                harness: "no-harness".into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: true,
        })
        .unwrap();
    assert_eq!(auxiliary.session.daemon_namespace, "other");
    assert_eq!(auxiliary.start, "started", "new sessions must launch under the transferred owner");
    assert!(other
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: "first".into(),
                execution_id: Some(first.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .is_err());
    // Querying/reconciling on the new lane must not rewrite historical routing.
    other.client.get_task_execution(&GetTaskExecutionRequest { task_slug: "fixture".into() }).unwrap();
    let metadata = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "fixture", &first.owner_session_id)).unwrap();
    assert_eq!(metadata.daemon_namespace, state.owning_lane);
}

#[test]
fn replacement_configuration_adopts_stopped_tasks_and_can_start_queued_auxiliary() {
    let mut fixture = Fixture::new();
    fixture.create(false, true);
    let auxiliary = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Auxiliary {
                harness: "no-harness".into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .unwrap();
    fixture.client.call(&json!({"op": "shutdown"})).unwrap();
    fixture.child.wait().unwrap();
    fixture.child = Command::new(env!("CARGO_BIN_EXE_alineryd"))
        .args([
            "--repo",
            fixture.root.to_str().unwrap(),
            "--app-config",
            fixture.root.join("different-app.toml").to_str().unwrap(),
        ])
        .env("ALINERY_RUNNER_PATH", fixture.root.join("runner"))
        .env("ALINERY_HOST_EXECUTABLE", std::env::current_exe().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    wait(|| fixture.client.version_checked().is_ok());
    assert!(fixture
        .client
        .start_session(&StartSessionRequest {
            task_slug: "fixture".into(),
            session_id: auxiliary.session.id.clone(),
        })
        .is_ok());
    let metadata: alinery_core::SessionMeta = serde_json::from_slice(&fs::read(alinery_core::session_meta_path(&fixture.root, "fixture", &auxiliary.session.id)).unwrap()).unwrap();
    assert!(metadata.started_at.is_some());
}

#[test]
fn terminal_sentinel_launches_a_shell_without_claiming_graph_capacity() {
    let fixture = Fixture::new();
    fixture.create(false, true);
    let reply = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Auxiliary {
                harness: "no-harness".into(),
                model: None,
                prompt: None,
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: true,
        })
        .unwrap();
    assert_eq!(reply.start, "started", "{:?}", reply.errors);
    let proof = fixture.root.join("terminal-proof");
    fixture
        .client
        .call(&alinery_core::write_request(
            &reply.session.id,
            &format!("printf shell-live > '{}'\r", proof.display()),
            "fixture-shell-live",
        ))
        .unwrap();
    wait(|| fs::read_to_string(&proof).is_ok_and(|text| text == "shell-live"));
    assert!(fixture.state().state.executions.values().all(|record| !record.lifecycle.holds_capacity()));
}

#[test]
fn fanout_complete_waits_for_the_paused_worker_and_computes_assigned_results() {
    let fixture = Fixture::new();
    let mut source = "+++\nversion=2\nkey='squares'\ntitle='Squares'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("seed", "[]", "request-*.md"),
        ("worker", "[{path='request-*.md',mode='each'}]", "result-*.md"),
        ("collect", "[{path='result-*.md',mode='complete'}]", "answer.md"),
    ] {
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step=false\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["seed", "worker", "collect"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nUse only assigned inputs and outputs.\n"));
    }
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Fixture", "requested_slug": "fixture", "description": "Squares",
        "playbook": {"reference": {"scope": "repo", "key": "squares"}, "source": source},
        "max_live_sessions": 3, "auto_advance_steps": ["seed", "collect"], "start": true
    }))
    .unwrap();
    let created = fixture.client.create_task(&request).unwrap();
    let worktree = PathBuf::from(&created.task.as_ref().unwrap().worktree).canonicalize().unwrap();
    let seed = created.executions.iter().find(|record| record.candidate.step_key == "seed").unwrap();
    wait(|| fixture.root.join(format!("token-{}", seed.owner_session_id)).exists());
    let artifacts = fixture.root.join(".alinery/tasks/fixture/artifacts");
    for (member, value) in [("alpha", 2), ("beta", 3), ("gamma", 5)] {
        fs::write(artifacts.join(seed.outputs[0].relative_path.replace('*', member)), value.to_string()).unwrap();
    }
    assert_eq!(fixture.event(&seed.owner_session_id)["completion"]["status"], "accepted");
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "worker"));
    fixture.release(&seed.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .filter(|record| record.candidate.step_key == "worker" && record.lifecycle == ExecutionLifecycle::Running)
            .count()
            == 3
    });
    let snapshot = fixture.state();
    let workers: Vec<_> = snapshot.state.executions.values().filter(|record| record.candidate.step_key == "worker").cloned().collect();
    let mut ui = UiControlConnection::connect(&fixture.client).unwrap();
    let mut paused = None;
    for worker in &workers {
        wait(|| fixture.root.join(format!("cwd-{}", worker.owner_session_id)).exists());
        assert_eq!(
            PathBuf::from(fs::read_to_string(fixture.root.join(format!("cwd-{}", worker.owner_session_id))).unwrap().trim())
                .canonicalize()
                .unwrap(),
            worktree
        );
        let input = &snapshot.state.occurrences[&worker.candidate.inputs["request-*.md"][0]];
        let value: u64 = fs::read_to_string(artifacts.join(&input.relative_path)).unwrap().parse().unwrap();
        fs::write(artifacts.join(worker.outputs[0].relative_path.replace('*', "square")), (value * value).to_string()).unwrap();
        if value == 3 {
            assert_eq!(fixture.event(&worker.owner_session_id)["completion"]["status"], "ready");
            paused = Some(worker.clone());
            continue;
        }
        let ready = fixture.event(&worker.owner_session_id);
        ui.continue_execution(&fixture.continue_request(worker, ready["completion"]["ready_revision"].as_u64().unwrap()))
            .unwrap();
        assert_eq!(fixture.event(&worker.owner_session_id)["completion"]["status"], "accepted");
        fixture.release(&worker.owner_session_id);
        wait(|| fixture.state().state.executions[&worker.id].lifecycle == ExecutionLifecycle::Completed);
    }
    fs::write(artifacts.join("999-result-decoy.md"), "1000").unwrap();
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "collect"));
    let paused = paused.unwrap();
    let ready = fixture.event(&paused.owner_session_id);
    ui.continue_execution(&fixture.continue_request(&paused, ready["completion"]["ready_revision"].as_u64().unwrap()))
        .unwrap();
    assert_eq!(fixture.event(&paused.owner_session_id)["completion"]["status"], "accepted");
    assert_eq!(fixture.state().state.executions[&paused.id].lifecycle, ExecutionLifecycle::Finishing);
    assert!(!fixture.state().state.executions.values().any(|record| record.candidate.step_key == "collect"));
    fixture.release(&paused.owner_session_id);
    wait(|| {
        fixture
            .state()
            .state
            .executions
            .values()
            .any(|record| record.candidate.step_key == "collect" && record.lifecycle == ExecutionLifecycle::Running)
    });
    let collected = fixture.state();
    let collector = collected.state.executions.values().find(|record| record.candidate.step_key == "collect").unwrap();
    let ids = &collector.candidate.inputs["result-*.md"];
    let producers: std::collections::BTreeSet<_> = ids.iter().map(|id| collected.state.occurrences[id].producer_execution_id.as_ref().unwrap()).collect();
    assert_eq!(producers, workers.iter().map(|worker| &worker.id).collect());
    let answer: u64 = ids
        .iter()
        .map(|id| {
            fs::read_to_string(artifacts.join(&collected.state.occurrences[id].relative_path))
                .unwrap()
                .parse::<u64>()
                .unwrap()
        })
        .sum();
    assert_eq!(answer, 38);
    fs::write(artifacts.join(&collector.outputs[0].relative_path), answer.to_string()).unwrap();
    wait(|| fixture.root.join(format!("token-{}", collector.owner_session_id)).exists());
    assert_eq!(fixture.event(&collector.owner_session_id)["completion"]["status"], "ready");
    fixture.assert_terminal_ready(collector);
}

#[test]
fn task_creation_preserves_existing_unicode_slug_normalization() {
    let fixture = Fixture::new();
    let request: CreateTaskRequest = serde_json::from_value(json!({
        "name": "Café  worker",
        "playbook": {"reference": {"scope": "repo", "key": "fixture"}, "source": definition()},
        "start": false
    }))
    .unwrap();
    let result = fixture.client.create_task(&request).unwrap();
    let task = result.task.unwrap();
    assert_eq!(task.slug, "café--worker");
    assert_eq!(task.branch, "café--worker");
    assert!(PathBuf::from(task.worktree).join(".git").is_file());
}

fn shared_exact_definition(coding: bool) -> String {
    let mut source = "+++\nversion=2\nkey='fixture'\ntitle='Fixture'\ndescription=''\ndefault_model=''\ndefault_harness='omp'\n".to_string();
    for (key, inputs, output) in [
        ("checker", "[]", "request.md"),
        ("synthesis", "[]", "request.md"),
        ("brief", "[]", "brief.md"),
        ("designer", "[{path='request.md',mode='single'},{path='brief.md',mode='single'}]", "design.md"),
    ] {
        let is_coding = coding && key == "designer";
        source.push_str(&format!("[[step]]\nkey='{key}'\ntitle='{key}'\nshort=''\ninputs={inputs}\noutputs=[{{path='{output}'}}]\nmodel=''\nharness=''\nis_coding_step={is_coding}\nauto_advance_default=false\n"));
    }
    source.push_str("+++\n");
    for key in ["checker", "synthesis", "brief", "designer"] {
        source.push_str(&format!("<!-- alinery:step {key} -->\nWrite assigned evidence, then wait for release.\n"));
    }
    source
}

// Hold the governing brief, not auto_advance_steps: that setting controls
// continuation mode, whereas nonroot executions always request a start.
fn shared_exact_publish_requests(fixture: &Fixture, capacity: u32, coding: bool, enabled: &[&str]) -> ExecutionRecord {
    let created = fixture.create_with(&shared_exact_definition(coding), capacity, enabled, false);
    assert_eq!(created.creation, "ready");
    for key in ["checker", "synthesis"] {
        let publisher = created.executions.iter().find(|record| record.candidate.step_key == key).unwrap();
        assert_eq!(fixture.start(publisher).start, "started");
        fixture.finish(publisher);
    }
    let state = fixture.persisted();
    assert!(!state.executions.values().any(|record| record.candidate.step_key == "designer"));
    let requests: Vec<_> = state.occurrences.values().filter(|occurrence| occurrence.logical_path == "request.md").collect();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0].id, requests[1].id);
    assert_ne!(requests[0].producer_execution_id, requests[1].producer_execution_id);
    let artifacts = fixture.root.join(".alinery/tasks/fixture/artifacts");
    assert_eq!(
        fs::read(artifacts.join(&requests[0].relative_path)).unwrap(),
        fs::read(artifacts.join(&requests[1].relative_path)).unwrap()
    );
    created.executions.iter().find(|record| record.candidate.step_key == "brief").unwrap().clone()
}

fn shared_exact_designers(fixture: &Fixture) -> Vec<ExecutionRecord> {
    fixture.wait_state("both request occurrences must have durable ordinary Designer reservations", |state| {
        state
            .executions
            .values()
            .filter(|record| record.candidate.step_key == "designer" && !record.candidate.manual)
            .count()
            == 2
    });
    let state = fixture.persisted();
    let designers: Vec<_> = state
        .executions
        .values()
        .filter(|record| record.candidate.step_key == "designer" && !record.candidate.manual)
        .cloned()
        .collect();
    let brief = state.occurrences.values().find(|occurrence| occurrence.logical_path == "brief.md").unwrap();
    let expected: std::collections::BTreeSet<_> = state
        .occurrences
        .values()
        .filter(|occurrence| occurrence.logical_path == "request.md")
        .map(|request| std::collections::BTreeMap::from([("request.md".to_string(), vec![request.id.clone()]), ("brief.md".to_string(), vec![brief.id.clone()])]))
        .collect();
    assert_eq!(
        designers.iter().map(|record| record.candidate.inputs.clone()).collect::<std::collections::BTreeSet<_>>(),
        expected
    );
    assert_ne!(designers[0].owner_session_id, designers[1].owner_session_id);
    assert_ne!(designers[0].binding_key, designers[1].binding_key);
    let paths: std::collections::BTreeSet<_> = designers.iter().flat_map(|record| record.outputs.iter().map(|output| &output.relative_path)).collect();
    assert_eq!(paths.len(), 2, "each binding owns a distinct physical design path");
    designers
}

fn shared_exact_manual_request(record: Option<&ExecutionRecord>) -> CreateExecutionSessionRequest {
    CreateExecutionSessionRequest {
        task_slug: "fixture".into(),
        target: ExecutionSessionTarget::Primary {
            step_key: "designer".into(),
            execution_id: None,
            input_occurrence_ids: record.map(|record| record.candidate.inputs.values().flatten().cloned().collect()),
        },
        launch_override: None,
        prompt_extra: None,
        handoff_artifact: None,
        start: false,
    }
}

#[test]
fn shared_exact_requests_are_reserved_before_capacity_launch() {
    let fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 1, false, &[]);
    assert_eq!(fixture.start(&brief).start, "started");
    fixture.accept(&brief);
    let finishing = fixture.persisted();
    assert!(finishing.executions[&brief.id].receipt_id.is_some());
    assert!(!finishing.executions[&brief.id].shutdown_confirmed);
    assert_eq!(finishing.executions.values().filter(|record| record.lifecycle.holds_capacity()).count(), 1);
    assert!(!finishing.executions.values().any(|record| record.candidate.step_key == "designer"));
    fixture.release(&brief.owner_session_id);
    let designers = shared_exact_designers(&fixture);
    fixture.wait_state("one ordinary Designer must launch at capacity one", |state| {
        state
            .executions
            .values()
            .any(|record| record.candidate.step_key == "designer" && record.lifecycle == ExecutionLifecycle::Running)
    });
    let state = fixture.persisted();
    let first = designers
        .iter()
        .find(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
        .unwrap();
    let second = designers.iter().find(|record| record.id != first.id).unwrap();
    assert!(state.executions[&brief.id].shutdown_confirmed);
    assert_eq!(state.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert_eq!(fixture.start(second).start, "queued");
    let accepted = fixture.accept(first);
    let before_replay = fixture.persisted();
    assert_eq!(fixture.event(&first.owner_session_id)["completion"], accepted["completion"]);
    let replayed = fixture.persisted();
    assert_eq!(replayed.occurrences, before_replay.occurrences);
    assert_eq!(replayed.executions, before_replay.executions);
    assert_eq!(replayed.executions[&second.id].lifecycle, ExecutionLifecycle::Queued);
    assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
    fixture.release(&first.owner_session_id);
    fixture.wait_state("queued Designer must launch after first confirmed exit", |state| {
        state.executions[&second.id].lifecycle == ExecutionLifecycle::Running
    });
    assert!(fixture.persisted().executions[&first.id].shutdown_confirmed);
    fixture.finish(second);
    let completed = fixture.persisted();
    for record in &designers {
        assert_eq!(completed.executions[&record.id].lifecycle, ExecutionLifecycle::Completed);
        assert_eq!(completed.executions[&record.id].candidate, record.candidate);
        assert_eq!(completed.executions[&record.id].outputs, record.outputs);
        assert_eq!(
            completed
                .occurrences
                .values()
                .filter(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&record.id))
                .count(),
            1
        );
    }
    assert_eq!(shared_exact_designers(&fixture).len(), 2);
}

#[test]
fn shared_exact_automatic_scheduling_waits_for_publisher_exit() {
    let fixture = Fixture::new();
    let created = fixture.create_with(&shared_exact_definition(false), 1, &["checker", "synthesis", "brief", "designer"], false);
    let brief = created.executions.iter().find(|record| record.candidate.step_key == "brief").unwrap();
    fixture.start(brief);
    fixture.finish(brief);
    let mut handled = std::collections::BTreeSet::new();
    for key in ["checker", "synthesis"] {
        let publisher = created.executions.iter().find(|record| record.candidate.step_key == key).unwrap();
        fixture.start(publisher);
        fixture.accept(publisher);
        let finishing = fixture.persisted();
        let request = finishing
            .occurrences
            .values()
            .find(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&publisher.id))
            .unwrap();
        assert!(!finishing
            .executions
            .values()
            .any(|record| record.candidate.step_key == "designer" && record.candidate.inputs["request.md"].contains(&request.id)));
        fixture.release(&publisher.owner_session_id);
        fixture.wait_state(
            &format!(
                "request {} from {} must automatically launch its own Designer after publisher exit",
                request.id, publisher.id
            ),
            |state| {
                state.executions.values().any(|record| {
                    record.candidate.step_key == "designer" && record.candidate.inputs["request.md"] == vec![request.id.clone()] && record.lifecycle == ExecutionLifecycle::Running
                })
            },
        );
        let state = fixture.persisted();
        let designer = state
            .executions
            .values()
            .find(|record| record.candidate.step_key == "designer" && record.candidate.inputs["request.md"] == vec![request.id.clone()])
            .unwrap();
        assert!(state.executions[&publisher.id].shutdown_confirmed);
        assert!(handled.insert(designer.id.clone()));
        // Automatic delivery starts the terminal Designer, but does not finish it.
        wait(|| fixture.root.join(format!("token-{}", designer.owner_session_id)).exists());
        fixture.outputs(designer);
        assert_eq!(fixture.event(&designer.owner_session_id)["completion"]["status"], "ready");
        fixture.assert_terminal_ready(designer);
        // Explicitly retire this owner so the next publisher can use capacity.
        fixture.finish(designer);
    }
    assert_eq!(
        shared_exact_designers(&fixture)
            .iter()
            .map(|record| record.id.clone())
            .collect::<std::collections::BTreeSet<_>>(),
        handled
    );
}

#[test]
fn shared_exact_coding_continuations_keep_exclusive_owner() {
    for coding in [true, false] {
        let fixture = Fixture::new();
        let brief = shared_exact_publish_requests(&fixture, 2, coding, &["checker", "synthesis", "brief", "designer"]);
        fixture.start(&brief);
        fixture.finish(&brief);
        let designers = shared_exact_designers(&fixture);
        let expected_running = if coding { 1 } else { 2 };
        fixture.wait_state(&format!("coding={coding}: expected {expected_running} Running Designers at capacity two"), |state| {
            state
                .executions
                .values()
                .filter(|record| record.candidate.step_key == "designer" && record.lifecycle == ExecutionLifecycle::Running)
                .count()
                == expected_running
        });
        let state = fixture.persisted();
        let first = designers
            .iter()
            .find(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
            .unwrap();
        let second = designers.iter().find(|record| record.id != first.id).unwrap();
        fixture.accept(first);
        let finishing = fixture.persisted();
        assert_eq!(
            finishing.executions[&second.id].lifecycle,
            if coding { ExecutionLifecycle::Queued } else { ExecutionLifecycle::Running }
        );
        assert_eq!(finishing.executions.values().filter(|record| record.lifecycle.holds_capacity()).count(), expected_running);
        if coding {
            assert_eq!(fixture.start(second).start, "queued");
            assert!(!fixture.root.join(format!("token-{}", second.owner_session_id)).exists());
        }
        fixture.release(&first.owner_session_id);
        fixture.wait_state("first Designer must confirm exit", |state| {
            state.executions[&first.id].lifecycle == ExecutionLifecycle::Completed
        });
        fixture.wait_state("second Designer must run with capacity available", |state| {
            state.executions[&second.id].lifecycle == ExecutionLifecycle::Running
        });
        fixture.finish(second);
    }
}

#[test]
fn shared_exact_manual_selection_requires_one_binding() {
    let fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 2, false, &["checker", "synthesis", "brief", "designer"]);
    fixture.start(&brief);
    fixture.finish(&brief);
    let designers = shared_exact_designers(&fixture);
    fixture.wait_state("both noncoding Designers must run before manual selection", |state| {
        designers.iter().all(|record| state.executions[&record.id].lifecycle == ExecutionLifecycle::Running)
    });
    let before = fixture.persisted();
    assert!(fixture.client.create_execution_session(&shared_exact_manual_request(None)).is_err());
    let after = fixture.persisted();
    assert_eq!(
        after.executions.keys().collect::<Vec<_>>(),
        before.executions.keys().collect::<Vec<_>>(),
        "ambiguous selection must not reserve another binding"
    );
    for (id, previous) in &before.executions {
        let current = &after.executions[id];
        assert_eq!(
            (
                &current.binding_key,
                &current.candidate,
                &current.owner_session_id,
                &current.previous_session_ids,
                &current.outputs,
                &current.receipt_id,
                &current.lifecycle,
                current.shutdown_confirmed
            ),
            (
                &previous.binding_key,
                &previous.candidate,
                &previous.owner_session_id,
                &previous.previous_session_ids,
                &previous.outputs,
                &previous.receipt_id,
                &previous.lifecycle,
                previous.shutdown_confirmed
            ),
            "ambiguous selection changed existing binding, ownership, history or acceptance",
        );
    }
    assert_eq!(after.occurrences, before.occurrences);
    let mut selected = Vec::new();
    for designer in &designers {
        let manual = fixture
            .client
            .create_execution_session(&shared_exact_manual_request(Some(designer)))
            .unwrap()
            .execution
            .unwrap();
        assert!(manual.candidate.manual);
        assert_eq!(manual.candidate.inputs, designer.candidate.inputs);
        assert_ne!(manual.id, designer.id);
        assert_ne!(manual.outputs, designer.outputs);
        assert_eq!(manual.lifecycle, ExecutionLifecycle::Queued);
        assert!(!manual.start_requested);
        selected.push(manual);
    }
    assert_ne!(selected[0].outputs, selected[1].outputs);
    for designer in &designers {
        fixture.finish(designer);
    }
    for manual in &selected {
        assert_eq!(fixture.start(manual).start, "started");
        fixture.finish(manual);
    }
    let completed = fixture.persisted();
    for designer in &designers {
        assert_eq!(completed.executions[&designer.id].candidate, designer.candidate);
        assert_eq!(completed.executions[&designer.id].outputs, designer.outputs);
    }
}

#[test]
fn shared_exact_queued_manual_bindings_survive_quiescent_restart() {
    let mut fixture = Fixture::new();
    let brief = shared_exact_publish_requests(&fixture, 2, false, &["checker", "synthesis", "brief", "designer"]);
    fixture.start(&brief);
    fixture.finish(&brief);
    let designers = shared_exact_designers(&fixture);
    for designer in &designers {
        fixture.finish(designer);
    }
    // There is no hold API for ordinary nonroot starts. Explicit Primary
    // start:false creates real durable shared bindings without changing policy.
    let queued: Vec<_> = designers
        .iter()
        .map(|designer| {
            fixture
                .client
                .create_execution_session(&shared_exact_manual_request(Some(designer)))
                .unwrap()
                .execution
                .unwrap()
        })
        .collect();
    let before = fixture.persisted();
    fixture.restart_quiescent();
    let reloaded = fixture.persisted();
    assert_eq!(reloaded.executions, before.executions);
    assert_eq!(reloaded.occurrences, before.occurrences);
    for record in &queued {
        assert_eq!(reloaded.executions[&record.id], *record);
        assert_eq!(fixture.start(record).start, "started");
        fixture.finish(record);
    }
    let completed = fixture.persisted();
    assert_eq!(completed.executions.len(), before.executions.len());
    for record in &queued {
        let current = &completed.executions[&record.id];
        assert_eq!(current.lifecycle, ExecutionLifecycle::Completed);
        assert!(current.shutdown_confirmed);
        assert_eq!(current.owner_session_id, record.owner_session_id);
        assert_eq!(current.binding_key, record.binding_key);
        assert_eq!(current.candidate.inputs, record.candidate.inputs);
        assert_eq!(current.outputs, record.outputs);
        assert_eq!(
            completed
                .occurrences
                .values()
                .filter(|occurrence| occurrence.producer_execution_id.as_deref() == Some(&record.id))
                .count(),
            1
        );
    }
}

#[test]
fn recovery_stop_and_restart_preserve_binding_without_publishing() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    for root in &created.executions {
        fixture.start(root);
        fixture.wait_state("root running", |s| s.executions[&root.id].lifecycle == ExecutionLifecycle::Running);
        fixture.finish(root);
    }
    fixture.wait_state("join bound", |s| s.executions.values().any(|r| r.candidate.step_key == "join"));
    let bound = fixture.persisted();
    let first = bound.executions.values().find(|r| r.candidate.step_key == "join").unwrap();
    assert!(!first.candidate.inputs.is_empty());
    fixture.wait_state("owner running", |s| s.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    let stopped = human_control(&fixture, "stop_execution", prepare_human_end(&fixture, first));
    assert_eq!(stopped["result"]["shutdown_confirmed"], true, "{stopped}");
    let extra = "Preserve the review constraints and inspect both assigned inputs.";
    let handoff = created.executions[0].outputs[0].relative_path.clone();
    let configured = fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: first.candidate.step_key.clone(),
                execution_id: Some(first.id.clone()),
                input_occurrence_ids: None,
            },
            launch_override: None,
            prompt_extra: Some(extra.into()),
            handoff_artifact: Some(handoff.clone()),
            start: true,
        })
        .unwrap();
    let first = configured.execution.as_ref().unwrap();
    fixture.wait_state("configured owner running", |s| s.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    fixture.outputs(first);
    let request = prepare_human_end(&fixture, first);
    let stopped = human_control(&fixture, "stop_execution", request.clone());
    assert_eq!(stopped["result"]["shutdown_confirmed"], true, "{stopped}");
    let state = fixture.persisted();
    assert!(state.executions[&first.id].receipt_id.is_none());
    assert!(!state.occurrences.values().any(|o| o.producer_execution_id.as_deref() == Some(&first.id)));
    let restarted = human_control(&fixture, "restart_execution", request.clone());
    let replacement: CreateExecutionSessionReply = serde_json::from_value(restarted["result"].clone()).unwrap();
    assert_ne!(replacement.session.id, first.owner_session_id);
    assert_eq!(replacement.session.prompt_extra, extra);
    assert_eq!(replacement.session.handoff_artifact, handoff);
    wait(|| fixture.root.join(format!("token-{}", replacement.session.id)).is_file());
    fixture.bind(&replacement.session.id);
    let seed = fs::read_to_string(fixture.root.join(format!("seed-input-{}", replacement.session.id))).unwrap();
    assert!(seed.contains(extra), "replacement process must receive the retained extra instructions");
    let record = replacement.execution.unwrap();
    assert_eq!(record.candidate.inputs, first.candidate.inputs);
    assert_eq!(record.outputs, first.outputs);
    assert!(record.receipt_id.is_none());
    assert!(human_control(&fixture, "stop_execution", request)["error"].is_string());
}

#[test]
fn recovery_supplied_artifacts_validate_before_stop_and_publish_normally() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("owner running", |s| s.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    let request = prepare_human_end(&fixture, first);
    let output = &first.outputs[0].relative_path;
    let before = fixture.persisted();
    for (path, content) in [(output.as_str(), " \n "), ("../escape.md", "outside"), ("unassigned.md", "unassigned")] {
        let result = human_control_message(
            &fixture,
            json!({"op":"submit_execution_artifacts","request":request,"artifacts":[{"relative_path":path,"content":content}]}),
        );
        assert_eq!(result["result"]["status"], "invalid_outputs", "{result}");
        assert_eq!(fixture.persisted(), before, "invalid input cannot stop or mutate execution");
    }
    let artifacts: Vec<_> = first
        .outputs
        .iter()
        .map(|a| json!({"relative_path":a.relative_path,"content":"Human supplied recovery artifact"}))
        .collect();
    let preview = human_control_message(&fixture, json!({"op":"preview_execution_artifacts","request":request,"artifacts":artifacts}));
    assert_eq!(preview["result"]["diagnostics"], json!([]), "{preview}");
    assert!(!fixture.root.join(".alinery/tasks/fixture/artifacts").join(output).exists());
    assert_eq!(fixture.persisted(), before, "preview is read-only");
    let result = human_control_message(&fixture, json!({"op":"submit_execution_artifacts","request":request,"artifacts":artifacts}));
    assert_eq!(result["result"]["status"], "accepted", "{result}");
    let state = fixture.persisted();
    assert!(state.executions[&first.id].shutdown_confirmed);
    assert!(state.executions[&first.id].receipt_id.is_some());
    assert!(state
        .occurrences
        .values()
        .any(|o| &o.relative_path == output && o.producer_execution_id.as_deref() == Some(&first.id)));
    assert!(human_control(&fixture, "restart_execution", request.clone())["error"].is_string());
    assert!(human_control_message(&fixture, json!({"op":"submit_execution_artifacts","request":request,"artifacts":artifacts}))["error"].is_string());
}

#[test]
fn recovery_restart_without_optional_handoff_starts_fresh_owner() {
    let fixture = Fixture::new();
    let created = fixture.create(false, false);
    let first = created.executions.iter().find(|record| record.candidate.step_key == "first").unwrap();
    fixture.start(first);
    fixture.wait_state("default owner running", |state| state.executions[&first.id].lifecycle == ExecutionLifecycle::Running);
    let request = prepare_human_end(&fixture, first);
    let restarted = human_control(&fixture, "restart_execution", request);
    let replacement: CreateExecutionSessionReply = serde_json::from_value(restarted["result"].clone()).unwrap();
    assert_ne!(replacement.session.id, first.owner_session_id);
    let record = replacement.execution.unwrap();
    assert_eq!(record.outputs, first.outputs);
    assert!(record.receipt_id.is_none());
    fixture.wait_state("default replacement running", |state| {
        state.executions[&first.id].owner_session_id == replacement.session.id && state.executions[&first.id].lifecycle == ExecutionLifecycle::Running
    });
    wait(|| fixture.root.join(format!("token-{}", replacement.session.id)).is_file());
    fixture.bind(&replacement.session.id);
}

#[test]
fn stopped_owner_dev_prod_dev_preserves_task_history_and_queue_policy() {
    let mut fixture = Fixture::new();
    fixture.stop();
    fixture.spawn_lane("dev", "dev.toml");
    wait(|| fixture.client.version_checked().is_ok());
    let created = fixture.create(false, false);
    let completed = created.executions.iter().find(|r| r.candidate.step_key == "first").unwrap();
    let uncertain = created.executions.iter().find(|r| r.candidate.step_key == "second").unwrap();
    fixture.start(completed);
    fixture.finish(completed);
    fixture.start(uncertain);
    fixture.accept(uncertain);
    let queued = fixture.create_named("queued");
    let archived = fixture.create_named("archived");
    alinery_core::archive_task_guarded(&fixture.root, "archived").unwrap();
    let before = fixture.persisted();
    let artifact = fixture.root.join(".alinery/tasks/fixture/artifacts").join(&completed.outputs[0].relative_path);
    let artifact_bytes = fs::read(&artifact).unwrap();
    let scrollback = alinery_core::session_scrollback_path(&fixture.root, "fixture", &completed.owner_session_id);
    // The RPC shell fixture does not produce terminal scrollback. Seed retained
    // terminal evidence for this completed historical session before switching.
    let scrollback_bytes = b"retained terminal output\r\n\x1b[32mcompleted\x1b[0m\r\n".to_vec();
    fs::write(&scrollback, &scrollback_bytes).unwrap();
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    fixture.release(&uncertain.owner_session_id);
    // Persist the same durable request used by start_session, while no daemon
    // can race scheduling. The other root deliberately remains unrequested.
    for (slug, record) in [("queued", &queued.executions[0]), ("archived", &archived.executions[0])] {
        alinery_core::with_task_mutation_lock_waiting(&fixture.root, "fixture queued request", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
            let mut state = read_execution_state(&fixture.root, slug)?;
            alinery_core::execution::request_execution_start(&mut state, &record.id)?;
            alinery_core::execution::write_execution_state_unlocked(&fixture.root, slug, &mut state)
        })
        .unwrap();
    }
    for (lane, config) in [("", "production.toml"), ("dev", "dev.toml")] {
        fixture.spawn_lane(lane, config);
        wait(|| fixture.client.version_checked().is_ok());
        for slug in ["fixture", "queued", "archived"] {
            let state = fixture.client.get_task_execution(&GetTaskExecutionRequest { task_slug: slug.into() }).unwrap().state;
            assert_eq!(state.owning_lane, lane);
            assert_eq!(state.owning_app_config_identity, alinery_core::app_config_identity(&fixture.root.join(config)));
        }
        let state = fixture.persisted();
        assert_eq!(state.executions[&completed.id], before.executions[&completed.id]);
        assert_eq!(state.executions[&uncertain.id].receipt_id, before.executions[&uncertain.id].receipt_id);
        assert_eq!(state.executions[&uncertain.id].lifecycle, ExecutionLifecycle::Interrupted);
        assert!(!state.executions[&uncertain.id].shutdown_confirmed);
        assert_eq!(state.executions[&uncertain.id].owner_session_id, uncertain.owner_session_id);
        assert_eq!(state.occurrences, before.occurrences);
        assert_eq!(fs::read(&artifact).unwrap(), artifact_bytes);
        assert_eq!(fs::read(&scrollback).unwrap(), scrollback_bytes);
        for record in &archived.executions {
            let state = read_execution_state(&fixture.root, "archived").unwrap();
            assert_eq!(state.executions[&record.id].lifecycle, ExecutionLifecycle::Queued);
            assert!(!fixture.root.join(format!("token-{}", record.owner_session_id)).exists());
        }
        assert!(alinery_core::read_task(&fixture.root, "archived").unwrap().archived);
        let held = &queued.executions[1];
        let queued_state = read_execution_state(&fixture.root, "queued").unwrap();
        assert!(!queued_state.executions[&held.id].start_requested);
        assert_eq!(queued_state.executions[&held.id].lifecycle, ExecutionLifecycle::Queued);
        assert!(!fixture.root.join(format!("token-{}", held.owner_session_id)).exists());
        if lane.is_empty() {
            let requested = &queued.executions[0];
            // The runner writes the token as soon as the child starts. Lifecycle
            // stays Starting until the parent records the spawn, so the token
            // can exist first under a loaded run.
            wait(|| {
                let state = read_execution_state(&fixture.root, "queued").unwrap();
                let starting = state.executions[&requested.id].lifecycle == ExecutionLifecycle::Starting;
                fixture.root.join(format!("token-{}", requested.owner_session_id)).exists() && !starting
            });
            assert_eq!(
                read_execution_state(&fixture.root, "queued").unwrap().executions[&requested.id].lifecycle,
                ExecutionLifecycle::Running
            );
            let meta = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "queued", &requested.owner_session_id)).unwrap();
            assert_eq!(meta.daemon_namespace, lane);
        }
        fixture.stop();
    }
    let historical = alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "fixture", &completed.owner_session_id)).unwrap();
    assert_eq!(historical.daemon_namespace, "dev");
}

#[test]
fn new_owner_routes_new_sessions_but_rejects_foreign_history() {
    let mut fixture = Fixture::new();
    let created = fixture.create(false, true);
    let uncertain = &created.executions[0];
    fixture.start(uncertain);
    fixture.accept(uncertain);
    let targets = || {
        [
            ExecutionSessionTarget::Auxiliary {
                harness: "omp".into(),
                model: None,
                prompt: None,
            },
            ExecutionSessionTarget::SubtaskManager {
                subtask_slug: None,
                recover: false,
                harness: "omp".into(),
                model: None,
            },
        ]
    };
    let mut historical = Vec::new();
    for target in targets() {
        let reply = fixture
            .client
            .create_execution_session(&CreateExecutionSessionRequest {
                task_slug: "fixture".into(),
                target,
                launch_override: None,
                prompt_extra: None,
                handoff_artifact: None,
                start: true,
            })
            .unwrap();
        assert_eq!(reply.start, "started");
        wait(|| fixture.root.join(format!("token-{}", reply.session.id)).exists());
        fixture.release(&reply.session.id);
        wait(|| {
            alinery_core::read_session_meta_full(&alinery_core::session_meta_path(&fixture.root, "fixture", &reply.session.id))
                .unwrap()
                .ended_at
                .is_some()
        });
        historical.push(reply.session.id);
    }
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    fixture.release(&uncertain.owner_session_id);
    historical.push(uncertain.owner_session_id.clone());
    let metadata: Vec<Value> = historical
        .iter()
        .map(|id| {
            let mut value: Value = serde_json::from_slice(&fs::read(alinery_core::session_meta_path(&fixture.root, "fixture", id)).unwrap()).unwrap();
            // Observation projects the current execution revision; it is not
            // historical identity or completion evidence.
            value.as_object_mut().unwrap().remove("execution_revision");
            value
        })
        .collect();
    fixture.spawn_lane("dev", "dev.toml");
    wait(|| fixture.client.version_checked().is_ok());
    assert_eq!(fixture.state().state.owning_lane, "dev");
    for (id, before) in historical.iter().zip(metadata) {
        assert!(fixture
            .client
            .start_session(&StartSessionRequest {
                task_slug: "fixture".into(),
                session_id: id.clone()
            })
            .is_err());
        let mut after: Value = serde_json::from_slice(&fs::read(alinery_core::session_meta_path(&fixture.root, "fixture", id)).unwrap()).unwrap();
        after.as_object_mut().unwrap().remove("execution_revision");
        assert_eq!(after, before);
    }
    assert!(fixture
        .client
        .create_execution_session(&CreateExecutionSessionRequest {
            task_slug: "fixture".into(),
            target: ExecutionSessionTarget::Primary {
                step_key: uncertain.candidate.step_key.clone(),
                execution_id: Some(uncertain.id.clone()),
                input_occurrence_ids: None
            },
            launch_override: None,
            prompt_extra: None,
            handoff_artifact: None,
            start: false,
        })
        .is_err());
    for target in targets() {
        let reply = fixture
            .client
            .create_execution_session(&CreateExecutionSessionRequest {
                task_slug: "fixture".into(),
                target,
                launch_override: None,
                prompt_extra: None,
                handoff_artifact: None,
                start: true,
            })
            .unwrap();
        assert_eq!(reply.start, "started");
        assert_eq!(reply.session.daemon_namespace, "dev");
        assert!(!historical.contains(&reply.session.id));
        wait(|| fixture.root.join(format!("token-{}", reply.session.id)).exists());
    }
}

#[test]
fn adoption_failure_precedes_socket_bind_and_scheduler_start() {
    let mut fixture = Fixture::new();
    let created = fixture.create(false, true);
    fixture.stop();
    let record = &created.executions[0];
    alinery_core::with_task_mutation_lock_waiting(&fixture.root, "fixture queued request", alinery_core::TASK_MUTATION_CONTENTION_WAIT, || {
        let mut state = fixture.persisted();
        alinery_core::execution::request_execution_start(&mut state, &record.id)?;
        alinery_core::execution::write_execution_state_unlocked(&fixture.root, "fixture", &mut state)
    })
    .unwrap();
    let execution = alinery_core::execution::execution_state_path(&fixture.root, "fixture").unwrap();
    let before = fs::read(&execution).unwrap();
    let playbook = fixture.root.join(".alinery/tasks/fixture/playbook.md");
    let valid = fs::read(&playbook).unwrap();
    fs::write(&playbook, "invalid retained definition").unwrap();
    fixture.spawn_lane("dev", "dev.toml");
    wait(|| fixture.child.try_wait().unwrap().is_some());
    assert!(!fixture.child.wait().unwrap().success());
    assert!(!fixture.client.socket_path.exists());
    assert!(!fixture.root.join(format!("token-{}", record.owner_session_id)).exists());
    assert_eq!(fs::read(&execution).unwrap(), before);
    fs::write(&playbook, valid).unwrap();
    fixture.spawn_lane("dev", "dev.toml");
    wait(|| fixture.client.version_checked().is_ok());
    // Same token/Starting race as the owner-switch test above.
    wait(|| {
        let starting = fixture.persisted().executions[&record.id].lifecycle == ExecutionLifecycle::Starting;
        fixture.root.join(format!("token-{}", record.owner_session_id)).exists() && !starting
    });
    assert_eq!(fixture.persisted().owning_lane, "dev");
    assert_eq!(fixture.persisted().executions[&record.id].lifecycle, ExecutionLifecycle::Running);
}

#[test]
fn compatible_build_drift_preserves_live_session_without_takeover() {
    let fixture = Fixture::new();
    let created = fixture.create(false, true);
    let record = &created.executions[0];
    fixture.start(record);
    wait(|| fixture.root.join(format!("token-{}", record.owner_session_id)).exists());
    let version = fixture.client.version_checked().unwrap();
    let expected_identity = alinery_core::app_config_identity(&fixture.root.join("app.toml"));
    let different_build = format!("{:?}-different", version.build_id);
    assert_eq!(
        alinery_core::daemon_client::observe_compatible(&fixture.client.socket_path, &different_build, &expected_identity).unwrap(),
        alinery_core::DaemonCompat::BuildDrift,
    );
    let (connected, compatibility) = alinery_core::daemon_client::ensure_compatible_daemon(&fixture.root, &fixture.root.join("app.toml"), None).unwrap();
    assert!(compatibility.usable());
    assert_eq!(connected.version_checked().unwrap().build_id, version.build_id);
    let state = connected.get_task_execution(&GetTaskExecutionRequest { task_slug: "fixture".into() }).unwrap().state;
    assert_eq!(state.executions[&record.id].lifecycle, ExecutionLifecycle::Running);
    assert_eq!(state.executions[&record.id].owner_session_id, record.owner_session_id);
    fixture.finish(record);
}
