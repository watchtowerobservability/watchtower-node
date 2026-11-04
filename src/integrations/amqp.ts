import type { Attributes } from '@opentelemetry/api';
import { patch } from './db.js';
import { consume, produce } from './messaging.js';

type Headers = Record<string, unknown>;
interface PublishOptions { headers?: Headers; messageId?: string; [k: string]: unknown }
interface AmqpMessage {
  content?: { length: number };
  fields?: { deliveryTag?: number; redelivered?: boolean; consumerTag?: string };
  properties?: { headers?: Headers; messageId?: string };
}

const sendAttrs = (dest: string, routingKey: string, op: string, messageId?: unknown, size?: number): Attributes => ({
  'messaging.system': 'rabbitmq',
  'messaging.destination.name': dest,
  'messaging.operation.type': 'send',
  'messaging.operation.name': op,
  'messaging.rabbitmq.destination.routing_key': routingKey,
  ...(typeof messageId === 'string' ? { 'messaging.message.id': messageId } : {}),
  ...(typeof size === 'number' ? { 'messaging.message.body.size': size } : {}),
});

function processAttrs(queue: string, m: AmqpMessage): Attributes {
  const a: Attributes = {
    'messaging.system': 'rabbitmq',
    'messaging.destination.name': queue,
    'messaging.operation.type': 'process',
    'messaging.operation.name': 'consume',
  };
  if (m.properties?.messageId) a['messaging.message.id'] = m.properties.messageId;
  if (typeof m.content?.length === 'number') a['messaging.message.body.size'] = m.content.length;
  if (m.fields?.deliveryTag !== undefined) a['messaging.rabbitmq.message.delivery_tag'] = m.fields.deliveryTag;
  if (m.fields?.redelivered !== undefined) a['messaging.rabbitmq.message.redelivered'] = m.fields.redelivered;
  if (m.fields?.consumerTag) a['messaging.consumer.group.name'] = m.fields.consumerTag;
  return a;
}

const withHeaders = (o: PublishOptions | undefined, h: Record<string, string>): PublishOptions =>
  ({ ...o, headers: { ...o?.headers, ...h } });

/**
 * `instrumentAmqplib(await conn.createChannel())`: patches that channel's class (every channel of
 * it): PRODUCER spans on `publish`/`sendToQueue` with the trace context in `options.headers`, and a
 * CONSUMER span (child of and linked to the producer) around each `consume` callback.
 * shortcut: a ConfirmChannel is its own class; pass one of those too if you use both kinds.
 */
export function instrumentAmqplib(channel: object): void {
  const proto = Object.getPrototypeOf(channel) as object;
  patch(proto, 'publish', (orig) => function (this: unknown, exchange: string, routingKey: string,
    content: { length: number }, options?: PublishOptions, ...rest: unknown[]) {
    const dest = exchange || routingKey;
    return produce(`publish ${dest}`, sendAttrs(dest, routingKey, 'publish', options?.messageId, content?.length),
      (h) => orig.call(this, exchange, routingKey, content, withHeaders(options, h), ...rest));
  });
  // amqplib's sendToQueue calls publish('', queue): that inner call adds no second span
  patch(proto, 'sendToQueue', (orig) => function (this: unknown, queue: string, content: { length: number },
    options?: PublishOptions, ...rest: unknown[]) {
    return produce(`publish ${queue}`, sendAttrs(queue, queue, 'sendToQueue', options?.messageId, content?.length),
      (h) => orig.call(this, queue, content, withHeaders(options, h), ...rest));
  });
  patch(proto, 'consume', (orig) => function (this: unknown, queue: string, onMessage: unknown, ...rest: unknown[]) {
    if (typeof onMessage !== 'function') return orig.call(this, queue, onMessage, ...rest);
    const wrapped = (m: AmqpMessage | null) => (m
      ? consume(`process ${queue}`, processAttrs(queue, m), [m.properties?.headers], () => onMessage(m))
      : onMessage(m)); // null: the server cancelled the consumer
    return orig.call(this, queue, wrapped, ...rest);
  });
}

interface Envelope { exchange?: string; routingKey?: string; headers?: Headers; messageId?: string; [k: string]: unknown }
interface RcMessage { headers?: Headers; messageId?: string; body?: unknown; redelivered?: boolean; deliveryTag?: number }

/**
 * `instrumentRabbitmqClient(new Connection(url))` for rabbitmq-client: publishers made by
 * `createPublisher` get PRODUCER spans on `send` (context in the envelope headers); handlers given
 * to `createConsumer` run in a CONSUMER span. Call it before creating publishers and consumers.
 */
export function instrumentRabbitmqClient(connection: object): void {
  patch(connection, 'createPublisher', (orig) => function (this: unknown, ...a: unknown[]) {
    const pub = orig.apply(this, a) as object;
    patch(pub, 'send', (send) => function (this: unknown, envelope: string | Envelope, body: unknown, ...rest: unknown[]) {
      const env: Envelope = typeof envelope === 'string' ? { routingKey: envelope } : { ...envelope };
      const rk = env.routingKey ?? '';
      const dest = env.exchange || rk;
      const size = typeof body === 'string' || body instanceof Uint8Array ? body.length : undefined;
      return produce(`publish ${dest}`, sendAttrs(dest, rk, 'send', env.messageId, size),
        (h) => send.call(this, { ...env, headers: { ...env.headers, ...h } }, body, ...rest));
    });
    return pub;
  });
  patch(connection, 'createConsumer', (orig) => function (this: unknown, props: string | { queue?: string }, handler: unknown,
    ...rest: unknown[]) {
    if (typeof handler !== 'function') return orig.call(this, props, handler, ...rest);
    const queue = (typeof props === 'string' ? props : props?.queue) ?? '';
    const wrapped = function (this: unknown, m: RcMessage, ...more: unknown[]) {
      const a: Attributes = {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': queue,
        'messaging.operation.type': 'process',
        'messaging.operation.name': 'consume',
        ...(m?.messageId ? { 'messaging.message.id': m.messageId } : {}),
        ...(m?.deliveryTag !== undefined ? { 'messaging.rabbitmq.message.delivery_tag': m.deliveryTag } : {}),
        ...(m?.redelivered !== undefined ? { 'messaging.rabbitmq.message.redelivered': m.redelivered } : {}),
      };
      return consume(`process ${queue}`, a, [m?.headers], () => handler.call(this, m, ...more));
    };
    return orig.call(this, props, wrapped, ...rest);
  });
}
