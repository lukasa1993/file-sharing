import { createCoverageMap } from 'istanbul-lib-coverage'

function countersMatch(template, observed) {
  if (Array.isArray(template)) {
    return (
      Array.isArray(observed) &&
      template.length === observed.length &&
      observed.every((n) => Number.isSafeInteger(n) && n >= 0)
    )
  }
  if (typeof template === 'number')
    return Number.isSafeInteger(observed) && observed >= 0
  if (
    !observed ||
    typeof observed !== 'object' ||
    Object.keys(template).length !== Object.keys(observed).length
  )
    return false
  return Object.entries(template).every(
    ([key, value]) =>
      Object.hasOwn(observed, key) && countersMatch(value, observed[key]),
  )
}

export function createCollector(seed) {
  const map = createCoverageMap(structuredClone(seed))
  function add(path, counts, name) {
    const initial = seed[path]
    if (
      !initial ||
      !['s', 'f', 'b'].every((key) => countersMatch(initial[key], counts[key]))
    )
      throw new Error('Mismatched Istanbul counters in ' + name + ': ' + path)
    // Every process and browser ran this same staged instrumentation. Merge its
    // stable counter IDs directly, preserving distinct branches at overlapping
    // source locations (Istanbul's generic remapping merge matches locations).
    const total = map.fileCoverageFor(path)
    for (const [id, value] of Object.entries(counts.s)) total.s[id] += value
    for (const [id, value] of Object.entries(counts.f)) total.f[id] += value
    for (const [id, arms] of Object.entries(counts.b)) {
      for (let arm = 0; arm < arms.length; arm++) total.b[id][arm] += arms[arm]
    }
  }
  return { map, add }
}
