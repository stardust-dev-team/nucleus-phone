module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/client/src'],
  testMatch: ['**/__tests__/**/*.test.{js,jsx}'],
  transform: {
    '\\.[jt]sx?$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        ['@babel/preset-react', { runtime: 'automatic' }],
      ],
    }],
  },
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy',
    '\\.(svg|png|jpg|gif)$': '<rootDir>/client/src/__mocks__/fileMock.js',
    '^@server-config/(.*)$': '<rootDir>/server/config/$1',
    // Pin React to the root copy. The client subtree's transitive deps
    // (@radix-ui/*, recharts, framer-motion) pull react into
    // client/node_modules even with react/react-dom removed from
    // client/package.json (verified 2026-05-20, nucleus-phone-8la).
    // Jest's resolver then picks the closer client/ copy for components but
    // the farther root copy for @testing-library/react, producing a hook-
    // dispatcher mismatch ("Cannot read properties of null (reading
    // 'useEffect')"). A proper structural dedupe requires npm workspaces;
    // until then these pins are canonical.
    '^react$': '<rootDir>/node_modules/react',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react/jsx-runtime$': '<rootDir>/node_modules/react/jsx-runtime',
    '^react/jsx-dev-runtime$': '<rootDir>/node_modules/react/jsx-dev-runtime',
  },
  setupFilesAfterEnv: ['<rootDir>/client/src/__mocks__/setup.js'],
  clearMocks: true,
};
