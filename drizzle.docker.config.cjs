// Used inside the Docker container at startup.
// Reads the compiled schema from dist/ so no TypeScript tooling is needed at runtime.
// drizzle-kit push applies schema changes directly to the database — no SQL migration
// files are generated or committed to git.
const { defineConfig } = require('drizzle-kit')

module.exports = defineConfig({
  schema: './dist/db/schema/index.js',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
})
