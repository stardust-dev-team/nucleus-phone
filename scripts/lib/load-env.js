const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load precedence (low → high):
//   1. repo <root>/.env        — fills gaps; may be stale (esp. credentials).
//   2. ~/.joruva/secrets.env   — override:true. Canonical credentials, rotated
//                                atomically via clone-then-promote.
//   3. repo <root>/.env.local  — override:true. Project-context overrides
//                                (e.g. APP_URL when secrets.env's global value
//                                is set for another Joruva project).
//                                Do NOT put credentials here.
//   4. shell env               — always wins. Restored last. (FOOTGUN: do NOT
//                                `export APP_URL` in zshrc — ~/.zshrc already
//                                auto-sources secrets.env with `set -a`, so
//                                shell-exported globals can re-create the leak
//                                that .env.local was added to fix. 2026-05-20.)
//
// CI/wrapping-process inherited vars also win as shell env. If a CI default
// like DATABASE_URL is wrong, unset it before invoking these scripts.
module.exports = function loadEnv() {
  const shellEnv = { ...process.env };
  const repoEnv = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(repoEnv)) dotenv.config({ path: repoEnv });
  if (process.env.HOME) {
    const secretsEnv = path.join(process.env.HOME, '.joruva', 'secrets.env');
    if (fs.existsSync(secretsEnv)) dotenv.config({ path: secretsEnv, override: true });
  }
  const repoEnvLocal = path.join(__dirname, '..', '..', '.env.local');
  if (fs.existsSync(repoEnvLocal)) dotenv.config({ path: repoEnvLocal, override: true });
  for (const k of Object.keys(shellEnv)) {
    process.env[k] = shellEnv[k];
  }
};
