import type { Remix } from '@remix-run/dom'

import { routes } from '../../routes.ts'

type DocumentProps = {
  title?: string
  children?: Remix.RemixNode
}

export function Document({ title = 'File Sharing Demo', children }: DocumentProps) {
  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script
          src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.16/dist/index.global.js"
          integrity="sha512-KY0iASzs3WhLLaom9T/IZ6gQEKzEc2rIDeZ3/vwDsLzmFQG2JlsELKTqyDDJeVBIuAh92mlHT04LxkInQCGUTA=="
          crossOrigin="anonymous"
        />
        <script type="module" async src={routes.assets.href({ path: 'app.js' })} />
        <title>{title}</title>
      </head>
      <body className="min-h-full bg-slate-950 text-slate-100 antialiased selection:bg-sky-500/30 selection:text-white">
        {children}
      </body>
    </html>
  )
}
