import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Render the real catalog, including every documented endpoint. The server's
// source-only shared package needs its normal tsx loader outside Playwright.
export const help = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import { apiHelpCatalog } from './src/api-help.ts'; process.stdout.write(JSON.stringify(apiHelpCatalog()));"], { cwd: resolve(process.cwd(), '../server'), encoding: 'utf8' }));

