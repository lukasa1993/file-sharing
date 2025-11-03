import { Layout } from '../Layout.tsx'

type UploadShareCompletedProps = {
  message: string
}

export function UploadShareCompleted({ message }: UploadShareCompletedProps) {
  return (
    <Layout>
      <section>
        <h2>Uploads received</h2>
        <p>{message}</p>
      </section>
    </Layout>
  )
}
