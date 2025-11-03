module.exports = {
	title: "File Sharing", // Name of your application
	script: "server.ts", // Entry point of your application
	interpreter: "bun", // Bun interpreter
	env: {
		PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`, // Add "~/.bun/bin/bun" to PATH
	},
};
