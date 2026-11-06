const assert=require('node:assert/strict');
const {chatParts,chatPlainText,chatDisplayMessages}=require('../android/assets/chat-format.js');
assert.equal(chatPlainText('**Title:**\n* **Light:** Soft.\n`tree_model_v2`'),'Title:\n• Light: Soft.\ntree_model_v2');
assert.deepEqual(chatParts('Explanation.\n<prompt>A quiet forest.</prompt>\nUse soft light.'),[
 {content:'Explanation.',prompt:false},{content:'A quiet forest.',prompt:true},{content:'Use soft light.',prompt:false}]);
assert.deepEqual(chatParts('**Refined Video Prompt:**\n`A mountain at sunrise.`\n\n**Key adjustments:**\nSoft light.'),[
 {content:'A mountain at sunrise.',prompt:true},{content:'Key adjustments:\nSoft light.',prompt:false}]);
assert.equal(chatParts('Hello <prom')[0].content,'Hello');
assert.equal(chatParts('<prompt>A growing forest')[0].content,'A growing forest');
const user={id:'u',role:'user',content:'Keep **my** syntax'};
assert.deepEqual(chatDisplayMessages([user]),[user]);
assert.equal(chatDisplayMessages([{id:'a',role:'assistant',content:'Context<prompt>Forest</prompt>'}])[1].id,'a-part-1');
console.log('Plain text, independent prompts, legacy labels, streaming tags and user text preservation passed.');
