import type { Remix } from '@remix-run/dom'

import { routes } from '../../routes.ts'
import { Document } from './Document.tsx'

type LayoutProps = {
  user?: { username: string } | null
  children?: Remix.RemixNode
}

export function Layout({ user, children }: LayoutProps) {
  return (
    <Document>
      <header>
        <nav>
          <ul>
            <li>
              <a href={routes.admin.index.href()}>Admin</a>
            </li>
            {user ? (
              <>
                <li>Signed in as {user.username}</li>
                <li>
                  <form method="POST" action={routes.admin.logout.href()}>
                    <input type="hidden" name="redirect" value={routes.admin.login.index.href()} />
                    <button type="submit">Sign out</button>
                  </form>
                </li>
              </>
            ) : (
              <li>
                <a href={routes.admin.login.index.href()}>Sign in</a>
              </li>
            )}
          </ul>
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <small>File sharing demo</small>
      </footer>
    </Document>
  )
}
