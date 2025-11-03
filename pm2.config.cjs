module.exports = {
  apps: [
    {
      name: 'file-sharing',
      script: 'server.ts',
      interpreter: 'bun',
      env: {
        NODE_ENV: 'production',
        PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      },
    },
    {
      name: 'auto-update:file-sharing',
      script: './scripts/pm2-auto-update.ts',
      interpreter: 'bun',
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
