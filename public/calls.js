export class OrbitCalls {
  constructor({ api, clientId, onChange, onError }) {
    this.api=api;this.clientId=clientId;this.onChange=onChange;this.onError=onError;this.peers=new Map();this.localStream=null;this.channel=null;this.user=null;
    this.mic=true;this.camera=false;this.screen=false;this.config=null;this.cameraTrack=null;this.screenTrack=null;this.cameraBeforeScreen=false;
  }
  async join(channel,user,withVideo=false){
    if(!navigator.mediaDevices)throw new Error('Chamadas não estão disponíveis neste navegador.');if(this.channel)await this.leave();this.channel=channel;this.user=user;
    try{this.localStream=await navigator.mediaDevices.getUserMedia({audio:true,video:withVideo})}catch(error){this.channel=null;throw new Error(error.name==='NotAllowedError'?'Permita o uso do microfone e da câmera para entrar na chamada.':'Não foi possível acessar seu microfone.')}
    this.cameraTrack=this.localStream.getVideoTracks()[0]||null;this.camera=!!this.cameraTrack;this.config||=await this.api('/api/rtc-config');
    const {peers}=await this.api('/api/call/join',{method:'POST',body:{channelId:channel.id,clientId:this.clientId}});this.onChange();for(const peer of peers)await this.createPeer(peer.clientId,peer.user,true);
  }
  senderFor(pc,kind){return pc.getSenders().find(sender=>sender.track?.kind===kind)||pc.getTransceivers().find(item=>item.receiver?.track?.kind===kind)?.sender}
  async replaceForPeers(kind,track){for(const {pc} of this.peers.values()){const sender=this.senderFor(pc,kind);if(sender)await sender.replaceTrack(track)}}
  async createPeer(peerId,user,initiator=false){
    if(this.peers.has(peerId))return this.peers.get(peerId).pc;const pc=new RTCPeerConnection(this.config),entry={pc,user,stream:new MediaStream(),pendingCandidates:[],disconnectedTimer:0};this.peers.set(peerId,entry);
    for(const kind of ['audio','video']){const track=this.localStream?.getTracks().find(item=>item.kind===kind);track?pc.addTrack(track,this.localStream):pc.addTransceiver(kind,{direction:'sendrecv'})}
    pc.ontrack=({track,streams})=>{entry.stream=streams[0]||entry.stream;if(!streams[0]&&!entry.stream.getTracks().includes(track))entry.stream.addTrack(track);this.onChange()};
    pc.onicecandidate=({candidate})=>{if(candidate)this.send(peerId,{candidate}).catch(this.onError)};
    pc.onconnectionstatechange=()=>{clearTimeout(entry.disconnectedTimer);if(['failed','closed'].includes(pc.connectionState))this.dropPeer(peerId);else if(pc.connectionState==='disconnected')entry.disconnectedTimer=setTimeout(()=>{if(pc.connectionState==='disconnected')this.dropPeer(peerId)},8000);else this.onChange()};
    if(initiator){const offer=await pc.createOffer();await pc.setLocalDescription(offer);await this.send(peerId,{description:pc.localDescription})}this.onChange();return pc;
  }
  async signal({clientId,user,signal}){
    if(!this.channel)return;const pc=await this.createPeer(clientId,user,false),entry=this.peers.get(clientId);
    try{if(signal.description){await pc.setRemoteDescription(signal.description);for(const candidate of entry.pendingCandidates.splice(0))await pc.addIceCandidate(candidate);if(signal.description.type==='offer'){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await this.send(clientId,{description:pc.localDescription})}}else if(signal.candidate){pc.remoteDescription?await pc.addIceCandidate(signal.candidate):entry.pendingCandidates.push(signal.candidate)}}catch{this.onError(new Error('A conexão com um participante falhou.'))}
  }
  send(target,signal){return this.api('/api/signal',{method:'POST',body:{clientId:this.clientId,target,signal}})}
  dropPeer(peerId){const item=this.peers.get(peerId);if(item){clearTimeout(item.disconnectedTimer);item.pc.close()}this.peers.delete(peerId);this.onChange()}
  async toggleMic(){this.mic=!this.mic;for(const track of this.localStream?.getAudioTracks()||[])track.enabled=this.mic;this.onChange()}
  async toggleCamera(){
    if(!this.localStream)return;if(!this.cameraTrack||this.cameraTrack.readyState==='ended'){try{this.cameraTrack=(await navigator.mediaDevices.getUserMedia({video:true})).getVideoTracks()[0]}catch{throw new Error('Não foi possível acessar sua câmera.')}if(!this.screen){this.localStream.addTrack(this.cameraTrack);await this.replaceForPeers('video',this.cameraTrack)}this.cameraTrack.enabled=true}else this.cameraTrack.enabled=!this.cameraTrack.enabled;
    this.camera=this.cameraTrack.enabled;if(this.screen)this.cameraBeforeScreen=this.camera;this.onChange();
  }
  async setDevices(audioId,videoId){
    if(!this.localStream)return;const fresh=await navigator.mediaDevices.getUserMedia({audio:audioId?{deviceId:{exact:audioId}}:true,video:videoId?{deviceId:{exact:videoId}}:false}),audio=fresh.getAudioTracks()[0],video=fresh.getVideoTracks()[0];
    if(audio){const old=this.localStream.getAudioTracks()[0];if(old){old.stop();this.localStream.removeTrack(old)}audio.enabled=this.mic;this.localStream.addTrack(audio);await this.replaceForPeers('audio',audio)}
    if(video){if(this.cameraTrack){this.cameraTrack.stop();this.localStream.removeTrack(this.cameraTrack)}this.cameraTrack=video;this.camera=true;if(!this.screen){this.localStream.addTrack(video);await this.replaceForPeers('video',video)}else this.cameraBeforeScreen=true}this.onChange();
  }
  async shareScreen(){
    if(!this.localStream)return;if(this.screen){await this.stopScreen();return}let display;try{display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false})}catch(error){if(error.name!=='NotAllowedError')throw new Error('Não foi possível compartilhar sua tela.');return}
    this.screenTrack=display.getVideoTracks()[0];this.screenTrack.contentHint='detail';this.screenTrack._orbitScreen=true;this.cameraBeforeScreen=!!this.cameraTrack?.enabled;if(this.cameraTrack&&this.localStream.getTracks().includes(this.cameraTrack))this.localStream.removeTrack(this.cameraTrack);this.localStream.addTrack(this.screenTrack);await this.replaceForPeers('video',this.screenTrack);this.screenTrack.onended=()=>this.stopScreen().catch(this.onError);this.screen=true;this.camera=false;this.onChange();
  }
  async stopScreen(){
    const track=this.screenTrack;if(track){track.onended=null;track.stop();this.localStream?.removeTrack(track)}this.screenTrack=null;this.screen=false;
    if(this.cameraTrack&&this.cameraTrack.readyState==='live'){this.cameraTrack.enabled=this.cameraBeforeScreen;if(!this.localStream.getTracks().includes(this.cameraTrack))this.localStream.addTrack(this.cameraTrack);await this.replaceForPeers('video',this.cameraTrack);this.camera=this.cameraTrack.enabled}else{await this.replaceForPeers('video',null);this.camera=false}this.onChange();
  }
  async leave(){
    if(!this.channel)return;try{await this.api('/api/call/leave',{method:'POST',body:{clientId:this.clientId}})}catch{}for(const {pc,disconnectedTimer} of this.peers.values()){clearTimeout(disconnectedTimer);pc.close()}this.peers.clear();const tracks=new Set([...(this.localStream?.getTracks()||[]),this.cameraTrack,this.screenTrack].filter(Boolean));for(const track of tracks)track.stop();this.localStream=null;this.cameraTrack=null;this.screenTrack=null;this.channel=null;this.camera=false;this.screen=false;this.mic=true;this.onChange();
  }
}
