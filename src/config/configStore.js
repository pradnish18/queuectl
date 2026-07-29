const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(".queuectlrc");
const VALID_KEYS = ["max-retries", "backoff-base"];
const DEFAULTS = { "max-retries": 3, "backoff-base": 2 };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function setConfig(key, value) {
  if (!VALID_KEYS.includes(key)) {
    throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Config value for "${key}" must be a non-negative number`);
  }
  const config = loadConfig();
  config[key] = num;
  saveConfig(config);
}

module.exports = { loadConfig, saveConfig, setConfig, CONFIG_PATH, VALID_KEYS, DEFAULTS };
