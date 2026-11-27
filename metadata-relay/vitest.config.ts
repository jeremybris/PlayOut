import { defineConfig } from 'vitest/config'

// Plain Node environment: the worker only uses web-standard APIs (fetch, Request, Response, TextEncoder,
// crypto.randomUUID), which Node provides. GitHub and KV are faked in the tests; nothing goes over the network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
})
