import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = resolve(root, 'native');
const source = resolve(nativeDir, 'target', 'release', 'toast-helper.exe');
const destination = resolve(root, 'backend', 'bin', 'toast-helper.exe');

console.log('[toast-helper] building native helper...');
execFileSync('cargo', ['build', '--release'], { cwd: nativeDir, stdio: 'inherit' });

if (!existsSync(source)) {
    console.error(`[toast-helper] missing build output: ${source}`);
    process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`[toast-helper] copied to ${destination}`);
