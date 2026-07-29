#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="node $ROOT_DIR/bin/queuectl.js"
STORAGE="$ROOT_DIR/src/core/storage.js"

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local cmd="$2"
  local tmpf
  tmpf=$(mktemp /tmp/queuectl-test.XXXXXX)
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "$cmd" > "$tmpf"
  chmod +x "$tmpf"
  if "$tmpf" 2>/dev/null; then
    echo "    ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "    ❌ $name"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$tmpf"
}

cleanup() {
  rm -f "$ROOT_DIR/queuectl.db" "$ROOT_DIR/queuectl.db-wal" "$ROOT_DIR/queuectl.db-shm" "$ROOT_DIR/.queuectlrc" "$ROOT_DIR/.workers.json"
  # Kill any lingering queuectl workers
  for pid_file in .workers.json; do
    if [ -f "$ROOT_DIR/$pid_file" ]; then
      for pid in $(node -e "try{const d=JSON.parse(require('fs').readFileSync('$ROOT_DIR/$pid_file','utf8'));console.log((d.pids||[]).join(' '))}catch(e){}" 2>/dev/null); do
        kill "$pid" 2>/dev/null || true
      done
    fi
  done
}

run_worker_bg() {
  local count="${1:-1}"
  QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db $BIN worker start --count "$count" > /dev/null 2>&1 &
  local wpid=$!
  echo "$wpid"
}

stop_worker() {
  QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db $BIN worker stop > /dev/null 2>&1 || true
}

wait_with_timeout() {
  local pid="$1"
  local timeout="${2:-5}"
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$timeout" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill "$pid" 2>/dev/null || true
}

trap cleanup EXIT

echo "========================================="
echo "  queuectl Integration Test Suite"
echo "========================================="
echo ""

# ==========================================
# Scenario 1: Basic job lifecycle
#   Enqueue, claim, complete a job via CLI
# ==========================================
echo "📋 Scenario 1: Basic Job Lifecycle"
echo "----------------------------------------"
cleanup

run_test "Enqueue a simple command" \
  "$BIN enqueue 'echo hello-world'"

# Claim and invoke via the storage module
run_test "Claim job via API" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('test-worker-1');process.exit(j&&j.state==='processing'?0:1)\""

run_test "One job in processing state" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.processing===1?0:1)\""

run_test "Complete the job via API" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.listJobs('processing')[0];s.completeJob(j.id);process.exit(0)\""

run_test "One job in completed state" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.completed===1?0:1)\""

run_test "queuectl list --state completed --json returns valid JSON array" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db $BIN list --state completed --json | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length===1?0:1)})\""

echo ""

# ==========================================
# Scenario 2: Failure and DLQ (max_retries)
#   A job that fails goes to DLQ after retries
# ==========================================
echo "📋 Scenario 2: Failure and DLQ"
echo "----------------------------------------"
cleanup

run_test "Enqueue a command that will fail" \
  "$BIN enqueue '{\"command\": \"exit 1\", \"max_retries\": 2}'"

run_test "Claim and invoke — deduct attempt" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('test-worker-2');process.exit(j&&j.state==='processing'?0:1)\""

run_test "Fail the job (attempt 1/2) — goes to failed state with backoff" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.listJobs('processing')[0];s.failJob(j.id, 1, 2);const c=s.getJobCounts();process.exit(c.failed===1?0:1)\""

# Reset run_at so claim works without waiting for backoff
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
const Database = require('better-sqlite3');
const db = new Database('$ROOT_DIR/queuectl.db');
db.pragma('journal_mode = WAL');
db.exec(\"UPDATE jobs SET run_at = datetime('now') WHERE state = 'failed'\");
db.close();
"

run_test "Claim again (attempt 2/2)" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('test-worker-2');process.exit(j&&j.attempts===1?0:1)\""

run_test "Fail again (attempt 2/2) — max retries reached, moves to DLQ (dead)" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.listJobs('processing')[0];s.failJob(j.id, 2, 2);const c=s.getJobCounts();process.exit(c.dead===1?0:1)\""

run_test "queuectl dlq list shows the DLQ'd job" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db $BIN dlq list | grep -q exit"

run_test "queuectl dlq retry moves dead job back to pending" \
  "JID=\$(QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.listJobs('dead')[0];console.log(j?j.id:'');process.exit(j?0:1)\") && \
   QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db $BIN dlq retry \"\$JID\" && \
   QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.pending===1?0:1)\""

echo ""

# ==========================================
# Scenario 3: Concurrency Safety
#   Multiple workers can claim distinct jobs
#   without conflicts
# ==========================================
echo "📋 Scenario 3: Concurrency Safety"
echo "----------------------------------------"
cleanup

# Enqueue 5 jobs
for i in 1 2 3 4 5; do
  $BIN enqueue "echo job-$i" > /dev/null 2>&1
done

run_test "5 jobs enqueued in pending state" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.pending===5?0:1)\""

# Claim 3 jobs with different worker IDs
CLAIMED=0
for wid in worker-a worker-b worker-c; do
  QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('$wid');process.exit(j?0:1)" && CLAIMED=$((CLAIMED + 1)) || true
done

run_test "Claimed 3 distinct jobs by different workers" \
  "[ $CLAIMED -eq 3 ]"

run_test "2 remaining jobs in pending" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.pending===2?0:1)\""

run_test "3 jobs in processing" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const c=s.getJobCounts();process.exit(c.processing===3?0:1)\""

echo ""

# ==========================================
# Scenario 4: SIGKILL Crash Recovery
#   A worker killed mid-job recovers within
#   30 seconds and the job completes.
#   Simulated by aging updated_at to trigger
#   recovery without waiting 30s.
# ==========================================
echo "📋 Scenario 4: SIGKILL Crash Recovery"
echo "----------------------------------------"
cleanup

# Enqueue and claim a job with direct API
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
delete require.cache[require.resolve('$STORAGE')];
const s = require('$STORAGE');
s.enqueueJob('crash-test-1', 'echo crash-recovered', 3);
const j = s.claimNextJob('crashed-worker');
console.log('Claimed:', j.id, 'state:', j.state);
"

run_test "Job is in processing state (simulating mid-crash)" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.getJobById('crash-test-1');process.exit(j&&j.state==='processing'?0:1)\""

# Age the job's updated_at to be 120 seconds in the past
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
const Database = require('better-sqlite3');
const db = new Database('$ROOT_DIR/queuectl.db');
db.pragma('journal_mode = WAL');
db.exec(\"UPDATE jobs SET updated_at = datetime('now', '-120 seconds') WHERE id = 'crash-test-1'\");
db.close();
"

run_test "recoverStaleJobs resets processing job back to pending" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const r=s.recoverStaleJobs(30);process.exit(r>=1?0:1)\""

run_test "Recovered job is now in pending state" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.getJobById('crash-test-1');process.exit(j&&j.state==='pending'?0:1)\""

run_test "Recovered job is claimable by new worker" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('recovery-worker');process.exit(j&&j.state==='processing'?0:1)\""

run_test "Claimed recovered job can be completed" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');s.completeJob('crash-test-1');const j=s.getJobById('crash-test-1');process.exit(j&&j.state==='completed'?0:1)\""

echo ""

# ==========================================
# Scenario 5: System Restart (Simulated)
#   A job can be claimed, the system goes
#   down, and another worker recovers it.
# ==========================================
echo "📋 Scenario 5: System Restart (Simulated)"
echo "----------------------------------------"
cleanup

# This tests that a stale job is recovered after a simulated restart.
# The recovery threshold is 30s, so we force the age to 120s.
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
delete require.cache[require.resolve('$STORAGE')];
const s = require('$STORAGE');
s.enqueueJob('restart-test-1', 'echo restart-recovered', 3);
const j = s.claimNextJob('pre-restart-worker');
console.log('Pre-restart claim:', j.id, 'state:', j.state);
"

run_test "Job is processing before simulated restart" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.getJobById('restart-test-1');process.exit(j&&j.state==='processing'?0:1)\""

# Simulate system going down: close storage
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
delete require.cache[require.resolve('$STORAGE')];
const s = require('$STORAGE');
s.close();
"

# Age the job to simulate time passing
QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e "
const Database = require('better-sqlite3');
const db = new Database('$ROOT_DIR/queuectl.db');
db.pragma('journal_mode = WAL');
db.exec(\"UPDATE jobs SET updated_at = datetime('now', '-120 seconds') WHERE id = 'restart-test-1'\");
db.close();
"

# Simulate system restart: new storage instance, recover
run_test "Job was recovered after simulated restart" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const r=s.recoverStaleJobs(30);const j=s.getJobById('restart-test-1');process.exit(j&&j.state==='pending'?0:1)\""

run_test "Recovered job can be claimed and completed after restart" \
  "QUEUECTL_DB_PATH=$ROOT_DIR/queuectl.db node -e \"delete require.cache[require.resolve('$STORAGE')];const s=require('$STORAGE');const j=s.claimNextJob('post-restart-worker');s.completeJob(j.id);const c=s.getJobCounts();process.exit(c.completed===1?0:1)\""

echo ""

# ==========================================
# Summary
# ==========================================
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
