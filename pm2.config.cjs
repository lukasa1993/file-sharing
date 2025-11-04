module.exports = {
  apps: [
    {
      name: 'file-sharing',
      script: '/bin/sh',
      args: "-lc 'bun server.ts'",
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
    },
    {
      name: 'auto-update:file-sharing',
      script: '/bin/sh',
      args: "-lc 'bun ./scripts/pm2-auto-update.ts'",
      interpreter: 'none',
      cron_restart: '*/10 * * * *',
      autorestart: false,
      watch: false,
      time: true,
      env: {
        APP_NAME: 'file-sharing',
        BRANCH: 'main',
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
    },
  ],
}
