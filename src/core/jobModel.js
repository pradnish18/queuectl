const VALID_STATES = ["pending", "processing", "completed", "failed", "dead"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    state TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    locked_by TEXT DEFAULT NULL,
    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'dead'))
  );
`;

function validateState(state) {
  if (!VALID_STATES.includes(state)) {
    throw new Error(`Invalid job state: "${state}". Must be one of: ${VALID_STATES.join(", ")}`);
  }
}

function validateJobId(id) {
  if (!id || typeof id !== "string") {
    throw new Error("Job ID must be a non-empty string");
  }
}

function validateCommand(command) {
  if (!command || typeof command !== "string") {
    throw new Error("Job command must be a non-empty string");
  }
}

function validateMaxRetries(maxRetries) {
  if (maxRetries != null && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new Error("maxRetries must be a non-negative integer");
  }
}

module.exports = {
  VALID_STATES,
  SCHEMA,
  validateState,
  validateJobId,
  validateCommand,
  validateMaxRetries,
};
