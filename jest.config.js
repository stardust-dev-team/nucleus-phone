module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/server'],
  testMatch: ['**/__tests__/**/*.test.js'],
  forceExit: true,   // conference.js setInterval has no .unref()
  clearMocks: true,
  setupFiles: ['<rootDir>/server/__tests__/setup-env.js'],
};
