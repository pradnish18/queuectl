# ⚡ QueueCTL (`queuectl`)

A lightweight, production-grade CLI background job queue system built with Node.js and SQLite.

QueueCTL offloads heavy asynchronous tasks (emails, webhooks, processing scripts) from your main application thread to background worker processes. It offers zero-config persistence, crash recovery, exponential backoff retries, and a Dead Letter Queue (DLQ).

---

## 🧪 Interactive Playground: Try It Out in 30 Seconds!

```bash
# 1. Enqueue a success job and a failing job
queuectl enqueue '{"command": "echo Hello from QueueCTL!"}'
queuectl enqueue '{"command": "exit 1", "max_retries": 2}'

# 2. Inspect queue state
queuectl status

# 3. Process jobs with a background worker (Ctrl+C to stop)
queuectl worker start --count 2

# 4. Inspect & retry dead jobs
queuectl dlq list
queuectl dlq retry <job-id>
```

---

## ✨ Key Features

- **Zero-External-Dependencies Storage:** Powered by SQLite with Write-Ahead Logging (WAL mode) for safe concurrent reads/writes without needing Redis or Docker.
- **Atomic Job Claiming:** Prevents race conditions and guarantees no job is claimed twice by concurrent workers.
- **Resilient Retry Mechanism:** Automatic exponential backoff ($2^{\text{attempts}}$ delay) on execution failure.
- **Dead Letter Queue (DLQ):** Permanently failed jobs are moved to dead state for manual inspection and re-triggering.
- **Crash & Stale Recovery:** Automatically detects and recovers orphaned processing jobs if a worker process crashes unexpectedly.
- **Developer Friendly CLI:** Offers clean formatted table outputs alongside a strict `--json` output mode for scripting and CI/CD integration.

---

## 📦 Installation & Setup

### Global Installation

```bash
npm install -g @pradnish18/queuectl
```

### Local Setup (From Source)

```bash
git clone https://github.com/pradnish18/queuectl.git
cd queuectl
npm install
npm link
```

---

## 🚀 CLI Usage

### `enqueue`

Enqueues a job. Accepts a plain shell command or a JSON object with `command`, `max_retries`, and `backoff_base`.

```bash
queuectl enqueue '{"command": "python3 script.py", "max_retries": 3}'
queuectl enqueue 'echo plain command'
```

### `worker start` / `worker stop`

Starts or stops background worker processes.

```bash
queuectl worker start --count 4
queuectl worker stop
```

### `status`

Displays a color-coded summary table of the job queue.

```bash
queuectl status
```

### `list [--state <state>] [--json]`

Lists jobs. Use `--json` for raw JSON output (scripts, piping).

```bash
queuectl list --state pending --json
```

### `dlq list` / `dlq retry <id>`

Manages the Dead Letter Queue.

```bash
queuectl dlq list
queuectl dlq retry job-1743212345678-abc123
```

### `config set <key> <value>`

Sets configuration (`max-retries`, `backoff-base`).

```bash
queuectl config set max-retries 5
```

---

## 🏗️ Architecture

```
bin/queuectl.js          CLI entry point
├── src/commands/        Command handlers (enqueue, worker, status, list, dlq, config)
├── src/core/            Business logic
│   ├── storage.js       SQLite persistence layer (WAL mode, atomic claiming)
│   ├── executor.js      child_process.exec wrapper for safe command execution
│   ├── retry.js         Exponential backoff: delay = base^attempts
│   └── jobModel.js      Schema definition and validation
├── src/config/          .queuectlrc configuration management
└── test/validate.sh     End-to-end validation suite
```

### Job Lifecycle

```
enqueue ──► pending ──► processing ──► completed
                            │
                            ▼
                         failed ──► retry (backoff delay)
                            │
                            ▼
                          dead (DLQ) ──► dlq retry ──► pending
```

---

## 🧪 Running Tests

```bash
npm test                # End-to-end validation suite (14 scenarios)
bash test/validate.sh   # Same, directly
```

---

## 📄 Design Decisions

See [DECISIONS.md](DECISIONS.md) for detailed architectural trade-offs on storage engine choice, atomic claiming, crash recovery, DLQ retry strategy, cross-process worker management, and graceful shutdown.
