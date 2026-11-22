// Optional self-marking deploys: with WT_DEPLOY_KEY (a ci:write key) set, init posts one release and one deployment for the service.
// Both calls are idempotent on the server (release version, deployment external_id), so restarts and retries are safe.
import type { Client } from './index.js';

const API = 'https://watchtowerops.net';
const done = new Set<string>();

/** Returns one log line (or undefined when there is nothing to mark). Never throws. */
export async function markDeploy(c: Client): Promise<string | undefined> {
  try {
    const env = process.env;
    const key = env.WT_DEPLOY_KEY;
    const a = c.resource.attributes;
    const release = a['service.version'] as string | undefined;
    const service = String(a['service.name']);
    if (!key || !release || !c.project) return key ? 'deploy marker skipped: WT_RELEASE and WT_PROJECT_ID are required' : undefined;
    const id = `${release}-${service}`;
    if (done.has(id)) return undefined;
    done.add(id);
    const base = `${(env.WT_API_URL || API).replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(c.project)}`;
    const call = async (method: string, path: string, body?: unknown): Promise<{ data?: { id: string; name: string }[] }> => {
      const r = await c.fetch(base + path, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`${method} ${path} ${r.status}`);
      return r.json().catch(() => ({})) as Promise<{ data?: { id: string; name: string }[] }>;
    };
    const envName = String(a['deployment.environment.name'] || 'production');
    await call('POST', '/releases', { version: release });
    const envs = await call('GET', '/environments?limit=200');
    const e = envs.data?.find((x) => x.name === envName || x.id === envName);
    if (!e) throw new Error(`no environment named ${envName}`);
    await call('POST', '/deployments', { version: release, env_id: e.id, service, status: 'succeeded', source: 'sdk-node', external_id: id });
    return `marked deploy ${service}@${release.slice(0, 10)} (${envName})`;
  } catch (e) {
    return `deploy marker failed: ${(e as Error).message}`;
  }
}
