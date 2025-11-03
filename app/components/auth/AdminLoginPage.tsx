import { Layout } from '../Layout.tsx'
import { LoginForm } from './LoginForm.tsx'

type AdminLoginPageProps = {
  actionUrl: string
  error?: string
}

export function AdminLoginPage({ actionUrl, error }: AdminLoginPageProps) {
  return (
    <Layout>
      <LoginForm error={error} actionUrl={actionUrl} />
    </Layout>
  )
}
