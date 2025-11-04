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
  ],
}
