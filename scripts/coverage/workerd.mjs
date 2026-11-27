import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Only disposable coverage and Stryker trees receive these wrappers. Their
// private probe runs after the test, outside every production request path.
export async function prepareWorkerd(root) {
  const fixture = join(root, 'scripts/cloud-fixture.ts')
  const source = await readFile(fixture, 'utf8')
  const ready =
    /^([ \t]*await ready\(app\s*\+\s*'\/',\s*wrangler,\s*signal\.signal\))$/m
  const stop = /^([ \t]*await stop\(wrangler\))$/m
  if (!ready.test(source) || !stop.test(source))
    throw new Error(
      'The cloud fixture lifecycle changed; update the workerd observation hook.',
    )
  await rename(
    join(root, 'scripts/cloud-worker-fixture.mjs'),
    join(root, 'scripts/cloud-worker-base.mjs'),
  )
  const staged = source
    .replace(ready, '$1\n  qualityOrigin = app')
    .replace(
      stop,
      '  if (qualityOrigin) {\n    try { await collectWorkerd(qualityOrigin) } catch (error) { console.error(error); process.exitCode = 1 }\n  }\n$1',
    )
  await writeFile(
    fixture,
    "import { collectWorkerd } from './cloud-worker-probe-client.mjs';\nlet qualityOrigin;\n" +
      staged,
  )
}

export async function observeWorkerd(root, directory, kind, active = null) {
  const path = '/__local_quality_' + randomUUID()
  const init =
    kind === 'mutation'
      ? `globalThis.__stryker__ = ${active === null ? '{mutantCoverage:{static:{},perTest:{}}}' : JSON.stringify({ activeMutant: active })};`
      : ''
  await writeFile(join(root, 'scripts/cloud-worker-probe-init.mjs'), init)
  const imports = "import './cloud-worker-probe-init.mjs';\n"
  const entry = join(root, 'scripts/cloud-worker-fixture.mjs'),
    client = join(root, 'scripts/cloud-worker-probe-client.mjs')
  if (!directory) {
    await writeFile(
      entry,
      imports +
        "export { default, CloudWorkspace } from './cloud-worker-base.mjs';\n",
    )
    await writeFile(client, 'export async function collectWorkerd() {}\n')
    return
  }
  const values =
    kind === 'mutation'
      ? 'globalThis.__stryker__?.mutantCoverage?.static ?? {}'
      : 'Object.fromEntries(Object.entries(globalThis.__coverage__ ?? {}).map(([file,{s,f,b}])=>[file,{s,f,b}]))'
  await writeFile(
    entry,
    imports +
      `
    import base, {CloudWorkspace as BaseWorkspace} from './cloud-worker-base.mjs';
    import {workspace} from '../cloudflare/worker.ts';
    const path = ${JSON.stringify(path)};
    let id;
    const snapshot = () => ({id: id ??= crypto.randomUUID(),files:${values}});
    export class CloudWorkspace extends BaseWorkspace {
      fetch(request,...args) {
        if (new URL(request.url).pathname === path) return Response.json(snapshot());
        return super.fetch(request,...args);
      }
    }
    export default {
      async fetch(request,env,...args) {
        if (new URL(request.url).pathname === path) {
          const child = await workspace(env).fetch('https://internal' + path);
          if (!child.ok) throw new Error('The local Durable Object observation failed.');
          return Response.json([await child.json(),snapshot()]);
        }
        return base.fetch(request,env,...args);
      },
      scheduled(...args) { return base.scheduled(...args) }
    };
  `,
  )
  await writeFile(
    client,
    `
    import {writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    export async function collectWorkerd(origin) {
      if(new URL(origin).hostname !== '127.0.0.1') throw new Error('The workerd observation must use the local fixture.');
      const response = await fetch(origin+${JSON.stringify(path)},{redirect:'error',signal:AbortSignal.timeout(10000)});
      if(!response.ok) throw new Error('Missing workerd observation: '+response.status);
      const snapshots = await response.json();
      if(!Array.isArray(snapshots) || snapshots.length !== 2) throw new Error('Missing Worker or Durable Object observation.');
      const unique = new Map(snapshots.map((snapshot)=>[snapshot.id,snapshot.files]));
      for(const [id,files] of unique) {
        if(!/^[a-f0-9-]{36}$/.test(id) || !files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid workerd observation.');
        const output=join(${JSON.stringify(directory)}, 'workerd-'+id);
        if (${JSON.stringify(kind)} === 'mutation') {
          const ids=Object.keys(files);
          if(ids.some((value)=>!/^\\d+$/.test(value))) throw new Error('Invalid workerd mutation ID.');
          await writeFile(output+'.ids', ids.join('\\n'),{mode:0o600,flag:'wx'});
        } else {
          if(!Object.keys(files).length) throw new Error('The workerd isolate reported no module counters.');
          await writeFile(output+'.json',JSON.stringify({complete:true,files}),{mode:0o600,flag:'wx'});
        }
      }
    }
  `,
  )
}
