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

export function createLogger(context: string, minLevel: LogLevel = DEFAULT_LEVEL): Logger {
  const prefix = `[CSBOARD:${context}]`;
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];

  function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) return;

    const formatted = `${prefix} ${message}`;

    switch (level) {
      case 'debug':
        console.debug(formatted, data ?? '');
        break;
      case 'info':
        console.log(formatted, data ?? '');
        break;
      case 'warn':
        console.warn(formatted, data ?? '');
        break;
      case 'error':
        console.error(formatted, data ?? '');
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
