# SQLite storage decision and implementation guidance

2026-09-04 — discussion record for [DEL-629](https://linear.app/delegance/issue/DEL-629), within [DEL-624](https://linear.app/delegance/issue/DEL-624), preserved on [PR #237](https://github.com/DeleganceAI/saga/pull/237).

**Decision: use SQLite for the local Playbook engine's authoritative logical records.** This is the accepted answer to Q40 and supersedes the earlier deferral of the database choice. The user selected SQLite after discussing alternatives, Rust integration, multiple repository daemons, WAL, and a hypothetical 1,000 concurrent Sessions.

This is a consolidated discussion summary, not a verbatim transcript or an implementation report. SQLite is selected; the recommendations below preserve the reasoning without silently approving a particular schema, Rust crate, database partition, durability setting, or recovery protocol. No 1,000-Session capacity has been demonstrated.

## 1. Scope and information to store

All execution and storage in this design are local. “Local” does not necessarily mean “embedded”: a database could run as a separate process on the same machine. SQLite is embedded, avoiding a separate database service.

The storage choice must support the whole logical model, not just snapshots:

| Logical responsibility | Information relevant to storage |
| --- | --- |
| State | Immutable repository Git tree identity and the complete artifact manifest, mapping logical paths to content hashes. |
| Step Execution | One Step application carried out through one or more sequential Sessions; its engine-assigned binding, full source-State set, Session links, chosen source commit references, lifecycle, and accepted result/final commit reference. Explicit retries link to failed Executions. |
| Transition | One source-to-result relationship within an accepted Execution. Multiple source States produce multiple Transitions referencing the same merge Execution and result. |
| Claims and Task controls | Engine-owned handled/claimed work, Task ownership, rerun policy, limits, and progression information, outside material State identity. |

These are logical responsibilities, not a requirement for exactly four tables. SQLite does not decide the remaining provenance, claim-key, source-selection, or complete-set association rules for us.

State hashing remains independent of database layout: hash material, not parents, Execution IDs, Git commit metadata, Sessions, or claims. Identical material may reuse the same State while retaining distinct accepted operations. The material graph can contain cycles and self-loops. Complete canonical manifests remain the agreed representation; deduplicate file bytes by content hash and add manifest structural sharing only if size becomes a measured problem.

The discussed storage split is SQLite for logical authority, Git for repository material, and filesystem content-addressed storage for artifact bytes. This avoids putting potentially large workspace contents into database rows. Exact paths and publication mechanics remain to be specified.

## 2. What “SQLite runs inside the application process” means

The application links a database library. A database call executes through that library in the calling process and reads or writes local files; it is not a request to a separately installed database server. An Alinery daemon can own SQLite connections without becoming a Redis- or PostgreSQL-style database service. Disk-backed data does not disappear when that daemon exits. [SQLite's serverless explanation](https://www.sqlite.org/serverless.html)

Different local processes can open their own connections to the same database file. They do not share a Rust connection object: SQLite coordinates file access. A thousand agent Sessions do not require a thousand database connections; the engine can keep a small bounded set of daemon-owned connections.

## 3. Why SQLite fits, and what it costs

### Benefits discussed

- **Local deployment simplicity.** No additional service, port, authentication setup, or database-process supervision just to persist local engine records.
- **Transactions across related records.** The accepted result, Execution metadata, Transitions, and related claim changes can be committed atomically within one database transaction instead of coordinating a collection of independent metadata files. The precise transaction boundary still needs design. [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- **Relational querying and constraints.** SQL joins and database constraints fit questions about Tasks, Executions, source/result relationships, and claim ownership. Foreign-key enforcement and uniqueness constraints must actually be configured and modeled; they are not automatic domain correctness. [SQLite constraints](https://www.sqlite.org/lang_createtable.html), [foreign keys](https://www.sqlite.org/foreignkeys.html)
- **The graph does not require a graph database.** Nodes and edges can be stored relationally; recursive SQL can traverse relationships. Queries must account for the cycles our State model permits. JSON support is also available where a nested value is useful, without turning every relationship into an opaque document. [Recursive graph queries](https://www.sqlite.org/lang_with.html#queries_against_a_graph), [JSON support](https://www.sqlite.org/json1.html)
- **Direct Rust integration.** Existing Rust libraries provide conventional SQLite access; a bundled build can avoid depending on the operating system's SQLite version.

### Costs and limits discussed

- **One writer per database file.** Many readers are possible, but simultaneous write transactions serialize. Short writes and deliberate contention handling matter more than the count of live agent Sessions. [Appropriate uses and concurrency limits](https://www.sqlite.org/whentouse.html)
- **Schema and indexes still require care.** SQL does not eliminate schema evolution, expensive queries, or application-specific provenance design. Large complete manifests may make acceptance more expensive than a tiny metadata update.
- **Cross-store consistency remains our responsibility.** A SQLite transaction does not atomically commit arbitrary artifact files or Git objects alongside its rows.
- **Backup and durability need an explicit policy.** A live WAL database is not safely backed up by blindly copying only its main file. Power-loss durability also depends on synchronization settings and the storage stack. [SQLite backup API](https://www.sqlite.org/backup.html), [synchronous setting](https://www.sqlite.org/pragma.html#pragma_synchronous)

None of these limits establishes that another database is needed for the proposed workload. They identify what implementation and verification must cover.

## 4. Alternatives and the Redis discussion

Data model and deployment model are separate axes. A document, key/value, or graph-capable engine can be embedded; a relational engine can require a separate server. Local-only scope rules out a requirement for a remote service, not every local service process.

| Approach discussed | Attraction | Tradeoff for this engine |
| --- | --- | --- |
| Embedded relational SQLite | Transactions, relationships, constraints, SQL queries, and simple local packaging. | Serialized writers; explicit schema and cross-store publication design. |
| Embedded document storage | Convenient nested manifests and varied Execution metadata. | Cross-record ownership, provenance, and claims still need relationships, indexes, and transactional semantics. |
| Embedded graph-capable storage | Expressive relationship traversal and recursive queries. | Another engine/query model to integrate; graph-shaped data alone does not justify it. |
| Embedded key/value storage | Simple primitives and potentially transactional batches. | More application-owned secondary indexes, joins, and consistency rules. |
| Plain files | Familiar, inspectable, and close to existing persistence. | Multi-record atomicity, query indexes, locking, and recovery become more engine-owned work. |
| Local server databases, including Redis | Can remain entirely on the user's machine. | Add service lifecycle and deployment concerns; evaluate each engine's persistence and transaction semantics rather than assuming equivalence. |

Redis was not dismissed as “only a cache.” It can persist primary data, supports useful structures and querying, and provides atomic claim-like operations such as `SET ... NX`. It normally runs as a separate process, even on localhost. [Redis CLI/client-server model](https://redis.io/docs/latest/develop/tools/cli/), [SET](https://redis.io/docs/latest/commands/set/), [query support](https://redis.io/docs/latest/develop/ai/search-and-query/)

Its tradeoffs need care for authoritative engine records:

- Snapshot and append-only persistence have different loss windows and costs; the usual once-per-second AOF synchronization can lose roughly the latest second on a crash. More aggressive synchronization changes that tradeoff. [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- `MULTI`/`EXEC` prevents other clients' commands from interleaving with the transaction, but a command that fails during execution does not roll back earlier successful commands. Lua's atomic execution likewise should not be confused with automatic rollback. [Redis transactions](https://redis.io/docs/latest/develop/using-commands/transactions/)
- Authoritative records must not accidentally expire or be evicted. A no-eviction policy avoids eviction but can reject writes that need more memory. [Redis eviction behavior](https://redis.io/docs/latest/develop/reference/eviction/)

The conclusion was that SQLite's deployment and transactional model are the simpler fit here, not that Redis cannot work. No second database, Redis cache, dual-write layer, or generic database abstraction is requested.

## 5. Rust integration

Two established options discussed were:

- **rusqlite:** synchronous SQLite access. Its `bundled` feature builds and links SQLite rather than relying on the system library. This was the provisional preference given the existing daemon's largely synchronous/threaded architecture. [rusqlite](https://github.com/rusqlite/rusqlite)
- **SQLx:** asynchronous database APIs with optional compile-time SQL checking and SQLite support through the SQLite C library. It is an alternative if the surrounding implementation benefits from that model, not a reason by itself to redesign the daemon around async. [SQLx](https://github.com/transact-rs/sqlx)

**SQLite is selected; the Rust library and version are not.** No dependency was installed during this discussion.

## 6. Multiple repos and database ownership

Several repository daemons can technically access one shared SQLite file on the same machine. WAL does not require one application process. A global database makes cross-repository queries and transactions within that database convenient, but all repositories then share its writer and database lifecycle.

The provisional recommendation was **one database per existing Alinery repository/data root**, managed through that repository's daemon. This separates writer contention and aligns persistence with existing ownership. It is not one database per Task, Session, State, or task worktree.

The ownership nuance matters: Alinery-created task worktrees belong to their original repository/data root. Independently registered Git worktrees currently have their own configured roots. Do not silently identify all checkouts of the same Git remote or common Git directory as one Alinery database scope.

Per-repository storage makes global views aggregate across databases; it does not provide an atomic cross-database publication protocol. In WAL mode, transactions involving attached databases are atomic for each individual database, not for the attached set as a whole. [WAL limitations](https://www.sqlite.org/wal.html)

**Partitioning remains a recommendation, not a separately locked decision.** It must preserve Task-scoped controls and must not alter State hashes.

## 7. WAL, crashes, and content-addressed bytes

WAL means **write-ahead logging**. In this mode, SQLite appends committed changes to a log before later copying them into the main database through a checkpoint. Readers see consistent snapshots while a writer can continue. A reader may need both the main file and committed WAL content; the main file alone may not contain the latest committed data. [SQLite WAL](https://www.sqlite.org/wal.html)

The usual files are the main database, its `-wal` companion, and a `-shm` shared-memory index. They are SQLite-managed internals, not three independent sources of truth or files the engine should casually delete. WAL still permits only one writer at a time and requires processes using it to be on the same host; a network filesystem is not the intended deployment.

Operational guidance:

- Keep transactions short. Never hold a write transaction for the lifetime of an agent Session, Git operation, or blob-hashing pass.
- Handle `SQLITE_BUSY` and write bursts deliberately with bounded waiting/retry and backpressure; contention is not inherently corruption.
- Avoid long-lived read transactions that prevent checkpoint completion and cause WAL growth.
- Choose synchronization settings deliberately. Recovery after a process crash and durability through abrupt power loss are related but different requirements.
- Use a supported consistent database-backup mechanism, then coordinate retention/backup of the Git and blob material its records reference. A database backup alone is not a complete Task backup.

The earlier publication recommendation remains relevant: prepare and durably retain blob/Git material first, then commit the corresponding accepted logical result in SQLite. Under a correctly implemented protocol, interruption before the database commit may leave unreferenced material rather than an accepted State pointing to unfinished material. Exact ordering, synchronization, Git retention, writer fencing, idempotency, orphan handling, and recovery are **not yet an adopted complete protocol**.

Content hashes detect byte mismatches against trusted expected hashes. They do not prevent deletion or corruption, make filesystem and database writes atomic, prove that an agent's output is correct, or establish integrity if both bytes and their expected hashes can be maliciously replaced.

## 8. Capacity thought experiment: 100 Tasks and 1,000 Sessions

The user proposed 100 Tasks, each with up to 10 concurrent agent Sessions, spread over three repos. Sessions last at least five seconds and more often minutes or hours.

**Session count is not database transaction count.** An agent can work for an hour without holding a database transaction open. The current terminal-output path and engine lifecycle records are different concerns; deciding to persist every output chunk would create a very different workload.

For illustration only, assume full occupancy, continuous replacement of finished Sessions, even distribution across three per-repo databases, and exactly two short metadata transactions per Session lifecycle: one startup and one finish. With mean duration `D` seconds, total finishes per second are `1000 / D`, and transactions per second per database are `2000 / (3D)`.

| Mean Session duration | Illustrative transactions/second per repo |
| --- | ---: |
| 5 seconds | 133.3 |
| 1 minute | 11.1 |
| 5 minutes | 2.22 |
| 1 hour | 0.19 |

This is arithmetic, **not measured SQLite throughput**. Session completion is not necessarily accepted Step Execution completion. Claims, correction attempts, retries, progress updates, and acceptance work change the transaction multiplier. Five-second average turnover is the aggressive scenario, not a prediction that all Sessions will finish that quickly.

At 133.3 transactions/second, hypothetical average writer-holding times of 1, 5, and 10 milliseconds imply approximately 13%, 67%, and 133% writer utilization. The last cannot sustain the arrival rate; utilization below 100% alone does not establish acceptable latency. These timings are examples, not benchmarks.

What needs attention:

- **Transaction duration and manifest size:** a complete State manifest with 10 entries differs from one with 10,000. Keep slow preparation outside the transaction without weakening the final consistency checks.
- **High-frequency events:** individual commits for tokens, terminal output, or heartbeats can dominate lifecycle writes. Choose recording granularity deliberately rather than assuming the two-transaction example covers everything.
- **Bursts and skew:** hundreds of Sessions may finish together, or most may use one repo. Averages across three databases conceal the hot writer.
- **Whole-application resources:** agent processes, PTYs, reader threads, file descriptors, RAM, terminal processing, Git/filesystem I/O, and UI/status refreshes impose separate limits. Changing databases does not automatically solve them.

The discussion did not establish a 1,000-Session limit or promise support. It concluded that this concurrency target does not by itself disqualify SQLite, particularly when Sessions are long relative to short metadata transactions.

## 9. Implementation handoff and verification boundary

Proceed with SQLite rather than designing interchangeable database backends. Keep the following as implementation work or explicitly unresolved choices, not new product requirements inferred from this note:

1. Select the concrete schema, Rust library, database ownership boundary, and connection strategy.
2. Define canonical State encoding and the general provenance/claim/complete-set model; a database choice does not answer those semantic questions.
3. Specify one crash-consistent acceptance protocol across SQLite, artifacts, and retained Git material, including stale/duplicate requests and interrupted work.
4. Test representative manifests and the intended durability settings under sustained five-second turnover and synchronized completion bursts, including uneven repo load. Measure acceptance latency, write-queue growth, busy errors, WAL growth, and resource usage. Agree service targets before claiming a particular capacity.
5. Exercise interruption and recovery around publication boundaries, and test that backup/restore preserves both logical records and referenced material.

This document preserves the selected database, alternatives, reasoning, and guidance. It does not implement storage, change the existing daemon, approve every recommended default, or claim a completed performance or recovery test.
