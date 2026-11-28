import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reviewMutation } from './results.ts'

test('the mutation runner distinguishes an assertion from a fixture failure and Bun deadlines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lshare-mutation-evidence-'))
  try {
    await mkdir(join(dir, '.quality/mutation-runtime'), { recursive: true })
    await writeFile(
      join(dir, 'proof.test.ts'),
      `import {beforeEach,describe,expect,test} from 'bun:test'
test('assertion',()=>expect(1).toBe(2))
test('fixture',()=>{throw Error('Server startup did not complete')})
test('deadline',async()=>{await Bun.sleep(120)},20)
describe('timed hook',()=>{beforeEach(async()=>{await Bun.sleep(120)},20);test('hook',()=>expect(true).toBe(true))})`,
    )
    const plugin = pathToFileURL(join(import.meta.dir, 'runner.mjs')).href
    await writeFile(
      join(dir, 'verify.mjs'),
      `import {strykerPlugins} from ${JSON.stringify(plugin)}
const runner=new strykerPlugins[0].injectableClass()
const results=[]
for(const name of ['assertion','fixture','deadline','timed hook']){
 const r=await runner.execute({kind:'native',args:['./proof.test.ts','-t',name]},process.env)
 results.push([r.code,Boolean(r.infrastructure)])
}
console.log(JSON.stringify(results))`,
    )
    const child = Bun.spawn(['node', 'verify.mjs'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(status, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual([
      [1, false],
      [1, true],
      [1, true],
      [1, true],
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test('unresolved runtime and compilation failures fail the combined score gate', () => {
  const input = (status, id) => ({
    id,
    status,
    mutatorName: 'BooleanLiteral',
    location: { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
  })
  for (const status of ['RuntimeError', 'CompileError'])
    expect(
      reviewMutation({
        'app/proxy.ts': {
          source: 'true',
          language: 'typescript',
          mutants: [input('Killed', '0'), input(status, '1')],
        },
      }),
    ).toBe(1)
})

test('merging a complete shard rechecks the current test fingerprint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lshare-mutation-manifest-'))
  try {
    for (const folder of [
      'app',
      'public',
      'shared',
      'cloudflare',
      'scripts',
      'tests',
    ])
      await mkdir(join(dir, folder))
    for (const file of [
      'server.ts',
      'bun.lock',
      'package.json',
      'tsconfig.json',
      'tsconfig.cloudflare.json',
      'wrangler.jsonc',
      'e2e.config.ts',
    ])
      await writeFile(join(dir, file), '{}')
    await writeFile(join(dir, 'app/example.ts'), 'true')
    await writeFile(join(dir, 'tests/example.test.ts'), 'initial assertion')
    const results = pathToFileURL(join(import.meta.dir, 'results.ts')).href
    await writeFile(
      join(dir, 'verify.ts'),
      `import {mutationFingerprint, readVerifiedMutation} from ${JSON.stringify(results)}
import {createHash} from 'node:crypto'
const source='app/example.ts'
const manifest={fingerprint:await mutationFingerprint([source]),modules:{[source]:{sha256:createHash('sha256').update('true').digest('hex'),ids:[]}}}
await Bun.write('manifest.json',JSON.stringify(manifest))
await Bun.write('report.json',JSON.stringify({config:{mutate:[source]},files:{}}))
await readVerifiedMutation('report.json',new Set([source]))
await Bun.write('tests/example.test.ts','changed assertion')
try {
  await readVerifiedMutation('report.json',new Set([source]))
  process.exitCode=1
} catch(error) {
  if (!String(error).includes('fingerprint mismatch')) throw error
}`,
    )
    const child = Bun.spawn([process.execPath, 'verify.ts'], {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const [status, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect(status, stderr).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
