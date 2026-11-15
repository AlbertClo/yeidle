import fs from 'node:fs';
import path from 'node:path';

import type { Files } from '../app/host';

/** Node's fs as core Files. */
export const nodeFiles: Files = {
    exists: (p) => fs.existsSync(p),
    isFile: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
    isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    readFile: (p) => new Uint8Array(fs.readFileSync(p)),
    readText: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, data) => fs.writeFileSync(p, data),
    appendFile: (p, data) => fs.appendFileSync(p, data),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
    rename: (from, to) => fs.renameSync(from, to),
    link: (from, to) => {
        try {
            fs.linkSync(from, to);
        } catch {
            fs.copyFileSync(from, to);
        }
    },
    copy: (from, to) => fs.cpSync(from, to, { recursive: true }),
    unlink: (p) => fs.rmSync(p, { force: true }),
    removeDirectory: (p) => fs.rmSync(p, { recursive: true, force: true }),
    size: (p) => fs.statSync(p).size,
    list: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    basename: (p) => path.basename(p),
};
