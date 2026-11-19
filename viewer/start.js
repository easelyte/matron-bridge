// Load `.env` from the working directory before ./server.js is evaluated: it
// reads HMAC_SECRET and the port at module load. Not every supervisor passes
// the environment (the Windows Scheduled Task does not). A variable that is
// already set keeps its value, so a systemd EnvironmentFile or a launchd
// plist still decides.
import 'dotenv/config';
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
