import { describe, expect, it } from 'vitest';
import { defaultResourceDetectors, METADATA_HOSTS } from '../src/env.js';

const run = (e: Record<string, string>): string | undefined => {
  const env = e as NodeJS.ProcessEnv;
  defaultResourceDetectors(env);
  return env.OTEL_NODE_RESOURCE_DETECTORS;
};

describe('defaultResourceDetectors', () => {
  it('uses local detectors only off-cloud', () => {
    expect(run({})).toBe('env,host,os,process');
  });
  it('adds a cloud detector only when an env var shows the cloud', () => {
    expect(run({ AWS_REGION: 'eu-west-1' })).toBe('env,host,os,process,aws');
    expect(run({ K_SERVICE: 'api' })).toBe('env,host,os,process,gcp');
    expect(run({ WEBSITE_SITE_NAME: 'x' })).toBe('env,host,os,process,azure');
  });
  it('never overrides the user', () => {
    expect(run({ OTEL_NODE_RESOURCE_DETECTORS: 'all', AWS_REGION: 'x' })).toBe('all');
  });
  it('knows the metadata hosts', () => {
    expect(METADATA_HOSTS.has('169.254.169.254')).toBe(true);
  });
});
