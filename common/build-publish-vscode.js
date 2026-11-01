const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

async function runVsce(cliPath, projectRoot, args) {
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], {
			cwd: projectRoot,
			stdio: 'inherit',
			shell: false
		});
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`vsce ${args[0]} failed | exitCode=${code} | signal=${signal || 'none'}`));
		});
	});
}

async function main() {
	if (process.argv.length > 2) throw new Error('Place this script in the target project root or its common folder and run it without arguments.');
	const projectRoot = path.basename(__dirname).toLowerCase() === 'common' ? path.dirname(__dirname) : __dirname;
	const folderName = path.basename(projectRoot);
	const entries = await fs.readdir(projectRoot);
	const packagePath = path.join(projectRoot, 'package.json');
	const packageJson = JSON.parse((await fs.readFile(packagePath, 'utf8')).replace(/^\uFEFF/, ''));
	if (!packageJson.engines?.vscode || !packageJson.publisher || !packageJson.name || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
		throw new Error(`Missing VS Code engine, publisher, name, or numeric version in ${packagePath}.`);
	}
	await fs.access(path.join(projectRoot, '.vscodeignore'));
	const requireFromProject = createRequire(packagePath);
	const cliPath = requireFromProject.resolve('@vscode/vsce/vsce');
	const lockPath = path.join(projectRoot, 'package-lock.json');
	const lockJson = entries.includes('package-lock.json')
		? JSON.parse((await fs.readFile(lockPath, 'utf8')).replace(/^\uFEFF/, ''))
		: null;
	const dateParts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Athens', year: 'numeric', month: 'numeric'
	}).formatToParts(new Date());
	const year = Number(dateParts.find(part => part.type === 'year').value) % 100;
	const month = Number(dateParts.find(part => part.type === 'month').value);
	const [previousYear, previousMonth, previousPatch] = packageJson.version.split('.').map(Number);
	const patch = previousYear === year && previousMonth === month ? previousPatch + 1 : 0;
	const version = `${year}.${month}.${patch}`;
	packageJson.version = version;
	await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`, 'utf8');
	if (lockJson) {
		lockJson.version = version;
		if (lockJson.packages?.['']) lockJson.packages[''].version = version;
		await fs.writeFile(lockPath, `${JSON.stringify(lockJson, null, '\t')}\n`, 'utf8');
	}

	const outputPath = path.join(projectRoot, 'output.vsix');
	console.log(`Build | project=${folderName} | version=${version} | output=${outputPath}`);
	await runVsce(cliPath, projectRoot, [
		'package', '--dependencies', '--allow-missing-repository', '--out', outputPath
	]);
	console.log(`Package saved | output=${outputPath}`);
	if (!process.env.VSCE_PAT?.trim()) {
		console.log(`Publish skipped | missing=VSCE_PAT | package=${outputPath}`);
		return;
	}
	try {
		await runVsce(cliPath, projectRoot, ['verify-pat', packageJson.publisher]);
		console.log(`Publish | extension=${packageJson.publisher}.${packageJson.name} | version=${version}`);
		await runVsce(cliPath, projectRoot, ['publish', '--packagePath', outputPath]);
		console.log(`Published | extension=${packageJson.publisher}.${packageJson.name} | version=${version} | package=${outputPath}`);
	} catch (error) {
		console.error(`Publish failed | package=${outputPath} | reason=${error.message}`);
		process.exitCode = 1;
	}
}

main().catch(error => {
	console.error(`Build and publish stopped | reason=${error.message}`);
	process.exitCode = 1;
});
