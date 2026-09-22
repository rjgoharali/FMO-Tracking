// Run only when npm registry access is available. Use Expo's own compatibility
// manifest instead of guessing native module versions or mixing SDK releases.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const plan = JSON.parse(await readFile(new URL('../mobile/dependencies.json', import.meta.url), 'utf8'));
if (!process.env.npm_execpath) throw new Error('Run this through npm run mobile:setup from the repository root');
async function npm(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm exited ${code}`)));
  });
}
await npm(['install', '-w', '@fmo/mobile', `expo@${plan.expo}`]);
const bundled = require('expo/bundledNativeModules.json');
const packages = plan.sdkManaged.map(name => {
  if (!bundled[name]) throw new Error(`Expo compatibility metadata has no entry for ${name}. Inspect the SDK before proceeding.`);
  return `${name}@${bundled[name]}`;
});
await npm(['install', '-w', '@fmo/mobile', ...packages]);
if (!plan.reactTypes) throw new Error('Declare the SDK-compatible React types in mobile/dependencies.json');
await npm(['install', '-D', '--save-exact', '-w', '@fmo/mobile', `@types/react@${plan.reactTypes}`]);
console.log('Mobile dependencies installed and root package-lock.json updated. Run mobile:typecheck, mobile:export and an Android build next.');
