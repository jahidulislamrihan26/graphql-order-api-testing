import { createApp } from './app.js';

const app = await createApp();
console.log(`Order service listening on ${app.url}  (GraphQL at /graphql, webhooks at /webhooks/*, health at /health)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
