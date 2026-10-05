// Some dependencies, such as Kysely, are only published as ES modules, which
// Jest cannot load from CommonJS code. This config converts them to CommonJS.
// Other files use the given transforms, which default to the Jest default.

const esmModules = ['kysely'];

module.exports = (otherTransforms = { '\\.[jt]sx?$': 'babel-jest' }) => {
	return {
		transform: {
			[`/node_modules/(${esmModules.join('|')})/.+\\.js$`]: `${__dirname}/jest.esmTransform.js`,
			...otherTransforms,
		},
		transformIgnorePatterns: [
			`/node_modules/(?!(${esmModules.join('|')})/)`,
		],
	};
};
