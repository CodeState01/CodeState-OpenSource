import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

async function appFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orbit-test-'));
  const app = createApp({ dataDir: dir, requireCaptcha:false, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, base };
}
async function guest(base) {
  const response = await fetch(base + '/api/guest', { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Orbit-Request':'1' }, body:JSON.stringify({terms:true}) });
  assert.equal(response.status, 201); const cookie = response.headers.get('set-cookie').split(';')[0];
  const boot = await fetch(base + '/api/bootstrap', { headers:{ cookie } });
  return { cookie, data: await boot.json() };
}
async function account(base, username='criador') {
  const visitor=await guest(base),response=await fetch(base+'/api/register',{method:'POST',headers:{cookie:visitor.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':visitor.data.csrf},body:JSON.stringify({name:'Criador CodeState',username,password:'Senha!Forte123',terms:true})});
  assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0],session=await response.json();return {cookie,data:{...visitor.data,...session}};
}
test('creates an isolated guest session and serves bootstrap data', async t => {
  const { base } = await appFixture(t); const first = await guest(base), second = await guest(base);
  assert.notEqual(first.data.user.id, second.data.user.id);
  assert.equal(first.data.servers[0].name, 'CodeState');
  assert.ok(first.data.channels.some(c => c.type === 'text'));
});
test('rejects local addresses as public invitation URLs', () => {
  assert.throws(() => createApp({ publicUrl:'https://127.0.0.1' }), /domínio público/);
  assert.throws(() => createApp({ publicUrl:'https://localhost' }), /domínio público/);
});
test('requires the visual challenge before creating a visitor session', async t => {
  const { base } = await appFixture(t, { requireCaptcha:true });
  const challenge = await (await fetch(base + '/api/captcha')).json();
  assert.match(challenge.image, /^data:image\/svg\+xml;base64,/);
  const denied = await fetch(base + '/api/guest', { method:'POST', headers:{'Content-Type':'application/json','X-Orbit-Request':'1'}, body:JSON.stringify({captchaId:challenge.id,captchaText:'ERRADO',terms:true}) });
  assert.equal(denied.status, 403);
  const validChallenge = await (await fetch(base + '/api/captcha')).json();
  const svg = Buffer.from(validChallenge.image.split(',')[1], 'base64').toString();
  const answer = [...svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map(match => match[1]).join('');
  const accepted = await fetch(base + '/api/guest', { method:'POST', headers:{'Content-Type':'application/json','X-Orbit-Request':'1'}, body:JSON.stringify({captchaId:validChallenge.id,captchaText:answer,terms:true}) });
  assert.equal(accepted.status, 201);
});
test('rejects mutations without CSRF and stores messages with it', async t => {
  const { base } = await appFixture(t); const { cookie, data } = await account(base,'seguro');
  const auth={cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf};
  const created=await fetch(base+'/api/servers',{method:'POST',headers:auth,body:JSON.stringify({name:'Sala Segura'})});
  const serverId=(await created.json()).id,bootstrap=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();
  const channelId=bootstrap.channels.find(channel=>channel.server_id===serverId&&channel.type==='text').id;
  const denied = await fetch(base + '/api/messages', { method:'POST', headers:{ cookie,'Content-Type':'application/json','X-Orbit-Request':'1' }, body:JSON.stringify({channelId,content:'teste'}) });
  assert.equal(denied.status, 403);
  const accepted = await fetch(base + '/api/messages', { method:'POST', headers:auth, body:JSON.stringify({channelId,content:'Olá em tempo real'}) });
  assert.equal(accepted.status, 201); assert.equal((await accepted.json()).content, 'Olá em tempo real');
});
test('keeps the default presentation channel visible and read-only', async t => {
  const { base }=await appFixture(t),{cookie,data}=await guest(base);
  const orbitChannels=data.channels.filter(channel=>channel.server_id==='orbit');
  assert.equal(orbitChannels.length,1);assert.equal(orbitChannels[0].name,'apresentacao');assert.equal(orbitChannels[0].read_only,1);
  const response=await fetch(base+'/api/messages',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({channelId:'geral',content:'não deve entrar'})});
  assert.equal(response.status,403);assert.match((await response.json()).error,/somente leitura/);
});
test('requires terms acceptance before creating a session or account', async t => {
  const {base}=await appFixture(t);
  const visitor=await fetch(base+'/api/guest',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:'{}'});
  assert.equal(visitor.status,400);
  const {cookie,data}=await guest(base);
  const registration=await fetch(base+'/api/register',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({name:'Sem Termos',username:'semtermos',password:'Senha!Forte123'})});
  assert.equal(registration.status,400);
});
test('keeps the OpenAI key on the server and provides a labeled demo fallback', async t => {
  const { base } = await appFixture(t, { apiKey:'' }); const { cookie, data } = await guest(base);
  const response = await fetch(base + '/api/ai', { method:'POST', headers:{ cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf }, body:JSON.stringify({provider:'demo',prompt:'Ajude com CSS'}) });
  const result = await response.json(); assert.equal(response.status,200); assert.equal(result.demo,true); assert.match(result.text,/LLM gratuito/);
  const remembered = await (await fetch(base + '/api/bootstrap', { headers:{ cookie } })).json();
  assert.deepEqual(remembered.aiHistory.map(message => message.role), ['user','assistant']);
});
test('updates avatar and banner safely in the user profile', async t => {
  const { base } = await appFixture(t); const { cookie, data } = await guest(base);
  const image='data:image/png;base64,iVBORw0KGgo=';
  const response=await fetch(base+'/api/profile',{method:'PATCH',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({name:'Criador',avatar:image,banner:image})});
  const profile=await response.json();assert.equal(response.status,200);assert.equal(profile.name,'Criador');assert.equal(profile.avatar,image);assert.equal(profile.banner,image);
  const bootstrap=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.equal(bootstrap.user.avatar,image);assert.equal(bootstrap.members.find(member=>member.id===profile.id).avatar,image);
});
test('creates customized servers, roles, VFX channels, public invites and attachments', async t => {
  const { base }=await appFixture(t,{publicUrl:'https://app.codestate.example'}),{cookie,data}=await account(base);
  const auth={'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf,cookie},image='data:image/png;base64,iVBORw0KGgo=';
  const created=await fetch(base+'/api/servers',{method:'POST',headers:auth,body:JSON.stringify({name:'Estúdio Norte',description:'Projetos do time',font:'serif',icon:image})});assert.equal(created.status,201);const serverId=(await created.json()).id;
  const roles=await (await fetch(base+`/api/roles?serverId=${serverId}`,{headers:{cookie}})).json();assert.equal(roles.canManage,true);assert.deepEqual(roles.roles.map(role=>role.name),['Dono','Membro']);
  const role=await fetch(base+'/api/roles',{method:'POST',headers:auth,body:JSON.stringify({action:'create',serverId,name:'Moderador',color:'#aabbcc',permissions:['manage_channels','manage_messages']})});assert.equal(role.status,201);const roleId=(await role.json()).id;
  const channel=await fetch(base+'/api/channels',{method:'POST',headers:auth,body:JSON.stringify({serverId,name:'efeitos',type:'text',font:'mono',vfx:true})});assert.equal(channel.status,201);const channelId=(await channel.json()).id;
  const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.equal(boot.servers.find(server=>server.id===serverId).font,'serif');assert.equal(boot.channels.find(item=>item.id===channelId).vfx,1);
  const invite=await (await fetch(base+`/api/invite?serverId=${serverId}`,{headers:{cookie}})).json();assert.match(invite.url,/^https:\/\/app\.codestate\.example\/\?invite=/);
  const collaborator=await account(base,'colaborador'),collaboratorAuth={'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':collaborator.data.csrf,cookie:collaborator.cookie};await fetch(base+'/api/join',{method:'POST',headers:collaboratorAuth,body:JSON.stringify({invite:invite.invite})});
  await fetch(base+'/api/roles',{method:'POST',headers:auth,body:JSON.stringify({action:'assign',serverId,roleId,userId:collaborator.data.user.id,enabled:true})});
  const delegated=await fetch(base+'/api/channels',{method:'POST',headers:collaboratorAuth,body:JSON.stringify({serverId,name:'moderado',type:'text',font:'inherit',vfx:false})});assert.equal(delegated.status,201);
  const upload=await fetch(base+`/api/files?channelId=${channelId}`,{method:'POST',headers:{cookie,'Content-Type':'text/plain','X-Orbit-Request':'1','X-CSRF-Token':data.csrf,'X-File-Name':encodeURIComponent('ideia.txt')},body:'conteúdo compartilhado'});assert.equal(upload.status,201);const message=await upload.json();assert.equal(message.attachments[0].name,'ideia.txt');
  const download=await fetch(base+message.attachments[0].url,{headers:{cookie}});assert.equal(await download.text(),'conteúdo compartilhado');assert.match(download.headers.get('content-disposition'),/attachment/);
});
test('finds JavaScript syntax errors without executing the source', async t => {
  const { base } = await appFixture(t,{localRuntime:true}); const { cookie, data } = await guest(base);
  const response=await fetch(base+'/api/validate',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({language:'javascript',code:'function broken( {'})});
  const result=await response.json();assert.equal(response.status,200);assert.equal(result.valid,false);assert.match(result.output,/SyntaxError|Unexpected/);
});
test('validates every language supported by the playground', async t => {
  const { base } = await appFixture(t,{localRuntime:true}); const { cookie, data } = await guest(base);
  const samples={html:'<main><h1>Olá</h1></main>',css:'body { color: white; }',javascript:'const ready = true;',python:'print("ok")',csharp:'using System.Windows.Forms; public class App : Form { Button save = new Button { Text = "Salvar" }; }',cpp:'int main() { return 0; }',luau:'local state = { ready = true }'};
  for(const [language,code] of Object.entries(samples)){
    const response=await fetch(base+'/api/validate',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({language,code})});
    const result=await response.json();assert.equal(result.valid,true,`${language}: ${result.output}`);
  }
  for(const [language,code] of Object.entries({html:'<main><div></main>',css:'body { color red; }',luau:'if true then print("x")'})){
    const response=await fetch(base+'/api/validate',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({language,code})});
    assert.equal((await response.json()).valid,false,`${language} deveria ser inválido`);
  }
});
test('adapts requests and responses for a local free Ollama model', async t => {
  let request;
  const fetchImpl = async (url, init={}) => { if (String(url).endsWith('/api/tags')) return { ok:true, json:async()=>({models:[{name:'gemma3:1b'}]}) }; request = { url, body: JSON.parse(init.body) }; return { ok:true, json:async()=>({ message:{ content:'Resposta local' } }) }; };
  const { base } = await appFixture(t, { fetchImpl, ollamaModel:'gemma3:1b' }); const { cookie, data } = await guest(base);
  const response = await fetch(base + '/api/ai', { method:'POST', headers:{ cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf }, body:JSON.stringify({provider:'ollama',prompt:'Ajude com HTML'}) });
  const result = await response.json(); assert.equal(result.text,'Resposta local'); assert.equal(result.provider,'ollama');
  assert.match(request.url,/127\.0\.0\.1:11434\/api\/chat/); assert.equal(request.body.stream,false); assert.equal(request.body.think,false); assert.equal(request.body.model,'gemma3:1b');
  await fetch(base + '/api/ai', { method:'POST', headers:{ cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf }, body:JSON.stringify({provider:'ollama',prompt:'Continue de onde paramos'}) });
  assert.ok(request.body.messages.some(message=>message.role==='assistant'&&message.content==='Resposta local'));
  assert.ok(request.body.messages.some(message=>message.role==='user'&&message.content==='Ajude com HTML'));
});
test('marks local LLM unavailable when Ollama is offline', async t => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const { base } = await appFixture(t, { fetchImpl }); const { cookie } = await guest(base);
  const response = await fetch(base + '/api/ai/providers', { headers:{ cookie } }); const result = await response.json();
  const ollama = result.providers.find(p => p.id === 'ollama'); assert.equal(ollama.available,false); assert.match(ollama.reason,/não está em execução/);
});
test('sends restrictive browser security headers', async t => {
  const { base } = await appFixture(t); const response = await fetch(base + '/');
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(response.headers.get('permissions-policy'), /display-capture/);
});
