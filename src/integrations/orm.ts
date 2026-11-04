// ORM query spans: summary (`SELECT users`), `db.query.hash` and the N+1 hint from the shared core.
// The statement text is never recorded raw (with `queryText`, literal-free only).
import { patch, recordDbSpan, traced } from './db.js';
import type { DbOptions } from './db.js';

type Fn = (...a: any[]) => any;
const PREPARED = ['execute', 'all', 'get', 'run', 'values'];

/**
 * `instrumentDrizzle(db, 'postgresql')`: a CLIENT span per query a Drizzle database runs (`system`
 * is the `db.system.name`: postgresql, mysql, sqlite, ...). Call once per `drizzle(...)` instance.
 * shortcut: `db.transaction(tx => ...)` runs on its own session and gets no spans; instrument the
 * driver as well if transactions matter.
 */
export function instrumentDrizzle(db: object, system: string, opts?: DbOptions): void {
  const d = db as { session?: object; _?: { session?: object } };
  const session = d.session ?? d._?.session;
  if (!session) return;
  patch(session, 'prepareQuery', (orig) => function (this: unknown, query: { sql?: string }, ...rest: unknown[]) {
    const pq = orig.call(this, query, ...rest);
    if (pq && typeof pq === 'object') {
      for (const m of PREPARED) {
        patch(pq, m, (o: Fn) => function (this: unknown, ...a: unknown[]) {
          return traced({ system, sql: query?.sql }, opts, () => o.apply(this, a));
        });
      }
    }
    return pq;
  });
}

interface KyselyLogEvent {
  level: 'query' | 'error';
  query: { sql: string };
  queryDurationMillis: number;
  error?: unknown;
}

/** `new Kysely({ dialect, log: kyselyLog('postgresql') })`; `next` still gets every event. */
export function kyselyLog(system: string, next?: (e: KyselyLogEvent) => void, opts?: DbOptions) {
  return (e: KyselyLogEvent): void => {
    recordDbSpan({ system, sql: e.query?.sql }, opts, e.queryDurationMillis,
      e.level === 'error' ? e.error ?? new Error() : undefined);
    next?.(e);
  };
}

const TYPEORM: Record<string, string> = {
  postgres: 'postgresql', 'aurora-postgres': 'postgresql', cockroachdb: 'cockroachdb',
  mysql: 'mysql', 'aurora-mysql': 'mysql', mariadb: 'mariadb', mssql: 'microsoft.sql_server',
  oracle: 'oracle.db', sap: 'sap.hana', spanner: 'gcp.spanner', 'better-sqlite3': 'sqlite', sqlite: 'sqlite',
  sqljs: 'sqlite', capacitor: 'sqlite', cordova: 'sqlite', expo: 'sqlite', nativescript: 'sqlite', 'react-native': 'sqlite',
};

interface DataSourceLike {
  options: { type: string; database?: unknown };
  driver: object;
}

/** `instrumentTypeORM(dataSource)` (before or after `initialize`): a CLIENT span per `QueryRunner.query`. */
export function instrumentTypeORM(dataSource: DataSourceLike, opts?: DbOptions): void {
  const { type, database } = dataSource.options;
  const system = TYPEORM[type] ?? type;
  const namespace = typeof database === 'string' ? database : undefined;
  patch(dataSource.driver, 'createQueryRunner', (orig) => function (this: unknown, ...args: unknown[]) {
    const runner = orig.apply(this, args);
    if (runner && typeof runner === 'object') {
      patch(runner, 'query', (q: Fn) => function (this: unknown, sql: string, ...rest: unknown[]) {
        return traced({ system, sql, namespace }, opts, () => q.call(this, sql, ...rest));
      });
    }
    return runner;
  });
}

const EXECUTED = /^Execut(?:ed|ing) \([^)]*\):\s*/;

/**
 * `new Sequelize(url, { benchmark: true, logging: sequelizeLogging('postgresql') })`: a span per
 * executed query (only lines with a timing, so `benchmark: true` is required). `next` gets every call.
 * shortcut: failed queries are not logged by Sequelize with a timing, so they get no span.
 */
export function sequelizeLogging(system: string, next?: (sql: string, ...rest: unknown[]) => void, opts?: DbOptions) {
  return (sql: string, ...rest: unknown[]): void => {
    if (typeof rest[0] === 'number' && typeof sql === 'string') {
      recordDbSpan({ system, sql: sql.replace(EXECUTED, '') }, opts, rest[0]);
    }
    next?.(sql, ...rest);
  };
}

interface MikroLogContext { query?: string; took?: number; level?: string }
interface MikroLogger { logQuery(context: MikroLogContext): void }

/**
 * `MikroORM.init({ loggerFactory: mikroOrmLoggerFactory(DefaultLogger, 'postgresql') })`: a span per
 * query MikroORM reports (with its `took`), then the `Base` logger logs as usual.
 */
export function mikroOrmLoggerFactory<O, L extends MikroLogger>(Base: new (options: O) => L, system: string, opts?: DbOptions) {
  return (options: O): L => {
    const logger = new Base(options);
    const logQuery = logger.logQuery.bind(logger);
    logger.logQuery = (c: MikroLogContext) => {
      if (c && typeof c.query === 'string' && typeof c.took === 'number') {
        recordDbSpan({ system, sql: c.query }, opts, c.took, c.level === 'error' ? new Error() : undefined);
      }
      logQuery(c);
    };
    return logger;
  };
}
