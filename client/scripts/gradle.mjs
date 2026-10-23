// Runs the Android Gradle wrapper on any OS: `node scripts/gradle.mjs assembleRelease`.
// (npm runs scripts through cmd.exe on Windows, which won't find `gradlew` in cwd.)
// The wrapper is called by absolute path: some Windows setups never search cwd.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const cwd = fileURLToPath(new URL('../android/', import.meta.url));
const wrapper = join(cwd, win ? 'gradlew.bat' : 'gradlew');
const { status } = spawnSync(win ? `"${wrapper}"` : wrapper, process.argv.slice(2), { cwd, stdio: 'inherit', shell: win });
process.exit(status ?? 1);
