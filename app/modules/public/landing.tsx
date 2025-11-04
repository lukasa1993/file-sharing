import type { RequestContext } from '@remix-run/fetch-router'

import { render } from '../../utils/render.ts'
import { LandingPage } from '../../components/LandingPage.tsx'

export function landingPageHandler(_context: RequestContext) {
  return render(<LandingPage />)
}
