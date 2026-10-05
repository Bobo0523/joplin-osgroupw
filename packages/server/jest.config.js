const baseConfig = require('../../jest.config.base.js');
const esmModulesConfig = require('../../jest.esmModules.js');

module.exports = {
	...baseConfig,
	...esmModulesConfig(),

	testMatch: [
		'**/*.test.js',
	],

	testPathIgnorePatterns: [
		'<rootDir>/node_modules/',
		'<rootDir>/assets/',
	],

	testEnvironment: 'node',

	slowTestThreshold: 60,

	setupFilesAfterEnv: [
		'jest-expect-message',
		`${__dirname}/jest.setup.js`,
	],
};
