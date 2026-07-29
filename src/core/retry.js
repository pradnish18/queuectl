function calculateDelay(attempts, base = 2) {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error("attempts must be a non-negative integer");
  }
  if (typeof base !== "number" || base <= 0) {
    throw new Error("base must be a positive number");
  }
  return Math.pow(base, attempts);
}

function formatSqlTimestamp(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

module.exports = { calculateDelay, formatSqlTimestamp };
