module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/server'],
  testMatch: ['**/__tests__/**/*.test.js'],
  forceExit: true,   // conference.js setInterval has no .unref()
  clearMocks: true,
  // jsec-kh7h: no-bare-listen arms a tripwire against the IPv6-wildcard listen(0) hazard.
  setupFiles: [
    '<rootDir>/server/__tests__/setup-env.js',
    '<rootDir>/server/__tests__/no-bare-listen-setup.js',
  ],
};
