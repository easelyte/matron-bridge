import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { startViewerCodeUpdateWatcher } from './code-update.js';

const httpServer = startServer();
// Follow the bridge onto new code (viewer/code-update.js): the checkout is
// the repository this file runs from.
startViewerCodeUpdateWatcher({
  checkoutDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  httpServer,
});
