import { Layout } from './Layout.tsx'

export function LandingPage() {
  return (
    <Layout variant="minimal">
      <section className="mx-auto w-full max-w-2xl space-y-8 rounded-3xl border border-slate-800/70 bg-slate-950/60 p-8 text-center shadow-xl shadow-slate-950/40 backdrop-blur">
        <header className="space-y-3">
          <span className="inline-flex items-center justify-center rounded-full border border-sky-500/40 bg-sky-500/10 px-4 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-sky-200">
            Private dropzone
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Access by invitation only
          </h1>
        </header>
        <p className="text-sm leading-relaxed text-slate-300 sm:text-base">
          Everything here is gated. With the right link you slip straight into your files. Without
          one, this is all you see.
        </p>
        <div className="space-y-2 rounded-2xl border border-slate-800/60 bg-slate-900/60 px-6 py-5 text-left text-sm text-slate-200 sm:text-base">
          <p className="font-medium text-white">Have a link?</p>
          <p className="text-slate-300">Drop it in the address bar and press enter.</p>
        </div>
        <p className="text-xs uppercase tracking-[0.35em] text-slate-500">
          No index • No guesses • No noise
        </p>
      </section>
    </Layout>
  )
}
