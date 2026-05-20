const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Loads env from repo .env first, then ~/.joruva/secrets.env with override.
// secrets.env is Tom's canonical source of truth (rotated atomically per the
// clone-then-promote discipline) — repo .env is often stale.
//
// Shell env vars set in the calling shell are preserved (snapshot/restore
// around the dotenv loads). Standard Unix expectation is "shell wins over
// dotfiles." Trade-off: an inherited env var from a CI runner or wrapping
// process will also win. If a CI environment defines a default DATABASE_URL
// that you DON'T want, unset it explicitly before invoking these scripts —
// the dotfile values won't override an inherited shell env.
module.exports = function loadEnv() {
  const shellEnv = { ...process.env };
  const repoEnv = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(repoEnv)) dotenv.config({ path: repoEnv });
  if (process.env.HOME) {
    const secretsEnv = path.join(process.env.HOME, '.joruva', 'secrets.env');
    if (fs.existsSync(secretsEnv)) dotenv.config({ path: secretsEnv, override: true });
  }
  // Restore shell precedence. Object.keys returns own keys only — every entry
  // had a string value at snapshot time, so the assignment is unconditional.
  for (const k of Object.keys(shellEnv)) {
    process.env[k] = shellEnv[k];
  }
};
