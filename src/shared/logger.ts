// ============================================================
// CSBOARD — Structured Logger
// ============================================================
// Consistent, filterable logging across all extension contexts.
// - Prefixed with [CSBOARD] for easy console filtering
// - Structured context (JSON-serializable metadata)
// - Log levels: debug < info < warn < error
// - Each context (background, content, popup) gets its own logger

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Default: 'info' in production, 'debug' in dev
// Note: import.meta.env is Vite-specific, but not available at runtime in MV3.
// We use a simple heuristic: if chrome.runtime.getManifest exists and version
// contains 'dev', use debug. Otherwise default to info.
const DEFAULT_LEVEL: LogLevel = 'info';

export interface LogEntry {
  level: LogLevel;
  context: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(subContext: string): Logger;
}

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|access.?token|session(?:id)?|steamloginsecure|guard|shared.?secret|identity.?secret|api.?key|ciphertext|\benc\b|proof)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+\/-]+=*|steamLoginSecure|sessionid\s*[=:]|data-loyalty_webapi_token|access_token=|authorization\s*[=:]|shared_secret|identity_secret)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[REDACTED_DEPTH]';
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return '[REDACTED]';
    // Avoid accidentally logging large HTML/JSON/ciphertext-like blobs.
    return value.length > 512 ? `${value.slice(0, 96)}…[TRUNCATED:${value.length}]` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(entry, depth + 1);
    }
    return output;
  }
  return value;
}

/** Exported for security snapshot tests and sanitized diagnostics export. */
export function redactLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  return data ? redactValue(data) as Record<string, unknown> : undefined;
}

export function createLogger(context: string, minLevel: LogLevel = DEFAULT_LEVEL): Logger {
  const prefix = `[CSBOARD:${context}]`;
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) return;

    const formatted = `${prefix} ${SENSITIVE_VALUE.test(message) ? '[REDACTED_MESSAGE]' : message}`;
    const safeData = redactLogData(data);

    switch (level) {
      case 'debug':
        console.debug(formatted, safeData ?? '');
        break;
      case 'info':
        console.log(formatted, safeData ?? '');
        break;
      case 'warn':
        console.warn(formatted, safeData ?? '');
        break;
      case 'error':
        console.error(formatted, safeData ?? '');
        break;
    }

    // Could also buffer entries and send to server for remote debugging
    // if (level === 'error') { ... }
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    child: (subContext) => createLogger(`${context}:${subContext}`, minLevel),
  };
}
