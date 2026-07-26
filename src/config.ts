import fs from "fs";
import path from "path";

export interface QueueConfig {
  "max-retries": number;
  "backoff-base": number;
}

const DEFAULTS: QueueConfig = {
  "max-retries": 3,
  "backoff-base": 2,
};

export const CONFIG_PATH = path.resolve(".queuectlrc");

const VALID_KEYS: (keyof QueueConfig)[] = ["max-retries", "backoff-base"];

export function loadConfig(): QueueConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: QueueConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function setConfig(key: string, value: string): void {
  if (!VALID_KEYS.includes(key as keyof QueueConfig)) {
    throw new Error(
      `Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`
    );
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Config value for "${key}" must be a non-negative number`);
  }
  const config = loadConfig();
  config[key as keyof QueueConfig] = num;
  saveConfig(config);
}
