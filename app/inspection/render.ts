import type { ArchiveItem } from './tar.ts'

const esc = Bun.escapeHTML
const tags =
  /^<\/?(?:p|strong|em|s|blockquote|code|pre|ul|ol|li|table|thead|tbody|tr|th|td|h[2-6]|hr)>$/
const wrap = (tag: string) => (children: string) =>
  '<' + tag + '>' + children + '</' + tag + '>'

/** Allow only fixed structural tags. File-supplied URLs, attributes, and HTML are never forwarded. */
export function renderMarkdown(source: string) {
  const result = Bun.markdown.render(
    source,
    {
      text: esc,
      html: esc,
      heading: (text, meta) => wrap('h' + Math.min(6, meta.level + 1))(text),
      paragraph: wrap('p'),
      strong: wrap('strong'),
      emphasis: wrap('em'),
      strikethrough: wrap('s'),
      blockquote: wrap('blockquote'),
      list: (text, meta) => wrap(meta.ordered ? 'ol' : 'ul')(text),
      listItem: wrap('li'),
      hr: () => '<hr>',
      code: (text) => '<pre><code>' + esc(text) + '</code></pre>',
      codespan: (text) => '<code>' + esc(text) + '</code>',
      table: wrap('table'),
      thead: wrap('thead'),
      tbody: wrap('tbody'),
      tr: wrap('tr'),
      th: wrap('th'),
      td: wrap('td'),
      link: (text) => text,
      image: (text) => text,
    },
    { noHtmlBlocks: true, noHtmlSpans: true, tasklists: false },
  )
  return result.replace(/<[^>]*(?:>|$)/g, (token) =>
    tags.test(token) ? token : esc(token),
  )
}

const keywords = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'def',
  'else',
  'enum',
  'export',
  'false',
  'fn',
  'for',
  'from',
  'func',
  'function',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'let',
  'match',
  'new',
  'null',
  'package',
  'pub',
  'return',
  'struct',
  'switch',
  'throw',
  'true',
  'try',
  'type',
  'use',
  'var',
  'while',
  'yield',
])
const sourceTokens =
  /\/\/[^\r\n]*|#[^\r\n]*|"[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"?|'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'?|\b(?:\d+(?:\.\d+)?|[a-zA-Z_]\w*)\b/g

export function renderSource(source: string, highlight: boolean) {
  const body = !highlight
    ? esc(source)
    : (() => {
        let result = '',
          end = 0
        for (const match of source.matchAll(sourceTokens)) {
          const text = match[0]
          let tag: string
          if (text.startsWith('#') || text.startsWith('//')) tag = 'i'
          else if (text.startsWith('"') || text.startsWith("'")) tag = 'em'
          else if (/^\d/.test(text)) tag = 'mark'
          else if (keywords.has(text)) tag = 'b'
          else continue
          result += esc(source.slice(end, match.index)) + wrap(tag)(esc(text))
          end = match.index + text.length
        }
        return result + esc(source.slice(end))
      })()
  return '<pre><code>' + body + '</code></pre>'
}

export function renderItems(items: ArchiveItem[]) {
  const rows = items
    .map(
      (item) =>
        '<tr><td>' +
        esc(item.name) +
        '</td><td>' +
        (item.kind === 'file' ? 'File' : 'Folder') +
        '</td><td>' +
        (item.kind === 'file' ? String(item.size) : '—') +
        '</td></tr>',
    )
    .join('')
  return (
    '<table><caption>' +
    items.length +
    ' archive ' +
    (items.length === 1 ? 'entry' : 'entries') +
    '</caption>' +
    '<thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Bytes</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  )
}

export function inspectionDocument(
  name: string,
  body: string,
  download: string,
  note?: string,
) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' +
    esc(name) +
    '</title><link rel="stylesheet" href="/assets/files.css"></head><body class="inspection"><main>' +
    '<h1>' +
    esc(name) +
    '</h1><a href="' +
    esc(download) +
    '" download>Download original</a>' +
    (note ? '<p>' + esc(note) + '</p>' : '') +
    '<article>' +
    body +
    '</article></main></body></html>'
  )
}
