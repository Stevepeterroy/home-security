"""Persistent live motion review rule; no human or medical classifier."""
import time,uuid
from room_geometry import reflection_in_room
from datetime import datetime,timezone
class AwayRule:
 def __init__(self):self.last=None;self.count=0;self.latched=False;self.last_time=0
 def evaluate(self,home,state,now=None):
  now=now or time.time();frame=state.get('last_frame')
  enabled=home and home.get('away') and home.get('dataSource')=='live' and state.get('connected') and state.get('radar_verified')
  if not enabled or not frame or now-frame.get('received_at',0)>1.5:
   self.count=0;self.latched=False;return None
  key=(frame['sequence'],frame['received_at'])
  if key==self.last:return None
  if frame['received_at']-self.last_time>2 or frame['received_at']<self.last_time:self.count=0;self.latched=False
  self.last=key;self.last_time=frame['received_at']
  module=next((m for m in home['modules'] if m['id']==home.get('activeModuleId')),home['modules'][0] if home['modules'] else None)
  region=next((r for r in home['rooms'] if module and r['id']==module.get('roomId')),None)
  motion=frame['reported_points']>0 and any(abs(p['velocity_cm_s'])>=50 and (not region or not region.get('boundary') or reflection_in_room(p,module,region)) for p in frame['points'])
  self.count=self.count+1 if motion else 0
  if not motion:self.latched=False
  if self.count<3 or self.latched:return None
  self.latched=True
  module=next((m for m in home['modules'] if m['id']==home.get('activeModuleId')),home['modules'][0] if home['modules'] else None)
  room=next((r['name'] for r in home['rooms'] if module and r['id']==module['roomId']),'Unassigned room')
  return {'id':str(uuid.uuid4()),'at':datetime.fromtimestamp(now,timezone.utc).isoformat(),'room':room,'kind':'Motion reflections while away — review needed','source':'live','acknowledged':False}
