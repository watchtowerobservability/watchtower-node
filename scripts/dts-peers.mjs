// Optional peers must not break a consumer's `tsc` (skipLibCheck:false): a declaration that names a peer the app did not
// install is TS2307. `// @ts-ignore` above the specifier line silences that and the type resolves to `any` when the peer is
// missing (and to the real type when it is installed). Pure functions so test/dts-peers.test.ts can cover them.
export const peerSpecs = (pkg) => Object.keys(pkg.peerDependencies ?? {});

const specRe = (peers) => new RegExp(`(?:from |import\\()['"](?:${peers.map((p) => p.replace(/[/.-]/g, '\\$&')).join('|')})['"]`);
const GUARD = '// @ts-ignore optional peer: absent -> any (keeps skipLibCheck:false consumers compiling)';

/** Insert the guard above every line that names an optional peer module. */
export function guardPeers(text, peers) {
  const re = specRe(peers);
  const out = [];
  for (const line of text.split('\n')) {
    if (re.test(line) && !out[out.length - 1]?.startsWith('// @ts-ignore')) out.push(GUARD);
    out.push(line);
  }
  return out.join('\n');
}

/** Lines naming an optional peer without the guard above them (empty when the declaration is safe). */
export function unguarded(text, peers) {
  const re = specRe(peers);
  const lines = text.split('\n');
  return lines.filter((l, i) => re.test(l) && !lines[i - 1]?.startsWith('// @ts-ignore'));
}
