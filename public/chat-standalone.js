'use strict';
let chatMessages=[], chatLastIds=new Set(), chatUnread=0, currentUser={name:'',sub:''};
let chatSoundEnabled = JSON.parse(localStorage.getItem('al-chat-sound') ?? 'true');
let selectedVoiceURI = localStorage.getItem('al-chat-voice') || '';

async function api(method,url,body){
  const opts={method, headers:{}};
  if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  let res; try{ res=await fetch(url,opts);}catch{ throw new Error('Нет связи'); }
  if(res.status===401){ window.location.href='/login'; throw new Error('Требуется вход');}
  let data={}; try{ data=await res.json();}catch{}
  if(!res.ok) throw new Error(data.error||('Ошибка '+res.status));
  return data;
}
function fmtTime(ts){ const d=new Date(ts); return d.toLocaleDateString('ru-RU',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
function formatFileSize(n){ if(n<1024) return n+' B'; if(n<1024*1024) return (n/1024).toFixed(1)+' KB'; if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB'; return (n/1024/1024/1024).toFixed(2)+' GB'; }
function getAnimeVoice(){ try{ const voices=speechSynthesis.getVoices(); if(!voices.length) return null; if(selectedVoiceURI){ const by=voices.find(v=>v.voiceURI===selectedVoiceURI); if(by) return by; } const ja=voices.find(v=>v.lang==='ja-JP'&&/female|haruka|hikari/i.test(v.name))||voices.find(v=>v.lang.startsWith('ja'))||voices.find(v=>/Google 日本語|Microsoft Haruka/i.test(v.name)); if(ja) return ja; const en=voices.find(v=>v.lang.startsWith('en')&&/female|jenny|aria|samantha|zira/i.test(v.name))||voices.find(v=>v.name.toLowerCase().includes('female')); return en||voices.find(v=>v.lang.startsWith('en'))||voices[0]; }catch{return null;} }
function populateVoiceSelect(){ const sel=document.getElementById('standalone-voice'); if(!sel||!speechSynthesis) return; const voices=speechSynthesis.getVoices(); if(!voices.length) return; const prev=selectedVoiceURI; sel.replaceChildren(); const opt0=document.createElement('option'); opt0.value=''; opt0.textContent='Авто (аниме-тян)'; sel.append(opt0); for(const v of voices){ const o=document.createElement('option'); o.value=v.voiceURI; o.textContent=v.name+' ('+v.lang+')'+(v.default?' — по умолчанию':''); if(v.voiceURI===prev) o.selected=true; sel.append(o);} if(prev&&!voices.some(v=>v.voiceURI===prev)) sel.value=''; }
function playChatSound(){ if(!chatSoundEnabled) return; try{ const AC=window.AudioContext||window.webkitAudioContext; if(AC){ const ctx=new AC(); const now=ctx.currentTime; [880,1320].forEach((freq,i)=>{ const o=ctx.createOscillator(); const g=ctx.createGain(); o.type='sine'; o.frequency.value=freq; g.gain.value=0.22; o.connect(g); g.connect(ctx.destination); o.start(now+i*0.12); g.gain.setValueAtTime(0.22, now+i*0.12); g.gain.exponentialRampToValueAtTime(0.01, now+i*0.12+0.22); o.stop(now+i*0.12+0.23); }); setTimeout(()=>{try{ctx.close();}catch{}},700);} }catch{} try{ if('speechSynthesis' in window){ speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance('New message, senpai~ ♡'); const v=getAnimeVoice(); if(v){ u.voice=v; u.lang=v.lang; } else u.lang='ja-JP'; u.volume=0.85; u.rate=1.05; u.pitch=1.65; const voices=speechSynthesis.getVoices(); if(!voices.length){ speechSynthesis.addEventListener('voiceschanged',()=>{ const vv=getAnimeVoice(); if(vv) u.voice=vv; speechSynthesis.speak(u); },{once:true}); setTimeout(()=>speechSynthesis.speak(u),120);} else speechSynthesis.speak(u);} }catch{} }
function renderChat(){
  const box=document.getElementById('standalone-messages'); if(!box) return; box.replaceChildren();
  for(const m of chatMessages){
    const mine=currentUser.sub?m.authorSub===currentUser.sub:m.author===currentUser.name;
    const wrap=document.createElement('div'); wrap.className='chat-msg '+(mine?'mine':'theirs'); wrap.style.cssText='max-width:76%;padding:8px 10px 6px;border-radius:12px;font-size:13.5px;line-height:1.38;word-break:break-word;white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.08);align-self:'+(mine?'flex-end':'flex-start')+';background:'+(mine?'#effdde':'#fff')+';'+(mine?'border-bottom-right-radius:4px;':'border-bottom-left-radius:4px;border:1px solid rgba(0,0,0,.04);');
    if(document.documentElement.getAttribute('data-theme')==='dark'){ wrap.style.background=mine?'#2b5278':'#182533'; wrap.style.color=mine?'#fff':'#e8e8e8'; wrap.style.borderColor=mine?'#2b5278':'#1e2e3e'; }
    const head=document.createElement('div'); head.style.cssText='display:flex;gap:6px;align-items:center;margin-bottom:3px;';
    const author=document.createElement('span'); author.style.cssText='font-weight:700;font-size:11.5px;color:#2b5278;'; author.textContent=m.author; if(mine) author.style.display='none';
    const time=document.createElement('span'); time.style.cssText='font-size:11px;color:#6a6a6a;margin-left:auto;white-space:nowrap;'; time.textContent=fmtTime(m.createdAt);
    const del=document.createElement('button'); del.textContent='×'; del.title='Удалить'; del.style.cssText='margin-left:6px;visibility:hidden;font-size:11px;color:#9a9a9a;background:none;border:none;cursor:pointer;'; if(!mine) del.style.display='none'; del.onclick=async()=>{ if(!confirm('Удалить сообщение?')) return; try{ await api('DELETE','/api/chat/'+m.id); await fetchChat(true);}catch(e){ alert(e.message); } };
    wrap.addEventListener('mouseenter',()=>del.style.visibility='visible'); wrap.addEventListener('mouseleave',()=>del.style.visibility='hidden');
    head.append(author,time,del); wrap.append(head);
    if(m.text){ const t=document.createElement('div'); t.textContent=m.text; wrap.append(t); }
    if(m.file){ const fr=document.createElement('div'); fr.style.cssText='display:flex;align-items:center;gap:8px;margin-top:6px;padding:7px 9px;background:rgba(0,0,0,.04);border-radius:8px;border:1px solid #edeae9;'; const icon=document.createElement('span'); icon.textContent=m.file.type&&m.file.type.startsWith('image/')?'🖼️':'📄'; const a=document.createElement('a'); a.href=m.file.url; a.download=m.file.name; a.target='_blank'; a.textContent=m.file.name; a.style.cssText='color:#4573d2;text-decoration:none;font-weight:600;font-size:13px;word-break:break-all;'; const sz=document.createElement('span'); sz.textContent=formatFileSize(m.file.size||0); sz.style.cssText='font-size:11px;color:#6a6a6a;white-space:nowrap;'; fr.append(icon,a,sz); wrap.append(fr); }
    box.append(wrap);
  }
  if(!chatMessages.length){ const e=document.createElement('div'); e.style.cssText='text-align:center;padding:20px;color:#6a6a6a;'; e.textContent='Пока нет сообщений. Начните общение!'; box.append(e); }
  box.scrollTop=box.scrollHeight;
  document.getElementById('standalone-online').textContent=chatMessages.length?chatMessages.length+' сообщений':'';
}
async function fetchChat(){
  try{
    const msgs=await api('GET','/api/chat');
    const prevIds=new Set(chatMessages.map(m=>m.id));
    const newOnes=msgs.filter(m=>!prevIds.has(m.id)&&!chatLastIds.has(m.id));
    const hasNew=newOnes.some(m=>m.authorSub!==currentUser.sub&&m.author!==currentUser.name);
    chatMessages=msgs; for(const m of msgs) chatLastIds.add(m.id);
    if(hasNew){ playChatSound(); }
    renderChat();
  }catch{}
}
async function uploadFiles(files){
  for(const file of files){
    const caption=document.getElementById('standalone-input').value.trim().slice(0,2000);
    try{
      const res=await fetch('/api/chat/file',{ method:'POST', headers:{ 'X-Filename':encodeURIComponent(file.name), 'X-Text':encodeURIComponent(caption), 'Content-Type':file.type||'application/octet-stream'}, body:file });
      if(res.status===401) { window.location.href='/login'; return; }
      let data={}; try{ data=await res.json();}catch{}
      if(!res.ok) throw new Error(data.error||'Ошибка загрузки');
      document.getElementById('standalone-input').value='';
      await fetchChat();
    }catch(e){ alert(e.message||'Не удалось отправить файл'); }
  }
}
(async function init(){
  try{
    const info=await api('GET','/api/auth-info');
    currentUser={name:info.name||'',sub:info.sub||''};
  }catch{}
  try{ const state=await api('GET','/api/state'); if(Array.isArray(state.chat)){ chatMessages=state.chat.slice(-200); chatLastIds=new Set(chatMessages.map(m=>m.id)); } }catch{}
  renderChat(); fetchChat(); setInterval(fetchChat,900);
  const input=document.getElementById('standalone-input');
  const send=document.getElementById('standalone-send');
  const attach=document.getElementById('standalone-attach');
  const fileInput=document.getElementById('standalone-file-input');
  const soundChk=document.getElementById('standalone-sound');
  const voiceSel=document.getElementById('standalone-voice');
  const box=document.getElementById('standalone-messages');
  if(soundChk){ soundChk.checked=chatSoundEnabled; soundChk.addEventListener('change',()=>{ chatSoundEnabled=soundChk.checked; localStorage.setItem('al-chat-sound',JSON.stringify(chatSoundEnabled)); if(chatSoundEnabled) playChatSound(); }); }
  if(voiceSel){ populateVoiceSelect(); if(speechSynthesis){ speechSynthesis.addEventListener('voiceschanged',populateVoiceSelect); setTimeout(populateVoiceSelect,800);} voiceSel.addEventListener('change',()=>{ selectedVoiceURI=voiceSel.value; localStorage.setItem('al-chat-voice',selectedVoiceURI); if(chatSoundEnabled) playChatSound();});}
  async function sendText(){ const text=input.value.trim(); if(!text) return; input.value=''; try{ await api('POST','/api/chat',{text}); await fetchChat(); }catch(e){ alert(e.message); input.value=text; } }
  send.addEventListener('click',sendText);
  input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendText(); }});
  attach.addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change',()=>{ if(fileInput.files.length){ uploadFiles([...fileInput.files]); fileInput.value=''; }});
  box.addEventListener('dragover',e=>{ e.preventDefault(); box.style.outline='2px dashed #4573d2';});
  box.addEventListener('dragleave',e=>{ if(!box.contains(e.relatedTarget)) box.style.outline='';});
  box.addEventListener('drop',e=>{ e.preventDefault(); box.style.outline=''; const files=[...(e.dataTransfer.files||[])]; if(files.length) uploadFiles(files); });
  const unlock=()=>{ try{ const AC=window.AudioContext||window.webkitAudioContext; if(AC){ const c=new AC(); c.resume(); c.close();}}catch{} document.removeEventListener('click',unlock);};
  document.addEventListener('click',unlock,{once:true});
})();
