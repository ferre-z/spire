# Distributed Agent Execution Design

**Date:** 2026-08-04

**Status:** Approved design

**Target:** Self-hosted Spire deployment per company, from one small server to approximately 100 concurrent agents

## Summary

Spire will move workflow orchestration and harness execution out of the Electron process. Each company will run an always-on, headless coordinator backed by PostgreSQL. Replaceable desktop clients will connect to that coordinator, while worker daemons on one or more machines launch isolated agent containers.

Closing every desktop client must not interrupt a run. A coordinator or network interruption must not lose acknowledged state, and a worker that reconnects must be able to reconcile its still-running containers. The same architecture must run economically on one laptop plus a 2-vCPU, 12-GB server and scale by adding workers to approximately 100 concurrent agents.

OpenCode is the initial production harness because it supports inexpensive testing. Pi is the next planned adapter. JCode remains experimental until its protocol and maintenance stability are sufficient for production use.

## Goals

- Keep runs active when desktop clients close.
- Execute agents on Docker workers spread across multiple machines.
- Make PostgreSQL the authoritative store for workflow and execution state.
- Support approximately 100 concurrent agent attempts across roughly seven large graphs.
- Recover deterministically from coordinator restarts, worker restarts, network partitions, duplicate messages, and stale workers.
- Keep the coordinator independent of OpenCode, Pi, JCode, and future harness implementations.
- Enforce repository, resource, network, and secret policies outside model prompts.
- Provide a low-cost deployment for the current laptop and small server without creating a separate architecture.

## Non-goals

- A multi-tenant Spire cloud in the first release.
- Kubernetes, Redis, NATS, or a distributed SQL database as baseline dependencies.
- Exactly-once container execution. Distributed execution is at least once; authoritative state transitions are idempotent and fenced.
- Running untrusted containers directly on the coordinator host by default.
- Preserving the current SQLite database as an active distributed state store.
- Making JCode a production dependency before it has a stable headless interface and acceptable operational ownership.

## Deployment Model

Each company runs one logically isolated Spire control plane. Its source code, credentials, workflow history, and artifacts remain inside the company's environment. The first release assumes one company per deployment while keeping organization identifiers in externally visible records so a hosted product can be added later without changing protocol identities.

### Scale-to-one profile

The current low-cost installation uses Docker Compose:

- The 2-vCPU, 12-GB server runs the coordinator, PostgreSQL, TLS ingress, and a local artifact store.
- The laptop runs the Electron client and may run a worker daemon when available.
- The small server may also run a worker with a conservative concurrency limit, but coordination and database capacity take priority.
- Worker admission uses advertised CPU, memory, disk, and configured concurrency. It never assumes enterprise-sized hosts.
- The base control-plane target is at most 4 GB of memory excluding agent containers. This is a design budget verified during implementation, not a guarantee about third-party harness usage.

Agent containers primarily call remote model providers, so model inference does not consume local CPU or memory. Repository builds and tests remain the dominant worker-side resource cost.

For the smallest installation, artifacts use a filesystem-backed store on a persistent server volume. This is not container-local ephemeral storage and must be included in backups.

### Enterprise profile

The same coordinator and worker protocol scales by:

- Moving PostgreSQL to a managed or replicated deployment.
- Switching artifacts to S3-compatible object storage.
- Adding heterogeneous worker pools with labels and resource limits.
- Running multiple stateless coordinator replicas behind one ingress.
- Deploying workers through Docker, a future Kubernetes worker adapter, or another container runtime adapter.

No workflow or harness record changes shape between the scale-to-one and enterprise profiles.

## System Modules

### Coordinator

The coordinator is the only module allowed to mutate authoritative workflow state. Its external interfaces are:

- A versioned HTTPS interface for desktop and automation clients.
- A versioned outbound-worker control interface over secure WebSockets.
- A server-sent event stream for live desktop and automation clients.

Its implementation contains graph compilation, scheduling, authorization, attempt leasing, checkpoint handling, recovery, event persistence, and artifact metadata. It does not spawn harness processes or Docker containers.

The coordinator is stateless outside PostgreSQL and the artifact store. Multiple replicas coordinate through database transactions and leases.

### Scheduler

The scheduler is a deep module inside the coordinator. Its interface accepts durable workflow commands and worker reports; it returns state transitions and dispatch decisions. Callers do not manage database locks, retry races, fencing tokens, or graph activation rules.

PostgreSQL is both the state store and initial durable dispatch queue. When a worker requests work, the coordinator claims an eligible attempt for it through transactional row locking using `FOR UPDATE SKIP LOCKED`. `LISTEN/NOTIFY` may reduce claim latency, but notifications are only wake-up hints; database rows remain authoritative. Redis or NATS is introduced only after measurement proves PostgreSQL dispatch is a bottleneck.

### Worker daemon

A worker daemon runs on every execution host. It:

- Enrolls with the coordinator and maintains an outbound authenticated connection.
- Advertises harnesses, labels, capacity, container-runtime features, and current load.
- Claims compatible attempts and renews their leases.
- Creates, supervises, cancels, and cleans up attempt containers.
- Stores a durable local event spool and active-container registry.
- Uploads artifacts and reconciles active attempts after reconnecting.

Workers never connect directly to PostgreSQL. A compromised worker is therefore unable to rewrite arbitrary workflow history.

### Harness runner

The worker-side harness runner is a deep module with this stable interface:

- `probe`: report version, readiness, models, and capabilities.
- `start` or `resume`: launch an attempt from a normalized job envelope.
- `events`: emit ordered normalized session, reasoning, output, tool, usage, warning, and terminal events.
- `cancel`: idempotently request termination.
- `result`: return structured output and produced repository/artifact references.

Adapters hide native process flags, RPC protocols, sessions, and output parsing. OpenCode, Pi, and JCode satisfy the same conformance suite.

OpenCode is the default adapter. Pi follows using its supported headless RPC mode or direct TypeScript session interface. JCode is accepted only behind an experimental worker capability until it exposes a stable headless contract and passes recovery testing.

### Artifact store

The artifact-store interface persists large or streaming data outside PostgreSQL. Its initial adapters are:

- A persistent local-filesystem adapter for the scale-to-one profile.
- An S3-compatible adapter for enterprise deployments.

Logs, patches, test reports, snapshots, and other large outputs are stored as immutable objects. PostgreSQL stores their identities, hashes, sizes, ownership, retention state, and attempt associations. Large payloads never travel through PostgreSQL notifications.

### Repository integration

Workers receive short-lived repository credentials and clone the required committed revision into an attempt volume. Every write-capable attempt uses a unique branch or ref. A successful attempt produces a commit and/or patch whose hash is recorded before the node becomes terminal.

Checkpoint integration validates write scopes and merges committed outputs into the run's integration ref. It never edits the user's source checkout. Git hosting remains authoritative for durable repository history; the artifact store preserves patches and evidence needed for recovery or audit.

## Data Model

PostgreSQL replaces SQLite for distributed control-plane state. Core records include:

- Organizations and users, even though the initial deployment has one organization.
- Graphs, immutable graph versions, compiled plans, plan revisions, and checkpoints.
- Runs, nodes, visits, attempts, outcomes, and failure routes.
- Worker identities, capabilities, capacity, health, and enrollment state.
- Attempt leases containing worker identity, fencing generation, and expiry.
- Harness sessions associated with attempt, harness, and workspace identity.
- Append-only attempt events keyed by `(attempt_id, sequence)`.
- Collaboration messages and durable control commands.
- Repository refs and immutable artifact metadata.
- Audit entries for authorization, plan mutation, cancellation, retry, secret access, and administrative action.

State transitions use explicit expected-state predicates or row versions. A transition that has already occurred returns its recorded result instead of applying twice.

SQLite remains only an import source during migration. A one-time migration command exports and validates existing local records, imports them into PostgreSQL transactionally, and reports records that cannot be converted. There is no ongoing dual-write mode.

## Job Lifecycle

1. The coordinator creates a queued attempt in the same transaction that advances its node.
2. A compatible worker claims the attempt and receives a monotonically increasing fencing generation.
3. The worker creates a named container and a persistent attempt volume.
4. The harness runner starts or resumes the agent using the normalized job envelope.
5. The worker assigns monotonically increasing sequence numbers to native events and appends them to its on-disk spool before transmission.
6. The coordinator inserts events idempotently and acknowledges the highest contiguous sequence persisted.
7. The worker truncates only acknowledged spool entries and renews the attempt lease while healthy.
8. The worker uploads repository outputs and artifacts before reporting a terminal result.
9. The coordinator validates the fencing generation, artifacts, structured outcome, and write scope in one terminal transition.
10. The scheduler offers graph tokens, advances checkpoints, or activates failure routing.

Desktop clients observe this lifecycle but do not participate in it. Closing all clients has no execution effect.

## Failure and Recovery Semantics

Execution is at least once. Durable transitions and outputs are idempotent, and fencing ensures only the current owner can finalize an attempt.

### Desktop interruption

Desktop disconnects are ignored by the scheduler. On reconnect, a client fetches the durable snapshot and resumes the event stream from its last sequence or cursor.

### Coordinator interruption

Workers keep existing containers running and continue spooling events locally. After the coordinator returns, it enters a bounded reconciliation window before reassigning expired attempts. Workers report active containers, leases, harness sessions, and last acknowledged event sequences. The coordinator either renews the current ownership or fences it and instructs cleanup.

An agent requiring an interactive approval while the coordinator is unavailable waits; it does not infer approval.

### Worker network partition

The worker keeps containers running within a configurable disconnected-execution limit and available spool capacity. It stops claiming new attempts. On reconnect it reconciles before sending further terminal updates.

### Worker loss

When a worker fails to reconcile and its lease plus recovery grace expire, the attempt becomes `lost`. Retry policy may create a new attempt on another worker from the last durable checkpoint. The original attempt remains immutable for audit.

### Stale worker return

Every mutating worker report includes its fencing generation. Reports from an expired generation may add quarantined diagnostic evidence but cannot change current node, repository, or attempt state. The stale worker is instructed to stop and clean up its container.

### Cancellation

Cancellation is a durable desired state, not a one-shot signal. The current worker acknowledges it, terminates the harness, escalates container termination after a grace period, uploads available diagnostics, and reports completion. Repeated cancellation is harmless.

## Isolation and Security

- Worker enrollment uses a short-lived enrollment token that becomes a rotatable worker identity. Production deployments use mTLS or an equivalently strong workload identity.
- Workers initiate connections outbound so worker hosts do not require public inbound ports.
- Desktop users authenticate through the company's identity provider when configured; the scale-to-one profile may use a bootstrap administrator credential.
- Agent containers run without privileged mode, host Docker socket access, or arbitrary host mounts.
- Containers receive CPU, memory, process, disk, and duration limits plus a restrictive seccomp/AppArmor profile where the host supports it.
- Read-only and write-capable policies are enforced by mounts, container configuration, worker commands, repository validation, and harness tool configuration. Prompts are not the security perimeter.
- Model and repository credentials are resolved just in time, delivered only to the assigned worker, mounted through tmpfs or an equivalent ephemeral mechanism, and removed after the attempt.
- PostgreSQL stores secret references and audit metadata, never plaintext provider or repository credentials.
- Network policy is configurable per worker pool or graph. A default-deny enterprise mode can allow only model providers, package registries, source hosts, and the coordinator.
- Logs and events pass through secret redaction before persistence. Redaction complements isolation and is not treated as proof that a secret cannot leak.

The first implementation may use encrypted coordinator-managed secrets for the scale-to-one profile. The secret resolver remains an internal seam with a second adapter for an external manager such as Vault or a cloud secret service before enterprise release.

## Capacity and Scheduling

Workers advertise total and available CPU, memory, disk, harness slots, labels, and supported isolation features. Nodes declare minimum resources and optional placement constraints. The scheduler admits work only when a matching worker has capacity.

The scale-to-one profile defaults to conservative limits and lets the server reserve resources for PostgreSQL and the coordinator. The laptop worker can join and leave without affecting durable state.

At the enterprise target, approximately 100 concurrent agents are distributed across worker pools. PostgreSQL contention is controlled by narrow transactional claims, indexed ready-state queries, append-only event inserts, and bounded event batches. Coordinator replicas remain stateless and can be added independently of workers.

Fairness begins with per-run concurrency limits and round-robin selection across runnable graphs. Organization-level quotas are represented in the data model but are trivial in a single-company deployment. Priority scheduling is deferred until a concrete need exists.

## Interfaces and Protocol Versioning

The worker protocol uses versioned JSON messages over secure WebSockets in the first release. JSON is sufficient at the 100-agent target, is easy to inspect, and is straightforward to implement in TypeScript and Rust. Large payloads use signed artifact-store transfers rather than WebSocket frames.

Every connection negotiates protocol version and capabilities. Additive fields are optional; incompatible semantic changes require a new protocol version. Coordinator deployment rejects workers that cannot satisfy required fencing, spool, cancellation, or isolation semantics.

The desktop uses a separate HTTPS and event-stream interface. It never receives worker credentials or direct container addresses.

## Observability and Operations

- Every run, node, attempt, worker, lease, and event has a stable identifier.
- Structured logs carry correlation identifiers and omit secrets.
- Metrics cover queue depth, claim latency, running attempts, worker capacity, lease expiry, reconnects, event lag, spool usage, retries, and terminal outcomes.
- Health checks distinguish process health, PostgreSQL readiness, artifact-store readiness, and scheduler leadership/readiness.
- PostgreSQL and artifact volumes have documented backup and restore procedures in the scale-to-one deployment.
- Worker disk pressure stops new claims before it threatens active event spools or workspaces.
- Retention policies remove expired artifacts and completed workspaces only after their metadata and audit requirements are satisfied.

## Verification Strategy

### Module tests

- Scheduler transition, lease, fencing, fairness, and graph-routing tests run against PostgreSQL.
- Every harness adapter runs the same probe, start, resume, ordered-event, structured-result, cancellation, timeout, and malformed-output conformance suite.
- Artifact and secret adapters share contract tests.

### Integration tests

- Real coordinator, PostgreSQL, worker, and fixture harness containers execute a complete graph.
- OpenCode receives optional credential-gated smoke coverage; ordinary CI uses a deterministic fixture harness.
- Repository tests verify unique attempt refs, scope enforcement, checkpoint merge, conflict handling, and source-checkout isolation.

### Failure injection

Tests terminate or partition each process at every durable lifecycle edge:

- Close all desktop clients during an attempt and reconnect later.
- Restart the coordinator while containers continue.
- Partition a worker, accumulate spooled events, and reconnect it.
- Kill a worker and verify lease expiry plus retry on another worker.
- Reconnect a stale worker and verify fencing rejects its terminal result.
- Repeat claims, events, cancellation, and completion reports to prove idempotency.
- Exhaust disk or event-spool capacity and verify safe refusal of new work.
- Confirm secrets do not appear in database rows, persisted events, artifacts, or normal logs.

### Capacity validation

- Run the control plane on a 2-vCPU, 12-GB host and verify it remains usable within the 4-GB base memory budget, excluding agent containers.
- Run approximately seven large graphs totaling 100 concurrent fixture agents across multiple workers.
- Verify no lost or duplicate authoritative transitions, bounded claim latency, resumable client streams, and complete terminal artifacts.
- Measure PostgreSQL load before considering a separate message broker.

## Migration Sequence

1. Extract graph execution into a headless coordinator process while retaining the current local harness adapter for development.
2. Introduce the PostgreSQL schema, repository layer, migrations, backup tooling, and one-time SQLite importer.
3. Expose versioned client and worker interfaces while keeping Electron as a client of the same coordinator interface.
4. Implement the worker daemon, fixture harness, durable event spool, leases, fencing, and reconciliation.
5. Package the OpenCode harness in the first worker image and move real execution out of Electron.
6. Move repository workspaces, collaboration data, artifacts, cancellation, and checkpoint integration behind distributed interfaces.
7. Ship the scale-to-one Docker Compose profile and verify it on the laptop plus small server.
8. Add enterprise S3 storage, external secret resolution, coordinator replicas, worker pools, and the 100-agent soak gate.
9. Add the Pi adapter and evaluate it against OpenCode using the conformance and recovery suites.
10. Add JCode only as an experimental capability until it meets the same operational gates.

Each sequence step leaves one executable path and includes migration tooling where durable data changes. The system does not maintain long-lived SQLite/PostgreSQL dual writes or local/remote scheduler forks.

## Acceptance Criteria

- A run continues when all Electron clients are closed and is fully observable when a client reconnects.
- A worker on another device can claim and execute a node without inbound public ports.
- A coordinator restart preserves running containers and replays every unacknowledged event exactly once into authoritative history.
- A lost worker causes a fenced retry without allowing stale results to overwrite the current attempt.
- Scale-to-one deployment runs on the available 2-vCPU, 12-GB server with the laptop acting as client and optional worker.
- The same build supports multiple worker pools and approximately 100 concurrent fixture agents without a protocol or schema fork.
- OpenCode is production-ready behind the harness-runner interface; Pi can be added without changing coordinator scheduling; JCode remains explicitly experimental.
- PostgreSQL is the sole authoritative workflow store after migration.
- Large artifacts remain outside PostgreSQL and can move from local persistent storage to S3 without changing callers.
- No plaintext model or repository credential is persisted in PostgreSQL, artifacts, events, or normal logs.
- The full conformance, integration, failure-injection, and capacity suites pass.

## Deferred Decisions

These choices are intentionally postponed until evidence requires them:

- Kubernetes-native worker management.
- A dedicated message broker.
- Multi-region or distributed SQL storage.
- Multi-tenant hosted Spire.
- Priority and cost-aware scheduling beyond per-run limits and worker capacity.
- JCode production enablement.

Their seams are represented by existing coordinator, worker, artifact, secret, and harness interfaces; none requires speculative baseline infrastructure.
