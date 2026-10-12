import { useEffect, useState } from "react";
export default function EmailSetup() {
 const [settings,setSettings]=useState<Record<string,any>>({recipient:"",sender:"",host:"",port:587,security:"starttls",username:"",password:"",enabled:false});
 const [message,setMessage]=useState("");
 async function load(){const r=await fetch('/api/email/settings');if(r.ok)setSettings({...await r.json(),password:""});}
 useEffect(()=>{void load();},[]);
 async function submit(test=false){try{const r=await fetch(test?'/api/email/test':'/api/email/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(test?{}:settings)});const v=await r.json();if(!r.ok)throw Error(v.error);setMessage(test?'Test email queued. Check your inbox and delivery status.':'Email settings saved.');await load();}catch(e){setMessage((e as Error).message);}}
 return <section className="panel"><h2>Email alerts</h2><p>Receive an email when movement triggers an Away alert. Keep Haven running.</p><form onSubmit={e=>{e.preventDefault();void submit();}}>
 {(['recipient','sender','host','username'] as const).map(k=><label key={k}>{({recipient:'Send alerts to',sender:'From email address',host:'SMTP server',username:'SMTP username'})[k]}<input required={k!=='username'} type={k==='recipient'||k==='sender'?'email':'text'} value={settings[k]||''} onChange={e=>setSettings({...settings,[k]:e.target.value})}/></label>)}
 <label>SMTP port<input type="number" min="1" max="65535" required value={settings.port} onChange={e=>setSettings({...settings,port:Number(e.target.value)})}/></label>
 <label>Secure connection<select value={settings.security} onChange={e=>setSettings({...settings,security:e.target.value})}><option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option></select></label>
 <label>SMTP password or app password<input type="password" autoComplete="new-password" value={settings.password} placeholder={settings.hasPassword?'Saved — leave blank to keep it':'Enter your provider’s SMTP password'} onChange={e=>setSettings({...settings,password:e.target.value})}/></label>
 <label><input type="checkbox" checked={settings.enabled} onChange={e=>setSettings({...settings,enabled:e.target.checked})}/> Enable Away email alerts</label>
 <div className="button-row"><button type="submit">Save email setup</button><button type="button" onClick={()=>void submit(true)}>Send test email</button><button type="button" onClick={()=>void load()}>Refresh delivery status</button></div></form>
 <p role="status">{message}</p><p className="muted small">Delivery: {settings.lastDelivery||'Not configured'}. Use the SMTP details supplied by your email provider. The saved password stays on this computer.</p></section>;
}
