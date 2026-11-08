'use strict';

/**
 * Resolve the Markdown vault the tests should read, the same way the server does.
 *
 * Tests used to hard-code `<repo>/md`, so a vault configured in the admin
 * setting (config.json `settings.mdRoot`) or via MD_ROOT was ignored: the tests
 * saw an empty `md/` and either skipped or failed for lack of sutra text.
 *
 * Priority: MD_ROOT env > config.json settings.mdRoot (via lib/config.getMdRoot,
 * which also falls back to `<repo>/md`).
 */
const path = require('node:path');

function resolveTestMdRoot() {
  if (process.env.MD_ROOT) return path.resolve(process.env.MD_ROOT);
  return path.resolve(require('../../lib/config').getMdRoot());
}

module.exports = { resolveTestMdRoot };
