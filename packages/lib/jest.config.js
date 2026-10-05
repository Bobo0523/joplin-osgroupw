const baseConfig = require('../../jest.config.base.js');
const esmModulesConfig = require('../../jest.esmModules.js');

const testPathIgnorePatterns = [
	'<rootDir>/node_modules/',
	'<rootDir>/rnInjectedJs/',
	'<rootDir>/vendor/',
];

if (!process.env.IS_CONTINUOUS_INTEGRATION) {
	// We don't require all developers to have Rust to run the project, so we skip this test if not running in CI
	testPathIgnorePatterns.push('<rootDir>/services/interop/InteropService_Importer_OneNote.*');
}

module.exports = {
	...baseConfig,
	testMatch: [
		'**/*.test.js',
	],

	...esmModulesConfig(),

	testPathIgnorePatterns: testPathIgnorePatterns,

	testEnvironment: 'node',

	setupFilesAfterEnv: [
		'jest-expect-message',
		`${__dirname}/jest.setup.js`,
	],
	slowTestThreshold: 40,
};
