import type { Remix } from '@remix-run/dom'

type DocumentProps = {
  title?: string
  children?: Remix.RemixNode
}

export function Document({ title = 'File Sharing Demo', children }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
        <title>{title}</title>
      </head>
      <body>{children}</body>
    </html>
  )
}
