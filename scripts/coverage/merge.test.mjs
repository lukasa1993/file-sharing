import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { createInstrumenter } from 'istanbul-lib-instrument'
import { createCollector } from './merge.mjs'

test('merges independent Istanbul observations and retains all unexecuted branches', () => {
  const instrumenter = createInstrumenter({
    coverageGlobalScope: 'globalThis',
    coverageGlobalScopeFunc: false,
  })
  const source =
    'function choose(value) { return value ? "yes" : "no" } choose(input)'
  const code = instrumenter.instrumentSync(source, 'choose.js')
  const first = instrumenter.lastFileCoverage()
  instrumenter.instrumentSync(source, 'never-loaded.js')
  const seed = {
    'choose.js': first,
    'never-loaded.js': instrumenter.lastFileCoverage(),
  }
  const { map, add } = createCollector(seed)
  for (const input of [true, false]) {
    const context = { input }
    runInNewContext(code, context)
    add('choose.js', context.__coverage__['choose.js'], 'real vm context')
  }
  const measured = map.getCoverageSummary().branches
  expect(measured.covered).toBe(2)
  expect(measured.total).toBe(4)
  expect(map.fileCoverageFor('choose.js').b[0]).toEqual([1, 1])
  expect(map.fileCoverageFor('never-loaded.js').b[0]).toEqual([0, 0])
  expect(first.b[0]).toEqual([0, 0])
  expect(() => add('wrong.js', first, 'fixture')).toThrow(
    'Mismatched Istanbul counters',
  )
  expect(() =>
    add('choose.js', { ...first, b: { 0: [1] } }, 'fixture'),
  ).toThrow('Mismatched Istanbul counters')
  expect(() =>
    add('choose.js', { ...first, b: { 0: [1, -1] } }, 'fixture'),
  ).toThrow('Mismatched Istanbul counters')
})
