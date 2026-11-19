// Local test runner only (not the shipped entrypoint): listens on a fixed port.
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 18099);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[local] listening on ${port}\n`);
});
