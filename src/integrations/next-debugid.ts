// Debug ids for Next builds: same convention as the browser SDK's bundler plugins (`//# debugId=<uuid>` in the chunk, `"debugId"` in its map).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

const COMMENT = /^\/\/# debugId=([0-9a-f-]{36})\s*$/m;

/** SHA-256 of the JS bytes, first 16 as a v4-shaped UUID: the same chunk always gets the same id, so rebuilds are stable. */
export function debugIdFor(js: string): string {
  const h = crypto.createHash('sha256').update(js).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function* jsFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = nodePath.join(dir, e.name);
    if (e.isDirectory()) yield* jsFiles(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

/**
 * For every `<chunk>.js` with a sibling `<chunk>.js.map` under `dir`: append the runtime registration (so the browser SDK sends the id with
 * error frames) and `//# debugId=<uuid>` to the chunk, and set `"debugId"` in the map. Chunks that already carry an id keep it. Returns map path to id.
 * `urlPrefix` is the served path of `dir` (default `/_next/static`).
 */
export function injectDebugIds(dir: string, urlPrefix = '/_next/static'): Map<string, string> {
  const out = new Map<string, string>();
  for (const js of jsFiles(dir)) {
    const mapFile = `${js}.map`;
    if (!fs.existsSync(mapFile)) continue;
    let src = fs.readFileSync(js, 'utf8');
    const old = COMMENT.exec(src);
    const id = old ? old[1]! : debugIdFor(src);
    if (!old) {
      const url = `${urlPrefix}/${nodePath.relative(dir, js).split(nodePath.sep).join('/')}`;
      const snippet = `;(function(){try{var w=typeof window!=="undefined"?window:globalThis;(w._wtDebugIds=w._wtDebugIds||{})[${JSON.stringify(url)}]="${id}"}catch(e){}})();`;
      const m = /\n?\/\/[#@] sourceMappingURL=[^\n]*\s*$/.exec(src);
      const body = m ? src.slice(0, m.index) : src;
      src = `${body}\n${snippet}${m ? `\n${m[0].trim()}` : ''}\n//# debugId=${id}\n`;
      fs.writeFileSync(js, src);
    }
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) as Record<string, unknown>;
    if (map.debugId !== id) fs.writeFileSync(mapFile, JSON.stringify({ ...map, debugId: id }));
    out.set(mapFile, id);
  }
  return out;
}
