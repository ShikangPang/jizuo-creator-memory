import { statSync } from 'node:fs';
for (const file of ['lib/index.js', 'lib/client.js']) { if (!statSync(file).size) throw new Error('Empty build artifact: ' + file); }
