// Import first in direct-entry suites that create worktrees or launch a gateway.
// Synchronous installation precedes modules that capture os.tmpdir() at import.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const parent=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gateway=path.basename(parent)==='dist'?path.dirname(parent):parent;
createRequire(import.meta.url)(path.join(gateway,'scripts','test-sandbox.cjs')).installTestSandbox();
