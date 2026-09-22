import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>['.git','node_modules','dist'].includes(e.name)?[]:e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);
const files=walk(root);
const secrets=[/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,/\bAKIA[A-Z0-9]{16}\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}/];
for(const file of files){
 if(/\.(png|jpg|jpeg|gif|ico)$/.test(file))continue;
 const source=fs.readFileSync(file,'utf8');
 assert(!secrets.some(re=>re.test(source)),`Possible credential in ${path.relative(root,file)}`);
 if(file.includes(path.sep+'extension'+path.sep))assert(!/audiofetcher|amazonaws\.com|amazoncognito\.com|stripe\.com|535547049140|yazanbaker@gmail/i.test(source),`Private integration reference in ${path.relative(root,file)}`);
}
const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json')));
assert.deepEqual(manifest.permissions,['storage']);
assert.deepEqual(new Set(manifest.host_permissions),new Set(['https://api.resend.com/*','https://api.cloudflare.com/*']));
assert(!manifest.key);
for(const file of [manifest.background.service_worker,manifest.options_ui.page,...manifest.content_scripts.flatMap(x=>[...x.js,...x.css]),...Object.values(manifest.icons)])assert(fs.existsSync(path.join(root,'extension',file)),`Missing ${file}`);
console.log(`Publication audit passed (${files.length} files; no matched secret patterns or retired production endpoints).`);
