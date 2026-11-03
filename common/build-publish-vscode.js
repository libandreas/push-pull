/*
 * Δημοσίευση VS Code με Microsoft Entra από το .env στη ρίζα του project.
 * Απαιτούνται AZURE_TENANT_ID, AZURE_CLIENT_ID και AZURE_CLIENT_SECRET.
 * Το secret που δημιουργήθηκε στις 03/11/2026 λήγει στις 02/11/2028.
 *
 * Αντικατάσταση secret πριν ή μετά τη λήξη:
 * 1. https://portal.azure.com → App registrations → VS Code Publishing.
 * 2. Certificates & secrets → Client secrets → New client secret.
 * 3. Επίλεξε διάρκεια έως 24 μήνες και πάτησε Add.
 * 4. Αντέγραψε αμέσως το Value, όχι το Secret ID. Εμφανίζεται μόνο μία φορά.
 * 5. Αντικατάστησε το AZURE_CLIENT_SECRET στο root .env κάθε σχετικού project.
 *    Τα AZURE_TENANT_ID και AZURE_CLIENT_ID παραμένουν ίδια.
 * 6. Αφού επιβεβαιώσεις ότι λειτουργεί το νέο secret, διέγραψε το παλιό στο Azure.
 * Η ίδια τιμή secret δεν ανανεώνεται. Χρειάζεται νέο secret.
 * Το access token λαμβάνεται αυτόματα, χωρίς σύνδεση στον browser.
 * Μην προσθέτεις μυστικά εδώ. Τα .env εξαιρούνται μέσω .vscodeignore/.chromeignore.
 */
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
	process.loadEnvFile(path.join(projectRoot, '.env'));
	const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].filter(name => !process.env[name]?.trim());
	if (missing.length) throw new Error(`Missing publishing credentials in root .env: ${missing.join(', ')}`);
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
	const vsceRoot = path.dirname(cliPath);
	const { getAzureCredentialAccessToken } = require(path.join(vsceRoot, 'out/auth.js'));
	const { getGalleryAPI } = require(path.join(vsceRoot, 'out/util.js'));
	const extensionId = `${packageJson.publisher}.${packageJson.name}`;
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
	try {
		console.log(`Έλεγχος καταχώρισης | extension=${extensionId}`);
		const accessToken = await getAzureCredentialAccessToken();
		const gallery = await getGalleryAPI(accessToken);
		try {
			const extension = await gallery.getExtension(null, packageJson.publisher, packageJson.name);
			if (!extension?.extensionId) throw new Error('Το Marketplace δεν επέστρεψε αναγνωριστικό υπάρχουσας επέκτασης.');
		} catch (error) {
			if (error.statusCode === 404) {
				console.log(`Δεν έγινε upload | Δεν βρέθηκε προσβάσιμη αρχική καταχώριση για ${extensionId}. Δημιούργησέ την πρώτα στο https://marketplace.visualstudio.com/manage/publishers/${packageJson.publisher} και έλεγξε τα δικαιώματα της εφαρμογής. | package=${outputPath}`);
				return;
			}
			throw error;
		}
		console.log(`Η καταχώριση βρέθηκε | extension=${extensionId}`);
		console.log(`Publish | extension=${packageJson.publisher}.${packageJson.name} | version=${version}`);
		await runVsce(cliPath, projectRoot, ['publish', '--azure-credential', '--packagePath', outputPath]);
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
