export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /(authorization|api[_-]?key|client[_-]?secret|password|oauth|token|cookie)/i;
const SECRET_VALUE = /(oauth:[a-z0-9_-]+|bearer\s+[a-z0-9._-]+)/gi;
const KNOWN_SECRETS = Object.entries(process.env)
  .filter(([key, value]) => SENSITIVE_KEY.test(key) && typeof value === 'string' && value.length >= 6)
  .map(([, value]) => value as string);

function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    let safe = value.replace(SECRET_VALUE, '[REDACTED]');
    for (const secret of KNOWN_SECRETS) safe = safe.replaceAll(secret, '[REDACTED]');
    return safe;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack) };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]),
    );
  }
  return value;
}

export class Logger {
  constructor(
    private readonly component: string,
    private readonly minimumLevel: LogLevel = 'info',
    private readonly base: LogFields = {},
  ) {}

  child(component: string, fields: LogFields = {}): Logger {
    return new Logger(component, this.minimumLevel, { ...this.base, ...fields });
  }

  debug(message: string, fields: LogFields = {}): void { this.write('debug', message, fields); }
  info(message: string, fields: LogFields = {}): void { this.write('info', message, fields); }
  warn(message: string, fields: LogFields = {}): void { this.write('warn', message, fields); }
  error(message: string, fields: LogFields = {}): void { this.write('error', message, fields); }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVELS[level] < LEVELS[this.minimumLevel]) return;
    // `message` is written last on purpose. Spreading fields over it let any caller passing a
    // `message` field replace the event name with arbitrary content — 'Bot reaction submitted to
    // Twitch' logged the chat text as its own name, which made send-success events unsearchable in
    // production logs. A caller's own `message` is preserved under `messageField` instead.
    const { message: shadowed, ...safeFields } = { ...this.base, ...fields };
    const entry = redact({
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      ...safeFields,
      ...(shadowed !== undefined ? { messageField: shadowed } : {}),
      message,
    });
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}
