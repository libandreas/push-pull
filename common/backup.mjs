import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputRoot = path.join(homedir(), 'WebSites Backups');
const backupDate = formatDate(new Date());

const ignoredDirectoryNames = new Set([
	'.git',
	'.codex',
	'.codex-remote-attachments',
	'.qodo',
	'.skia',
	'.tmp',
	'.vscode',
	'.vs',
	'.idea',
	'.zed',
	'node_modules',
	'dist',
	'build',
	'.gradle',
	'.gradle-runtime',
	'.intellijplatform',
	'out',
	'output',
	'test',
	'tests',
	'test-files',
	'fontawesome',
	'dictionaries',
	'directories',
	'configs',
	'models',
	'models-v3',
	'tessdata',
	'reports'
]);
const crcTable = createCrc32Table();

async function main() {
	const projectName = path.basename(projectRoot);
	const outputPath = path.join(outputRoot, `${projectName}-${backupDate}.zip`);
	const temporaryPath = `${outputPath}.partial`;
	console.log(`Project: ${projectName}\nDestination: ${outputRoot}`);
	await fs.mkdir(outputRoot, { recursive: true });

	try {
		const files = await collectFiles(projectRoot, projectRoot);
		await createZip(files, temporaryPath);
		await fs.rename(temporaryPath, outputPath);
		console.log(`Backup: ${outputPath}\nFiles: ${files.length}`);
	} catch (error) {
		console.error(`Failed: ${projectName}: ${error.message}`);
		process.exitCode = 1;
		await fs.rm(temporaryPath, { force: true }).catch(() => {});
	}
}

async function collectFiles(directory, root) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.name.toLowerCase().startsWith('output.')) continue;

		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!ignoredDirectoryNames.has(entry.name.toLowerCase())) {
				files.push(...await collectFiles(absolute, root));
			}
			continue;
		}

		if (entry.isFile()) {
			files.push({ absolute, relative: toPosixPath(path.relative(root, absolute)) });
		}
	}

	return files;
}

async function createZip(files, zipPath) {
	await fs.mkdir(path.dirname(zipPath), { recursive: true });

	const handle = await fs.open(zipPath, 'w');
	const centralDirectoryEntries = [];
	let offset = 0;

	if (files.length >= 65535) throw new Error('This ZIP format supports fewer than 65535 files per project.');

	try {
		for (const file of files) {
			console.log(`Pack: ${file.relative}`);
			const stats = await fs.stat(file.absolute);
			if (stats.size >= 0xffffffff) throw new Error(`File exceeds the ZIP size limit: ${file.relative}`);
			const data = await fs.readFile(file.absolute);
			const compressedData = compressZipData(data);
			const compressionMethod = compressedData === data ? 0 : 8;
			const nameBuffer = Buffer.from(file.relative, 'utf8');
			const crc32 = computeCrc32(data);
			const dosTimestamp = toDosTimestamp(stats.mtime);

			if (offset + 30 + nameBuffer.length + compressedData.length >= 0xffffffff) {
				throw new Error('Project exceeds the 4 GiB ZIP format limit.');
			}

			const localHeader = Buffer.alloc(30 + nameBuffer.length);
			localHeader.writeUInt32LE(0x04034b50, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt16LE(0x0800, 6);
			localHeader.writeUInt16LE(compressionMethod, 8);
			localHeader.writeUInt16LE(dosTimestamp.time, 10);
			localHeader.writeUInt16LE(dosTimestamp.date, 12);
			localHeader.writeUInt32LE(crc32, 14);
			localHeader.writeUInt32LE(compressedData.length, 18);
			localHeader.writeUInt32LE(data.length, 22);
			localHeader.writeUInt16LE(nameBuffer.length, 26);
			localHeader.writeUInt16LE(0, 28);
			nameBuffer.copy(localHeader, 30);

			await handle.write(localHeader, 0, localHeader.length, offset);
			offset += localHeader.length;
			await handle.write(compressedData, 0, compressedData.length, offset);
			offset += compressedData.length;

			centralDirectoryEntries.push({
				compressedSize: compressedData.length,
				compressionMethod,
				crc32,
				date: dosTimestamp.date,
				time: dosTimestamp.time,
				nameBuffer,
				offset: offset - compressedData.length - localHeader.length,
				size: data.length
			});
		}

		const centralDirectoryOffset = offset;
		for (const entry of centralDirectoryEntries) {
			const centralHeader = Buffer.alloc(46 + entry.nameBuffer.length);
			centralHeader.writeUInt32LE(0x02014b50, 0);
			centralHeader.writeUInt16LE(20, 4);
			centralHeader.writeUInt16LE(20, 6);
			centralHeader.writeUInt16LE(0x0800, 8);
			centralHeader.writeUInt16LE(entry.compressionMethod, 10);
			centralHeader.writeUInt16LE(entry.time, 12);
			centralHeader.writeUInt16LE(entry.date, 14);
			centralHeader.writeUInt32LE(entry.crc32, 16);
			centralHeader.writeUInt32LE(entry.compressedSize, 20);
			centralHeader.writeUInt32LE(entry.size, 24);
			centralHeader.writeUInt16LE(entry.nameBuffer.length, 28);
			centralHeader.writeUInt16LE(0, 30);
			centralHeader.writeUInt16LE(0, 32);
			centralHeader.writeUInt16LE(0, 34);
			centralHeader.writeUInt16LE(0, 36);
			centralHeader.writeUInt32LE(0, 38);
			centralHeader.writeUInt32LE(entry.offset, 42);
			entry.nameBuffer.copy(centralHeader, 46);

			await handle.write(centralHeader, 0, centralHeader.length, offset);
			offset += centralHeader.length;
		}

		const centralDirectorySize = offset - centralDirectoryOffset;
		if (offset >= 0xffffffff) throw new Error('Project exceeds the 4 GiB ZIP format limit.');
		const endRecord = Buffer.alloc(22);
		endRecord.writeUInt32LE(0x06054b50, 0);
		endRecord.writeUInt16LE(0, 4);
		endRecord.writeUInt16LE(0, 6);
		endRecord.writeUInt16LE(centralDirectoryEntries.length, 8);
		endRecord.writeUInt16LE(centralDirectoryEntries.length, 10);
		endRecord.writeUInt32LE(centralDirectorySize, 12);
		endRecord.writeUInt32LE(centralDirectoryOffset, 16);
		endRecord.writeUInt16LE(0, 20);

		await handle.write(endRecord, 0, endRecord.length, offset);
	} finally {
		await handle.close();
	}
}

function compressZipData(data) {
	const compressed = deflateRawSync(data, { level: 9 });
	return compressed.length < data.length ? compressed : data;
}

function formatDate(date) {
	const year = date.getFullYear();
	const month = [
		'jan',
		'feb',
		'mar',
		'apr',
		'may',
		'jun',
		'jul',
		'aug',
		'sep',
		'oct',
		'nov',
		'dec'
	][date.getMonth()];
	const day = String(date.getDate()).padStart(2, '0');
	return `${day}-${month}-${year}`;
}

function toPosixPath(filePath) {
	return filePath.split(path.sep).join('/');
}

function createCrc32Table() {
	const table = new Uint32Array(256);

	for (let index = 0; index < 256; index += 1) {
		let value = index;

		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
		}

		table[index] = value >>> 0;
	}

	return table;
}

function computeCrc32(buffer) {
	let crc = 0xffffffff;

	for (let index = 0; index < buffer.length; index += 1) {
		crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
	}

	return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimestamp(dateValue) {
	const date = new Date(dateValue);
	const year = Math.max(1980, date.getFullYear());
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const seconds = Math.floor(date.getSeconds() / 2);

	return {
		date: ((year - 1980) << 9) | (month << 5) | day,
		time: (hours << 11) | (minutes << 5) | seconds
	};
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});
