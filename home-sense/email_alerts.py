"""Local SMTP settings and bounded asynchronous Away alert delivery."""
import json,os,queue,smtplib,ssl,threading
from email.message import EmailMessage
from email.utils import parseaddr
class EmailAlerts:
 def __init__(self,path):
  self.path=path;self.lock=threading.Lock();self.last='Not sent yet';self.jobs=queue.Queue(maxsize=32)
  threading.Thread(target=self.worker,daemon=True).start()
 def config(self):
  with self.lock:
   return json.loads(self.path.read_text()) if self.path.exists() else {}
 def status(self):
  c=self.config();return {**{k:v for k,v in c.items() if k!='password'},'hasPassword':bool(c.get('password')),'lastDelivery':self.last}
 def save(self,c):
  old=self.config()
  if not isinstance(c,dict):raise ValueError('Invalid email settings')
  for k in ['recipient','sender']:
   v=c.get(k,'')
   if not isinstance(v,str) or '\n' in v or '\r' in v or parseaddr(v)[1]!=v or '@' not in v:raise ValueError('Enter a valid '+k+' email address')
  host=c.get('host','');port=c.get('port',587)
  if not isinstance(host,str) or not host.strip() or len(host)>253:raise ValueError('Enter an SMTP server')
  if type(port)!=int or not 1<=port<=65535:raise ValueError('Invalid SMTP port')
  if c.get('security') not in ('starttls','tls'):raise ValueError('Choose STARTTLS or TLS')
  if type(c.get('enabled'))!=bool:raise ValueError('Invalid enabled setting')
  c={k:c.get(k,'') for k in ['recipient','sender','host','port','security','username','password','enabled']}
  if not c['password']:c['password']=old.get('password','')
  if any(not isinstance(c[k],str) or len(c[k])>4096 for k in ['username','password']):raise ValueError('Invalid credentials')
  with self.lock:
   fd=os.open(str(self.path),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
   with os.fdopen(fd,'w') as f:json.dump(c,f)
   self.path.chmod(0o600)
  return self.status()
 def enqueue(self,event=None,test=False):
  c=self.config()
  if not c:return False
  if not test and (not c.get('enabled') or not event or event.get('source')!='live'):return False
  try:self.jobs.put_nowait((c,event,test));return True
  except queue.Full:self.last='Email queue full';return False
 def send(self,c,event,test):
  m=EmailMessage();m['From']=c['sender'];m['To']=c['recipient'];m['Subject']='Haven: test email' if test else 'Haven: movement detected while Away'
  m.set_content('Your Haven email alerts are configured.' if test else f"Movement detected in {event['room']} at {event['at']}.\nMoving radar reflections require review.\n")
  cls=smtplib.SMTP_SSL if c['security']=='tls' else smtplib.SMTP
  options={'timeout':10}
  if c['security']=='tls':options['context']=ssl.create_default_context()
  with cls(c['host'],c['port'],**options) as smtp:
   if c['security']=='starttls':smtp.ehlo();smtp.starttls(context=ssl.create_default_context());smtp.ehlo()
   if c['username']:smtp.login(c['username'],c['password'])
   smtp.send_message(m)
 def worker(self):
  while True:
   c,e,t=self.jobs.get()
   try:self.send(c,e,t);self.last='Accepted by email server'
   except Exception as exc:self.last='Delivery failed: '+type(exc).__name__
   finally:self.jobs.task_done()
