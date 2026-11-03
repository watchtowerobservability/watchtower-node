import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

interface OperationArgs {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

/** prisma.$extends(watchtowerExtension()): a CLIENT span per model operation (no query args recorded: they hold data).
 * shortcut: $queryRaw/$executeRaw are not wrapped; add query.$queryRaw hooks if raw SQL spans are needed. */
export function watchtowerExtension(): object {
  return {
    name: 'watchtower',
    query: {
      $allModels: {
        $allOperations({ model, operation, query, args }: OperationArgs) {
          return trace.getTracer('watchtower').startActiveSpan(`prisma ${model}.${operation}`, {
            kind: SpanKind.CLIENT,
            attributes: { 'db.system.name': 'prisma', 'db.collection.name': model, 'db.operation.name': operation },
          }, async (span) => {
            try {
              return await query(args);
            } catch (e) {
              span.recordException(e as Error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
              throw e;
            } finally {
              span.end();
            }
          });
        },
      },
    },
  };
}
