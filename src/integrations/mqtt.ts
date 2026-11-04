import type { Attributes } from '@opentelemetry/api';
import { patch } from './db.js';
import { consume, produce } from './messaging.js';

interface PublishOpts { properties?: { userProperties?: Record<string, unknown>; [k: string]: unknown }; [k: string]: unknown }
interface Packet { messageId?: number; properties?: { userProperties?: Record<string, unknown> } }
interface ClientLike { options?: { protocolVersion?: number } }

const attrs = (topic: string, type: 'send' | 'process', op: string, payload?: unknown, id?: number): Attributes => ({
  'messaging.system': 'mqtt',
  'messaging.destination.name': topic,
  'messaging.operation.type': type,
  'messaging.operation.name': op,
  ...(typeof payload === 'string' || payload instanceof Uint8Array ? { 'messaging.message.body.size': payload.length } : {}),
  ...(id !== undefined ? { 'messaging.message.id': String(id) } : {}),
});

/**
 * `instrumentMqtt(mqtt.connect(url))` for mqtt.js: PRODUCER spans on `publish`/`publishAsync`, and a
 * CONSUMER span around the client's `message` listeners. The trace context travels in MQTT 5 user
 * properties, so only `protocolVersion: 5` clients propagate (older clients get unlinked spans).
 * shortcut: `publish` spans end when the call returns, not at the QoS 1/2 ack; use `publishAsync` for ack time.
 */
export function instrumentMqtt(client: object): void {
  const v5 = () => (client as ClientLike).options?.protocolVersion === 5;
  patch(client, 'publish', (orig) => function (this: unknown, topic: string, message: unknown, opts?: unknown, cb?: unknown) {
    if (typeof opts === 'function') [cb, opts] = [opts, undefined];
    return produce(`publish ${topic}`, attrs(topic, 'send', 'publish', message), (h) => {
      const o = opts as PublishOpts | undefined;
      const out = v5() ? { ...o, properties: { ...o?.properties, userProperties: { ...o?.properties?.userProperties, ...h } } } : o;
      return cb === undefined ? orig.call(this, topic, message, out) : orig.call(this, topic, message, out ?? {}, cb);
    });
  });
  // publishAsync calls publish, which then injects the context of this span
  patch(client, 'publishAsync', (orig) => function (this: unknown, topic: string, message: unknown, ...rest: unknown[]) {
    return produce(`publish ${topic}`, attrs(topic, 'send', 'publishAsync', message), () => orig.call(this, topic, message, ...rest));
  });
  patch(client, 'emit', (orig) => function (this: unknown, event: string | symbol, ...args: unknown[]) {
    if (event !== 'message') return orig.call(this, event, ...args);
    const [topic, payload, packet] = args as [string, unknown, Packet | undefined];
    return consume(`process ${topic}`, attrs(topic, 'process', 'message', payload, packet?.messageId),
      [packet?.properties?.userProperties], () => orig.call(this, event, ...args));
  });
}
