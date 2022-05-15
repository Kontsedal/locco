export default {
  clearMocks: true,
  collectCoverage: true,
  coverageDirectory: "coverage",
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/__tests__/**/*.ts",
    "!src/**/*Interface.ts",
    "!src/index.ts",
  ],
  coverageProvider: "v8",
  testMatch: ["**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
