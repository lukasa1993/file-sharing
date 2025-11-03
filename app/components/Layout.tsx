import type { Remix } from '@remix-run/dom'

import { routes } from '../../routes.ts'
import { Document } from './Document.tsx'
import { primaryButtonClass, secondaryButtonClass } from './ui.ts'

type LayoutProps = {
  user?: { username: string } | null
  children?: Remix.RemixNode
  variant?: 'chrome' | 'minimal'
}

export function Layout({ user, children, variant = 'chrome' }: LayoutProps) {
  let navLinkClass =
    'text-sm font-medium text-slate-300 transition hover:text-white focus-visible:text-white'
  let showChrome = variant === 'chrome'

  return (
    <Document>
      <div className="flex min-h-screen flex-col bg-slate-950 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.15),_transparent_55%)]">
        {showChrome ? (
          <header className="border-b border-slate-800/80 bg-slate-950/60 backdrop-blur">
            <nav className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <a
                href={routes.admin.index.href()}
                className="inline-flex items-center gap-2 text-base font-semibold tracking-tight text-white"
              >
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/20 text-sky-200 ring-1 ring-inset ring-sky-500/50">
                  FS
                </span>
                <span>FileShare Admin</span>
              </a>
              <ul className="flex list-none flex-col gap-3 text-sm text-slate-300 sm:flex-row sm:items-center sm:gap-4">
                <li>
                  <a href={routes.admin.index.href()} className={navLinkClass}>
                    Dashboard
                  </a>
                </li>
                {user ? (
                  <>
                    <li className="text-sm text-slate-300">
                      Signed in as{' '}
                      <span className="font-semibold text-white">{user.username}</span>
                    </li>
                    <li>
                      <form
                        method="POST"
                        action={routes.admin.logout.href()}
                        className="flex items-center"
                      >
                        <input
                          type="hidden"
                          name="redirect"
                          value={routes.admin.login.index.href()}
                        />
                        <button type="submit" className={secondaryButtonClass}>
                          Sign out
                        </button>
                      </form>
                    </li>
                  </>
                ) : (
                  <li>
                    <a href={routes.admin.login.index.href()} className={primaryButtonClass}>
                      Sign in
                    </a>
                  </li>
                )}
              </ul>
            </nav>
          </header>
        ) : null}
        <main className="mx-auto flex w-full max-w-5xl grow flex-col gap-10 px-4 py-12">
          {variant === 'minimal' ? (
            <section className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-800/60 bg-slate-950/40 px-6 py-5 text-center shadow-lg shadow-slate-950/40">
              <h1 className="text-lg font-semibold tracking-tight text-white">
                Private file sharing
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">
                This space only responds to valid share links. If you don&apos;t have a link,
                nothing will happen.
              </p>
            </section>
          ) : null}
          {children}
        </main>
        {showChrome ? (
          <footer className="border-t border-slate-800/70 bg-slate-950/70">
            <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-5 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
              <small className="font-medium tracking-wide text-slate-300">
                File sharing demo
              </small>
              <span className="text-xs uppercase tracking-[0.25em] text-slate-500">
                Secure transfers made simple
              </span>
            </div>
          </footer>
        ) : null}
      </div>
    </Document>
  )
}
