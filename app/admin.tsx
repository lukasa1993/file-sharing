import type { RouteHandlers } from '@remix-run/fetch-router'
import type { routes } from '../routes.ts'
import { adminDashboard } from './modules/admin/dashboard.tsx'
import {
  adminUpload,
  adminDeleteFile,
  adminCreateDirectory,
  adminDeleteDirectory,
  adminMoveEntries,
} from './modules/admin/files.ts'
import {
  adminCreateDownloadShare,
  adminCreateUploadShare,
  adminRevokeShare,
} from './modules/admin/shares.ts'
import { adminLoginView, adminLoginAction, adminLogout } from './modules/auth/admin.tsx'

export default {
  index: adminDashboard,
  upload: adminUpload,
  deleteFile: adminDeleteFile,
  createDirectory: adminCreateDirectory,
  deleteDirectory: adminDeleteDirectory,
  moveEntries: adminMoveEntries,
  createDownloadShare: adminCreateDownloadShare,
  createUploadShare: adminCreateUploadShare,
  revokeShare: adminRevokeShare,
  login: {
    index: adminLoginView,
    action: adminLoginAction,
  },
  logout: adminLogout,
} satisfies RouteHandlers<typeof routes.admin>
