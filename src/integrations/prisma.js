'use strict';
const { SpanKind, SpanStatusCode, trace } = require('@opentelemetry/api');

/** prisma.$extends(watchtowerExtension()): a CLIENT span per model operation (no query args recorded: they hold data).
 * shortcut: $queryRaw/$executeRaw are not wrapped; add query.$queryRaw hooks if raw SQL spans are needed. */
function watchtowerExtension() {
  return {
    name: 'watchtower',
    query: {
      $allModels: {
        $allOperations({ model, operation, query, args }) {
          return trace.getTracer('watchtower').startActiveSpan(`prisma ${model}.${operation}`, {
            kind: SpanKind.CLIENT,
            attributes: { 'db.system.name': 'prisma', 'db.collection.name': model, 'db.operation.name': operation },
          }, async (span) => {
            try {
              return await query(args);
            } catch (e) {
              span.recordException(e);
              span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
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

module.exports = { watchtowerExtension };
