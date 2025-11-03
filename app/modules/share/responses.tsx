import { render } from '../../utils/render.ts'
import { ShareUnavailable } from '../../components/share/ShareUnavailable.tsx'
import { UploadShareCompleted } from '../../components/share/UploadShareCompleted.tsx'

export function shareUnavailable(message: string) {
  return render(<ShareUnavailable message={message} />, { status: 404 })
}

export function uploadShareCompleted(message: string) {
  return render(<UploadShareCompleted message={message} />)
}
