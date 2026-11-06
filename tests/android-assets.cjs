const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const java=fs.readFileSync(path.join(root,'android/java/com/comfybridge/app/MainActivity.java'),'utf8');
const allow=java.match(/Arrays\.asList\(([^)]*)\)\.contains\(path\)/)[1];
const paths=new Set([...allow.matchAll(/"([^"]+)"/g)].map(m=>m[1]));
const html=fs.readFileSync(path.join(root,'android/assets/index.html'),'utf8');
for(const m of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)){
 assert(paths.has('/'+m[1]),'Android blocks '+m[1]);
 assert(fs.existsSync(path.join(root,'android/assets',m[1])),'Missing asset '+m[1]);
}
assert(html.indexOf('chat-format.js')<html.indexOf('src="chat.js"'),'Chat helper must load first');
console.log('Every entry-page script and stylesheet is present and allowed by Android.');
