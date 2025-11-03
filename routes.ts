import { route } from '@remix-run/fetch-router'

export let routes = route({
  uploads: '/uploads/*key',

  admin: route('/admin', {
    index: '/',
    upload: { method: 'POST', pattern: '/upload' },
    deleteFile: { method: 'POST', pattern: '/delete' },
    createDirectory: { method: 'POST', pattern: '/directory/create' },
    deleteDirectory: { method: 'POST', pattern: '/directory/delete' },
    moveEntries: { method: 'POST', pattern: '/move' },
    createDownloadShare: { method: 'POST', pattern: '/share/download' },
    createUploadShare: { method: 'POST', pattern: '/share/upload' },
    revokeShare: { method: 'POST', pattern: '/share/revoke' },
    login: route('/login', {
      index: { method: 'GET', pattern: '/' },
      action: { method: 'POST', pattern: '/' },
    }),
    logout: { method: 'POST', pattern: '/logout' },
  }),

  share: {
    download: '/share/download/:token',
    upload: route('/share/upload/:token', {
      index: { method: 'GET', pattern: '/' },
      action: { method: 'POST', pattern: '/' },
    }),
  },
})
