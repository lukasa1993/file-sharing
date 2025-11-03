import { Layout } from '../Layout.tsx'

type ShareUnavailableProps = {
  message: string
}

export function ShareUnavailable({ message }: ShareUnavailableProps) {
  return (
    <Layout>
      <section>
        <h2>Share unavailable</h2>
        <p>{message}</p>
      </section>
    </Layout>
  )
}
