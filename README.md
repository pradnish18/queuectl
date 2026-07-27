# ⚡ QueueCTL (`queuectl`)

A lightweight, production-grade CLI background job queue system built with Node.js, TypeScript, and SQLite.

QueueCTL offloads heavy asynchronous tasks (emails, webhooks, processing scripts) from your main application thread to background worker processes. It offers zero-config persistence, crash recovery, exponential backoff retries, and a Dead Letter Queue (DLQ).

---

## 🧪 Interactive Playground: Try It Out in 30 Seconds!

Copy and paste these commands into your terminal to see job claiming, background processing, retries, and DLQ handling live in action!

### 1. Enqueue Sample Jobs

```bash
# Success job
queuectl enqueue '{"command": "echo Hello from QueueCTL!"}'

# Failing job (configured with 2 max retries to test exponential backoff)
queuectl enqueue '{"command": "exit 1"}' --max-retries 2
```

### 2. Inspect the Initial Queue State

```bash
queuectl status
```

> Shows job counts grouped by state: pending, processing, completed, failed, dead

### 3. Start a Background Worker

```bash
queuectl worker start --concurrency 2
```

> Processes pending jobs, retries failures with backoff, and outputs logs in real-time

### 4. Inspect & Retry Dead Jobs (DLQ)

```bash
# List jobs in Dead Letter Queue after max retries are exhausted
queuectl dlq list

# Re-queue a dead job back to pending state
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

### 1. Global Installation (NPM)

```bash
npm install -g queuectl
```

### 2. Local Setup (From Source)

```bash
# Clone repository
git clone https://github.com/pradnish18/queuectl.git
cd queuectl

# Install dependencies
npm install

# Build TypeScript source
npm run build

# Link executable locally
npm link
```

---

## 🚀 CLI Usage & Commands Guide

### `enqueue`

Enqueues a job into the queue database.

```bash
queuectl enqueue '{"command": "python3 script.py"}' --max-retries 3 --backoff-base 2
```

### `worker start`

Starts background worker processes in the foreground.

```bash
queuectl worker start --concurrency 4
```

### `status`

Displays summary metrics of the job queue.

```bash
# Table view
queuectl status

# JSON view (for scripting)
queuectl status --json
```

### `list`

Lists jobs filtered by state (pending, processing, completed, failed, dead).

```bash
queuectl list --state pending --json
```

### `dlq list` & `dlq retry`

Manages permanently failed jobs.

```bash
queuectl dlq list
queuectl dlq retry <job-id>
```

---

## 🏗️ Architecture Overview

```
[ Application / CLI ]
          │
          ▼
 1. Enqueue Job ──────────► [ SQLite Database ] (WAL Mode)
                                   │
                                   ▼
                         2. Worker Polls Job
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
            Job Succeeds                   Job Fails
                    │                             │
                    ▼                             ▼
             Mark "completed"           Exponential Backoff
                                           (Delay = 2^attempt)
                                                  │
                                                  ▼
                                       Max Retries Reached?
                                        ┌─────────┴─────────┐
                                        ▼                   ▼
                                       YES                 NO
                                        │                   │
                                        ▼                   ▼
                                   Move to DLQ      Re-queue Job(Dead Letter Queue)
```

---

## 🧪 Running Automated Tests

QueueCTL comes with a full automated test suite powered by Jest covering database state transitions, worker concurrency, backoff calculations, DLQ operations, and CLI contracts.

```bash
npm test
```

---

## 📄 Documentation & Design Decisions

For detailed architectural trade-offs, state machine transitions, SQLite locking strategies, and CLI contract design decisions, see [DECISIONS.md](DECISIONS.md).
