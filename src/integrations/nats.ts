import type { Attributes } from '@opentelemetry/api';
import { patch } from './db.js';
import { consume, produce } from './messaging.js';

interface MsgHdrs { get(k: string): string; set(k: string, v: string): void }
interface NatsModule { headers(): MsgHdrs }
interface NatsMsg { subject: string; headers?: MsgHdrs; data?: Uint8Array; reply?: string }
interface Opts { headers?: MsgHdrs; callback?: (err: unknown, msg: NatsMsg) => void; queue?: string; [k: string]: unknown }

const attrs = (subject: string, type: 'send' | 'process', op: string, data?: { length: number }, queue?: string): Attributes => ({
  'messaging.system': 'nats',
  'messaging.destination.name': subject,
  'messaging.operation.type': type,
  'messaging.operation.name': op,
  ...(typeof data?.length === 'number' ? { 'messaging.message.body.size': data.length } : {}),
  ...(queue ? { 'messaging.consumer.group.name': queue } : {}),
});

const carrier = (m: NatsMsg) => ({ traceparent: m.headers?.get('traceparent'), tracestate: m.headers?.get('tracestate') });

/**
 * `instrumentNats(nc, nats)` (`import * as nats from 'nats'`; `nc = await nats.connect()`): patches the
 * connection class. `publish`/`request` get PRODUCER spans with the context in NATS headers;
 * `subscribe` messages get CONSUMER spans (child of and linked to the producer). With a `callback`
 * subscription the span is active in the callback. With `for await (const m of sub)` each span runs
 * from receipt to the next iteration and is not active in the loop body (child spans there are not
 * parented to it; the producer link still gives lag).
 */
export function instrumentNats(nc: object, nats: NatsModule): void {
  const proto = Object.getPrototypeOf(nc) as object;
  const withHeaders = (o: Opts | undefined, h: Record<string, string>): Opts => {
    const hdrs = o?.headers ?? nats.headers();
    for (const [k, v] of Object.entries(h)) hdrs.set(k, v);
    return { ...o, headers: hdrs };
  };
  patch(proto, 'publish', (orig) => function (this: unknown, subject: string, data?: { length: number }, o?: Opts) {
    return produce(`send ${subject}`, attrs(subject, 'send', 'publish', data),
      (h) => orig.call(this, subject, data, withHeaders(o, h)));
  });
  patch(proto, 'request', (orig) => function (this: unknown, subject: string, data?: { length: number }, o?: Opts) {
    return produce(`send ${subject}`, attrs(subject, 'send', 'request', data),
      (h) => orig.call(this, subject, data, withHeaders(o, h)));
  });
  patch(proto, 'subscribe', (orig) => function (this: unknown, subject: string, o?: Opts) {
    const cb = o?.callback;
    if (typeof cb === 'function') {
      const callback = (err: unknown, m: NatsMsg) => (err || !m
        ? cb(err, m)
        : consume(`process ${m.subject}`, attrs(m.subject, 'process', 'subscribe', m.data, o?.queue), [carrier(m)], () => cb(err, m)));
      return orig.call(this, subject, { ...o, callback });
    }
    const sub = orig.call(this, subject, o) as AsyncIterable<NatsMsg>;
    const iter = sub[Symbol.asyncIterator]?.bind(sub);
    if (!iter) return sub;
    (sub as { [Symbol.asyncIterator]: () => AsyncIterator<NatsMsg> })[Symbol.asyncIterator] = () => {
      const inner = iter();
      let end: (() => void) | undefined;
      const close = () => { end?.(); end = undefined; };
      return {
        async next() {
          close();
          const r = await inner.next();
          if (!r.done) {
            const m = r.value;
            // the span ends when this promise resolves, i.e. on the next iteration or return
            void consume(`process ${m.subject}`, attrs(m.subject, 'process', 'subscribe', m.data, o?.queue), [carrier(m)],
              () => new Promise<void>((res) => { end = res; }));
          }
          return r;
        },
        async return(v?: unknown) {
          close();
          return inner.return ? inner.return(v) : { done: true as const, value: v };
        },
        [Symbol.asyncIterator]() { return this; },
      } as AsyncIterableIterator<NatsMsg>;
    };
    return sub;
  });
}
