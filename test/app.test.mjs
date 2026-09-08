import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
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
  assert.equal(response.status, 201); const cookie = response.headers.get('set-cookie').split(';')[0],created=await response.json();
  const boot = await fetch(base + '/api/bootstrap', { headers:{ cookie } });
  return { cookie, data: await boot.json(), credentials:created.credentials };
}
async function account(base, username='criador') {
  return guest(base);
}
async function openEvents(base,cookie,clientId,t){
  const controller=new AbortController(),response=await fetch(`${base}/api/events?clientId=${clientId}`,{headers:{cookie},signal:controller.signal});
  assert.equal(response.status,200);const connection={reader:response.body.getReader(),decoder:new TextDecoder(),buffer:'',controller};t.after(()=>controller.abort());
  await nextEvent(connection,'connected');return connection;
}
async function nextEvent(connection,name,timeout=2500){
  const timer=setTimeout(()=>connection.controller.abort(),timeout);
  try{
    while(true){
      const boundary=connection.buffer.indexOf('\n\n');
      if(boundary>=0){const block=connection.buffer.slice(0,boundary);connection.buffer=connection.buffer.slice(boundary+2);const event=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(event===name)return JSON.parse(data);continue}
      const {done,value}=await connection.reader.read();if(done)throw new Error(`Fluxo SSE terminou antes do evento ${name}.`);connection.buffer+=connection.decoder.decode(value,{stream:true});
    }
  }finally{clearTimeout(timer)}
}
test('creates an isolated automatic account with strong generated credentials', async t => {
  const { base } = await appFixture(t); const first = await guest(base), second = await guest(base);
  assert.notEqual(first.data.user.id, second.data.user.id);
  assert.equal(first.data.user.guest,false);assert.equal(first.data.user.username,first.credentials.username);
  assert.match(first.credentials.username,/^[a-z0-9_-]{3,32}$/);
  assert.ok(/[a-z]/.test(first.credentials.password)&&/[A-Z]/.test(first.credentials.password)&&/\d/.test(first.credentials.password)&&/[^A-Za-z0-9]/.test(first.credentials.password));
  assert.equal(first.data.servers[0].name, 'CodeState');
  assert.ok(first.data.channels.some(c => c.type === 'text'));
});
test('logs back into the same generated account after logout', async t => {
  const {base}=await appFixture(t),created=await guest(base);
  const auth={'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':created.data.csrf,cookie:created.cookie};
  await fetch(base+'/api/logout',{method:'POST',headers:auth,body:'{}'});
  const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:JSON.stringify(created.credentials)});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];
  const restored=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.equal(restored.user.id,created.data.user.id);
});
test('recreates an automatic account from locally saved credentials', async t => {
  const {base,app}=await appFixture(t),created=await guest(base),userId=created.data.user.id;
  app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  app.db.prepare('DELETE FROM member_roles WHERE user_id=?').run(userId);
  app.db.prepare('DELETE FROM members WHERE user_id=?').run(userId);
  app.db.prepare('DELETE FROM users WHERE id=?').run(userId);
  const response=await fetch(base+'/api/recover',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:JSON.stringify({...created.credentials,name:'Nome Recuperado',terms:true})});
  assert.equal(response.status,201);const cookie=response.headers.get('set-cookie').split(';')[0];
  const restored=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();
  assert.equal(restored.user.username,created.credentials.username);assert.equal(restored.user.name,'Nome Recuperado');
});
test('upgrades an existing visitor without asking for another registration', async t => {
  const {base,app}=await appFixture(t),created=await guest(base);
  app.db.prepare('UPDATE users SET guest=1,username=NULL,password=NULL WHERE id=?').run(created.data.user.id);
  const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie:created.cookie}})).json();assert.equal(boot.user.guest,true);
  const response=await fetch(base+'/api/auto-account',{method:'POST',headers:{cookie:created.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':boot.csrf},body:'{}'});
  const upgraded=await response.json();assert.equal(response.status,201);assert.match(upgraded.credentials.username,/^[a-z0-9_-]+$/);
  const current=await (await fetch(base+'/api/bootstrap',{headers:{cookie:created.cookie}})).json();assert.equal(current.user.guest,false);
});
test('rejects local addresses as public invitation URLs', () => {
  assert.throws(() => createApp({ publicUrl:'https://127.0.0.1' }), /domínio público/);
  assert.throws(() => createApp({ publicUrl:'https://localhost' }), /domínio público/);
});
test('keeps the configured CREATOR account in every existing and future server', async t => {
  const salt='ab'.repeat(32),password='Creator!Teste2026',creatorPasswordHash=`${salt}:${scryptSync(password,salt,64).toString('hex')}`;
  const {base}=await appFixture(t,{creatorUsername:'codestate-creator',creatorPasswordHash,creatorName:'CodeState Creator'}),owner=await account(base);
  const ownerAuth={cookie:owner.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':owner.data.csrf};
  const created=await fetch(base+'/api/servers',{method:'POST',headers:ownerAuth,body:JSON.stringify({name:'Servidor Persistente'})}),serverId=(await created.json()).id;
  assert.equal(created.status,201);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:JSON.stringify({username:'codestate-creator',password})});
  assert.equal(login.status,200);const creatorCookie=login.headers.get('set-cookie').split(';')[0],creator=await (await fetch(base+'/api/bootstrap',{headers:{cookie:creatorCookie}})).json();
  assert.ok(creator.servers.some(server=>server.id==='orbit'));
  assert.equal(creator.user.title,'Owner of app');
  assert.ok(creator.servers.some(server=>server.id===serverId&&server.permissions.includes('administrator')));
  const member=creator.members.find(item=>item.id==='codestate-creator'&&item.serverId===serverId);assert.equal(member.title,'Owner of app');assert.ok(member.roles.some(role=>role.name==='CREATOR'));
  const denied=await fetch(base+'/api/roles',{method:'POST',headers:ownerAuth,body:JSON.stringify({action:'assign',serverId,roleId:`${serverId}:creator`,userId:'codestate-creator',enabled:false})});
  assert.equal(denied.status,400);
});
test('keeps servers and invitation tokens across restarts with the same data directory', async t => {
  const dir=await mkdtemp(join(tmpdir(),'codestate-persist-'));let current;
  t.after(async()=>{if(current)await current.close();await rm(dir,{recursive:true,force:true})});
  current=createApp({dataDir:dir,requireCaptcha:false,publicUrl:'https://app.codestate.example'});await new Promise(resolve=>current.server.listen(0,'127.0.0.1',resolve));let base=`http://127.0.0.1:${current.server.address().port}`;
  const owner=await guest(base),auth={cookie:owner.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':owner.data.csrf};
  const created=await fetch(base+'/api/servers',{method:'POST',headers:auth,body:JSON.stringify({name:'Servidor entre Versões'})}),serverId=(await created.json()).id;
  const before=await (await fetch(base+`/api/invite?serverId=${serverId}`,{headers:{cookie:owner.cookie}})).json();
  await current.close();current=null;
  current=createApp({dataDir:dir,requireCaptcha:false,publicUrl:'https://app.codestate.example'});await new Promise(resolve=>current.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${current.server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:JSON.stringify(owner.credentials)});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const restored=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.ok(restored.servers.some(server=>server.id===serverId));
  const after=await (await fetch(base+`/api/invite?serverId=${serverId}`,{headers:{cookie}})).json();assert.equal(after.invite,before.invite);assert.equal(after.url,before.url);
});
test('lists public featured servers and lets an account join one', async t => {
  const {base}=await appFixture(t),accountData=await guest(base),{cookie}=accountData;
  const discovered=await (await fetch(base+'/api/discover')).json();
  assert.ok(discovered.servers.length>=4);assert.ok(discovered.servers.some(server=>server.name==='Frontend Lab'&&server.featured));
  const target=discovered.servers.find(server=>server.name==='Frontend Lab');
  const joined=await fetch(base+'/api/join',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':accountData.data.csrf},body:JSON.stringify({invite:target.invite})});
  assert.equal(joined.status,200);const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie}})).json();assert.ok(boot.servers.some(server=>server.id===target.id));
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
test('requires accepted friendships and supports private replies and forwarding', async t => {
  const {base}=await appFixture(t),alice=await account(base),bob=await account(base),outsider=await account(base);
  const auth=value=>({cookie:value.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':value.data.csrf}),aliceAuth=auth(alice),bobAuth=auth(bob);
  const requested=await fetch(base+'/api/friends',{method:'POST',headers:aliceAuth,body:JSON.stringify({action:'request',username:bob.data.user.username})});assert.equal(requested.status,201);
  const pending=await (await fetch(base+'/api/bootstrap',{headers:{cookie:bob.cookie}})).json();assert.equal(pending.friendRequests[0].id,alice.data.user.id);
  const premature=await fetch(base+'/api/direct-messages',{method:'POST',headers:bobAuth,body:JSON.stringify({userId:alice.data.user.id,content:'cedo demais'})});assert.equal(premature.status,403);
  const accepted=await fetch(base+'/api/friends',{method:'POST',headers:bobAuth,body:JSON.stringify({action:'accept',userId:alice.data.user.id})});assert.equal(accepted.status,200);
  const aliceBoot=await (await fetch(base+'/api/bootstrap',{headers:{cookie:alice.cookie}})).json();assert.equal(aliceBoot.friends[0].id,bob.data.user.id);
  const first=await fetch(base+'/api/direct-messages',{method:'POST',headers:aliceAuth,body:JSON.stringify({userId:bob.data.user.id,content:'Mensagem privada'})}),firstMessage=await first.json();assert.equal(first.status,201);
  const reply=await fetch(base+'/api/direct-messages',{method:'POST',headers:bobAuth,body:JSON.stringify({userId:alice.data.user.id,content:'Recebida',replyTo:firstMessage.id})}),replyMessage=await reply.json();assert.equal(reply.status,201);assert.equal(replyMessage.reply.content,'Mensagem privada');
  const created=await fetch(base+'/api/servers',{method:'POST',headers:aliceAuth,body:JSON.stringify({name:'Equipe Encaminhar'})}),serverId=(await created.json()).id;
  const boot=await (await fetch(base+'/api/bootstrap',{headers:{cookie:alice.cookie}})).json(),channel=boot.channels.find(item=>item.server_id===serverId&&item.type==='text');
  const original=await (await fetch(base+'/api/messages',{method:'POST',headers:aliceAuth,body:JSON.stringify({channelId:channel.id,content:'Plano do projeto'})})).json();
  const channelReply=await (await fetch(base+'/api/messages',{method:'POST',headers:aliceAuth,body:JSON.stringify({channelId:channel.id,content:'Detalhes',replyTo:original.id})})).json();assert.equal(channelReply.reply.content,'Plano do projeto');
  const forwarded=await fetch(base+'/api/messages/forward',{method:'POST',headers:aliceAuth,body:JSON.stringify({messageId:original.id,userId:bob.data.user.id})}),forwardedMessage=await forwarded.json();assert.equal(forwarded.status,201);assert.equal(forwardedMessage.forwardedAuthor,alice.data.user.name);
  const history=await (await fetch(base+`/api/direct-messages?userId=${alice.data.user.id}`,{headers:{cookie:bob.cookie}})).json();assert.ok(history.some(message=>message.content==='Plano do projeto'&&message.forwardedAuthor===alice.data.user.name));
  const upload=await fetch(base+`/api/direct-files?userId=${bob.data.user.id}`,{method:'POST',headers:{...aliceAuth,'Content-Type':'text/plain','X-File-Name':encodeURIComponent('privado.txt')},body:'arquivo privado'}),fileMessage=await upload.json();assert.equal(upload.status,201);assert.equal(fileMessage.attachments[0].name,'privado.txt');
  const download=await fetch(base+fileMessage.attachments[0].url,{headers:{cookie:bob.cookie}});assert.equal(await download.text(),'arquivo privado');
  const blockedFile=await fetch(base+fileMessage.attachments[0].url,{headers:{cookie:outsider.cookie}});assert.equal(blockedFile.status,403);
  const denied=await fetch(base+`/api/direct-messages?userId=${alice.data.user.id}`,{headers:{cookie:outsider.cookie}});assert.equal(denied.status,403);
});
test('keeps the default presentation channel visible and read-only', async t => {
  const { base }=await appFixture(t),{cookie,data}=await guest(base);
  const orbitChannels=data.channels.filter(channel=>channel.server_id==='orbit');
  assert.equal(orbitChannels.length,1);assert.equal(orbitChannels[0].name,'apresentacao');assert.equal(orbitChannels[0].read_only,1);
  const response=await fetch(base+'/api/messages',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({channelId:'geral',content:'não deve entrar'})});
  assert.equal(response.status,403);assert.match((await response.json()).error,/somente leitura/);
});
test('requires terms acceptance before creating an automatic account', async t => {
  const {base}=await appFixture(t);
  const visitor=await fetch(base+'/api/guest',{method:'POST',headers:{'Content-Type':'application/json','X-Orbit-Request':'1'},body:'{}'});
  assert.equal(visitor.status,400);
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
  const response=await fetch(base+'/api/profile',{method:'PATCH',headers:{cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':data.csrf},body:JSON.stringify({name:'Criador',username:'criador-unico',avatar:image,banner:image})});
  const profile=await response.json();assert.equal(response.status,200);assert.equal(profile.name,'Criador');assert.equal(profile.username,'criador-unico');assert.equal(profile.avatar,image);assert.equal(profile.banner,image);
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
test('relays screen compatibility frames only inside the same voice call', async t => {
  const {base}=await appFixture(t),owner=await account(base),friend=await account(base),outsider=await account(base);
  const ownerAuth={cookie:owner.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':owner.data.csrf};
  const created=await fetch(base+'/api/servers',{method:'POST',headers:ownerAuth,body:JSON.stringify({name:'Equipe Tela'})}),serverId=(await created.json()).id;
  const ownerBoot=await (await fetch(base+'/api/bootstrap',{headers:{cookie:owner.cookie}})).json(),voice=ownerBoot.channels.find(channel=>channel.server_id===serverId&&channel.type==='voice');
  const invite=await (await fetch(base+`/api/invite?serverId=${serverId}`,{headers:{cookie:owner.cookie}})).json();
  const friendAuth={cookie:friend.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':friend.data.csrf};
  await fetch(base+'/api/join',{method:'POST',headers:friendAuth,body:JSON.stringify({invite:invite.invite})});
  const ownerId=randomUUID(),friendId=randomUUID(),ownerEvents=await openEvents(base,owner.cookie,ownerId,t),friendEvents=await openEvents(base,friend.cookie,friendId,t);
  await fetch(base+'/api/call/join',{method:'POST',headers:ownerAuth,body:JSON.stringify({channelId:voice.id,clientId:ownerId})});
  const joined=await fetch(base+'/api/call/join',{method:'POST',headers:friendAuth,body:JSON.stringify({channelId:voice.id,clientId:friendId})});assert.equal(joined.status,200);assert.equal((await joined.json()).peers.length,1);
  const image=Buffer.alloc(20000);image.write('RIFF',0);image.write('WEBP',8);const frame='data:image/webp;base64,'+image.toString('base64');
  const received=nextEvent(friendEvents,'screen-frame'),sent=await fetch(base+'/api/call/screen-frame',{method:'POST',headers:ownerAuth,body:JSON.stringify({clientId:ownerId,frame})});assert.equal(sent.status,202);
  assert.deepEqual(await received,{clientId:ownerId,frame});
  const outsiderAuth={cookie:outsider.cookie,'Content-Type':'application/json','X-Orbit-Request':'1','X-CSRF-Token':outsider.data.csrf};
  const denied=await fetch(base+'/api/call/screen-frame',{method:'POST',headers:outsiderAuth,body:JSON.stringify({clientId:randomUUID(),frame})});assert.equal(denied.status,403);
  const stopped=nextEvent(friendEvents,'screen-stopped');await fetch(base+'/api/call/screen-stop',{method:'POST',headers:ownerAuth,body:JSON.stringify({clientId:ownerId})});assert.deepEqual(await stopped,{clientId:ownerId});
  ownerEvents.controller.abort();friendEvents.controller.abort();
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
