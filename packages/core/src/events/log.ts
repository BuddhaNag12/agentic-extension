import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { RunEvent, type NewRunEvent } from '@agentflow/protocol';

/**
 * Append-only JSONL event log (§3.3). This is the source of truth for a run:
 * UI state, the audit trail, resume, and evals are all folds over it.
 *
 * Writes are synchronous and line-atomic. A torn final line (process killed
 * mid-write) is tolerated on read — see `readAll`.
 */
export class EventLog {
  private seq = 0;
  private readonly emitter = new EventEmitter();

  private constructor(readonly path: string, seq: number) {
    this.seq = seq;
    this.emitter.setMaxListeners(64);
  }

  /** Open (or create) a log, recovering the next sequence number from disk. */
  static open(path: string): EventLog {
    mkdirSync(dirname(path), { recursive: true });
    let seq = 0;
    if (existsSync(path)) {
      for (const e of readAllSync(path)) seq = Math.max(seq, e.seq + 1);
    }
    return new EventLog(path, seq);
  }

  get nextSeq(): number {
    return this.seq;
  }

  /** Stamp, persist, and publish an event. Returns the stamped event. */
  append(event: NewRunEvent): RunEvent {
    const stamped = { ...event, seq: this.seq, at: Date.now() } as RunEvent;
    const parsed = RunEvent.parse(stamped);
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, 'utf8');
    this.seq += 1;
    this.emitter.emit('event', parsed);
    return parsed;
  }

  readAll(): RunEvent[] {
    return existsSync(this.path) ? readAllSync(this.path) : [];
  }

  readSince(seq: number): RunEvent[] {
    return this.readAll().filter((e) => e.seq >= seq);
  }

  onEvent(listener: (e: RunEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** Streaming read for large logs — a long run produces tens of thousands. */
  async *stream(sinceSeq = 0): AsyncGenerator<RunEvent> {
    if (!existsSync(this.path)) return;
    const rl = createInterface({ input: createReadStream(this.path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      const e = parseLine(line);
      if (e && e.seq >= sinceSeq) yield e;
    }
  }
}

function readAllSync(path: string): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const e = parseLine(line);
    if (e) out.push(e);
  }
  return out;
}

/**
 * A line that does not parse is dropped rather than thrown. The only line that
 * can be malformed is a truncated tail from a killed process, and losing the
 * last event is always better than refusing to open the log at all.
 */
function parseLine(line: string): RunEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = RunEvent.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
