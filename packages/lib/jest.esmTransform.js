// Kysely is only published as an ES module, which Jest 29 cannot load from
// the CommonJS test files, so it is converted to CommonJS here.

const ts = require('typescript');

module.exports = {
	process(sourceText, sourcePath) {
		const output = ts.transpileModule(sourceText, {
			fileName: sourcePath,
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				allowJs: true,
				esModuleInterop: true,
				sourceMap: false,
			},
		});
		return { code: output.outputText };
	},
};
