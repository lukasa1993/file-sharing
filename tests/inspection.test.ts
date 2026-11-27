import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError, type Guard } from '../app/contracts.ts'
import { Filesystem } from '../app/filesystem/index.ts'
import { marker } from '../app/filesystem/resolver.ts'
import { inspectFile } from '../app/inspection/index.ts'
import {
  inspectionDocument,
  renderItems,
  renderMarkdown,
  renderSource,
} from '../app/inspection/render.ts'
import { listTarHeaders, UnsupportedInspection } from '../app/inspection/tar.ts'

let mount: string
let database: Database
let fs: Filesystem
const allow: Guard = () => {}
const request = (method = 'GET') =>
  new Request('http://localhost/_/inspect', { method })
const ref = (name: string) => ({ mountId: 'archive-tests', segments: [name] })
beforeEach(async () => {
  mount = await mkdtemp(join(tmpdir(), 'fileserver-inspection-'))
  database = new Database(':memory:')
  await writeFile(join(mount, marker), 'inspection-fixture\n')
  fs = new Filesystem(
    [
      {
        id: 'archive-tests',
        label: 'Documents',
        path: mount,
        sentinel: 'inspection-fixture',
        readOnly: true,
      },
    ],
    database,
  )
})
afterEach(async () => {
  database.close()
  await rm(mount, { recursive: true, force: true })
})

function header(name: string, type: '0' | '2' | '5', size: number) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  const field = (start: number, length: number, n: number) =>
    h.write(n.toString(8).padStart(length - 1, '0') + '\0', start, length)
  field(100, 8, 0o644)
  field(108, 8, 0)
  field(116, 8, 0)
  field(124, 12, size)
  field(136, 12, 0)
  h.fill(32, 148, 156)
  h.write(type, 156)
  if (type === '2') h.write('sample.txt', 157)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(
    h
      .reduce((total, v) => total + v, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
  )
  return h
}
describe('bounded archive inventory', () => {
  test('seeks across a large sparse payload and lists names, types and original sizes', async () => {
    const h = await open(join(mount, 'fixtures.tar'), 'w+')
    const size = 512 * 1024 * 1024
    try {
      await h.write(header('files/', '5', 0), 0, 512, 0)
      await h.write(header('files/sample.bin', '0', size), 0, 512, 512)
      const end = 1024 + size
      await h.write(Buffer.alloc(1024), 0, 1024, end)
      expect(
        await listTarHeaders(h, end + 1024, AbortSignal.timeout(5000)),
      ).toEqual([
        { name: 'files/', kind: 'directory', size: 0 },
        { name: 'files/sample.bin', kind: 'file', size },
      ])
    } finally {
      await h.close()
    }
  })
  test('refuses incomplete, excessive or unsupported metadata and honours cancellation', async () => {
    const h = await open(join(mount, 'inventory.tar'), 'w+')
    try {
      await h.write(header('short.bin', '0', 4096), 0, 512, 0)
      await h.truncate(1536)
      await expect(
        listTarHeaders(h, 1536, AbortSignal.timeout(5000)),
      ).rejects.toBeInstanceOf(UnsupportedInspection)
      await h.write(Buffer.alloc(512), 0, 512, 0)
      await expect(
        listTarHeaders(h, 512, AbortSignal.timeout(5000)),
      ).rejects.toBeInstanceOf(UnsupportedInspection)
      await expect(
        listTarHeaders(h, 1536, AbortSignal.abort(new Error('cancelled'))),
      ).rejects.toThrow('cancelled')
      const many = Buffer.concat([
        ...Array.from({ length: 1001 }, (_, i) => header('file-' + i, '0', 0)),
        Buffer.alloc(1024),
      ])
      await h.write(many, 0, many.length, 0)
      await expect(
        listTarHeaders(h, many.length, AbortSignal.timeout(5000)),
      ).rejects.toBeInstanceOf(UnsupportedInspection)
    } finally {
      await h.close()
    }
  })
})
test('rejects damaged headers, invalid terminators and unsupported TAR members', async () => {
  const block = Buffer.alloc(512)
  const normal = header('sample.txt', '0', 0)
  const malformed = Buffer.from(normal)
  malformed[0] = 120
  const cases = [
    { bytes: Buffer.concat([normal, block]), reason: 'terminator' },
    { bytes: Buffer.concat([block, normal]), reason: 'after the archive' },
    { bytes: Buffer.concat([normal, normal]), reason: 'terminator missing' },
    { bytes: Buffer.concat([malformed, block, block]), reason: 'header' },
    {
      bytes: Buffer.concat([header('details', '2', 0), block, block]),
      reason: 'ordinary file and directory',
    },
    {
      bytes: Buffer.concat([header('one\ntwo', '0', 0), block, block]),
      reason: 'archive filename',
    },
    { bytes: block, size: 1024, reason: 'header was complete' },
  ]
  for (const item of cases) {
    const h = await open(join(mount, 'inventory.tar'), 'w+')
    try {
      await h.write(item.bytes)
      await expect(
        listTarHeaders(
          h,
          item.size ?? item.bytes.length,
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow(item.reason)
    } finally {
      await h.close()
    }
  }
})

describe('formatted document inspection', () => {
  test('preserves code punctuation and Markdown structures in ordinary documents', () => {
    const html = renderMarkdown(
      [
        '###### Topic',
        'Use *emphasis*, ~~old~~ and `x < y & z`.',
        '> Quote',
        '1. First\n2. Second',
        '- A\n- B',
        '---',
        '| Name | Size |\n| ---- | ---- |\n| A | 5 |',
        '~~~text\n<n> &amp;\n~~~',
      ].join('\n\n'),
    )
    expect(html).toBe(
      [
        '<h6>Topic</h6><p>Use <em>emphasis</em>, <s>old</s> and <code>x &lt; y &amp; z</code>.</p>',
        '<blockquote><p>Quote</p></blockquote><ol><li>First</li><li>Second</li></ol>',
        '<ul><li>A</li><li>B</li></ul><hr>',
        '<table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>A</td><td>5</td></tr></tbody></table>',
        '<pre><code>&lt;n&gt; &amp;amp;\n</code></pre>',
      ].join(''),
    )
  })
  test('renders allowed Markdown structure with inert links and image descriptions', () => {
    const html = renderMarkdown(
      '# Notes\n\nRead **carefully**. [Reference](https://example.invalid/manual)\n\n![Map](https://example.invalid/map.png)\n\n<aside data-example="1">literal HTML</aside>',
    )
    expect(html).toContain('<h2>Notes</h2>')
    expect(html).toContain('<strong>carefully</strong>')
    expect(html).toContain('Reference')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<aside')
  })
  test('renders a TAR inventory as escaped metadata without payloads', async () => {
    const bytes = Buffer.concat([
      header('photos/', '5', 0),
      header('photos/<summer>.txt', '0', 8),
      Buffer.from('contents'.padEnd(512, '\0')),
      Buffer.alloc(1024),
    ])
    await writeFile(join(mount, 'photos.tar'), bytes)
    const response = await inspectFile(request(), ref('photos.tar'), allow, fs)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('2 archive entries')
    expect(html).toContain('<td>photos/</td><td>Folder</td>')
    expect(html).toContain(
      '<td>photos/&lt;summer&gt;.txt</td><td>File</td><td>8</td>',
    )
    expect(html).not.toContain('contents')
  })
  test('refuses writes and renders a download link for malformed UTF-8 text', async () => {
    const unsupported = await inspectFile(
      request('POST'),
      ref('raw.txt'),
      allow,
      fs,
    )
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('Allow')).toBe('GET, HEAD')
    await writeFile(join(mount, 'raw.txt'), Buffer.from([0xff, 0xfe]))
    const response = await inspectFile(request(), ref('raw.txt'), allow, fs)
    expect(response.status).toBe(415)
    expect(await response.text()).toContain('outside the supported UTF-8')
  })
  test('retains source text and highlights tokens without interpreting markup', () => {
    const src = 'const message = "<aside>"; // note'
    const html = renderSource(src, true)
    expect(html).toContain('<b>const</b>')
    expect(html).toContain('&lt;aside&gt;')
    expect(html).toContain('<i>// note</i>')
    expect(renderSource(src, false)).not.toContain('<b>')
  })
  test('distinguishes identifiers, numbers, strings and comments and preserves their boundaries', () => {
    const lines = [
      "if (item2 == 12.50) return 'a\\'b'; // end",
      '# count 40',
      'const value = "quoted";',
      "let unfinished = 'open",
    ]
    expect(renderSource(lines.join('\n'), true)).toBe(
      '<pre><code>' +
        [
          '<b>if</b> (item2 == <mark>12.50</mark>) <b>return</b> <em>&#x27;a\\&#x27;b&#x27;</em>; <i>// end</i>',
          '<i># count 40</i>',
          '<b>const</b> value = <em>&quot;quoted&quot;</em>;',
          '<b>let</b> unfinished = <em>&#x27;open</em>',
        ].join('\n') +
        '</code></pre>',
    )
    expect(renderSource('item42 < 3', false)).toBe(
      '<pre><code>item42 &lt; 3</code></pre>',
    )
  })
  test('labels empty and one-member archives and shows a usable original download', () => {
    const empty = renderItems([])
    expect(empty).toContain('<caption>0 archive entries</caption>')
    expect(empty).toContain('<th scope="col">Bytes</th>')
    const single = renderItems([
      { name: 'Notes & drafts', kind: 'file', size: 0 },
    ])
    expect(single).toContain('<caption>1 archive entry</caption>')
    expect(single).toContain(
      '<tr><td>Notes &amp; drafts</td><td>File</td><td>0</td></tr>',
    )
    const doc = inspectionDocument(
      'Notes & drafts',
      single,
      '/original',
      'First page only',
    )
    expect(doc).toContain('<title>Notes &amp; drafts</title>')
    expect(doc).toContain(
      '<h1>Notes &amp; drafts</h1><a href="/original" download>Download original</a>',
    )
    expect(doc).toContain(
      '<p>First page only</p><article>' + single + '</article>',
    )
    expect(inspectionDocument('Empty', empty, '/empty')).toContain(
      'Download original</a><article>',
    )
  })
  test('returns a sandboxed private preview and releases scoped handles after GET and HEAD', async () => {
    await writeFile(join(mount, 'notes.md'), '# Field notes')
    const page = await inspectFile(request(), ref('notes.md'), allow, fs)
    expect(page.status).toBe(200)
    expect(page.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    )
    expect(page.headers.get('Cache-Control')).toContain('no-store')
    expect(await page.text()).toContain('<h2>Field notes</h2>')
    const head = await inspectFile(request('HEAD'), ref('notes.md'), allow, fs)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const denied: Guard = () => {
      throw new AppError(403, 'Denied')
    }
    await expect(
      inspectFile(request(), ref('notes.md'), denied, fs),
    ).rejects.toMatchObject({ status: 403 })
  })
  test('identifies truncated source and offers attachments for unsupported or binary documents', async () => {
    await writeFile(
      join(mount, 'long.ts'),
      ' '.repeat(70 * 1024) + 'END_MARKER',
    )
    const page = await inspectFile(request(), ref('long.ts'), allow, fs)
    const text = await page.text()
    expect(text).toContain('first 64 KiB')
    expect(text).not.toContain('END_MARKER')
    for (const [name, bytes] of [
      ['raw.html', '<aside>hello</aside>'],
      ['binary.md', 'abc\0def'],
    ] as const) {
      await writeFile(join(mount, name), bytes)
      const res = await inspectFile(request(), ref(name), allow, fs)
      expect(res.status).toBe(415)
      expect(await res.text()).toContain('Download original')
    }
  })
})
