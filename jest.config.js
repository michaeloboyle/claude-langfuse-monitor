module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'index.js',
    '!**/node_modules/**',
    '!**/__tests__/**',
    '!**/__mocks__/**'
  ],
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/*.test.js'
  ],
  coverageThreshold: {
    './index.js': {
      branches: 55,
      functions: 40,
      lines: 45,
      statements: 45
    }
  },
  // Mock Langfuse to avoid ESM issues
  moduleNameMapper: {
    '^langfuse$': '<rootDir>/__tests__/__mocks__/langfuse.js'
  }
};
