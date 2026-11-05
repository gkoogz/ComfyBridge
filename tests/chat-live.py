"""One neutral smoke exchange against the installed bridge; leaves it for visual review."""
import json
import os
from pathlib import Path
import time
import urllib.request
import uuid

data=Path(os.environ['LOCALAPPDATA'])/'ComfyBridge'
headers={'Authorization':'Bearer '+(data/'token.txt').read_text().strip(),
         'X-Bridge-Device':'11111111-1111-4111-8111-111111111111','Content-Type':'application/json'}
def api(route,body=None):
    req=urllib.request.Request('http://127.0.0.1:18765/api/'+route,headers=headers,data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
state=api('studio/chat/state')
if state['messages'] or state['draft']:
    raise SystemExit('An existing conversation or draft is present; left it untouched.')
start=time.monotonic()
result=api('studio/chat/send',dict(conversation=state['conversation'],draft_revision=state['draft_revision'],
    id=str(uuid.uuid4()),text='Suggest one concise image-generation prompt for a quiet mountain valley at sunrise, with soft mist and natural colors. Reply with only the prompt.',source='image positive'))
previous=None
while time.monotonic()-start<240:
    state=api('studio/chat/state')
    phase=(state['status'],state['detail'])
    if phase!=previous:
        print({'state':phase[0],'detail':phase[1],'elapsed':round(time.monotonic()-start,1)},flush=True)
        previous=phase
    if not state['busy']:
        answer=state['messages'][-1]
        print({'status':answer['status'],'reply':answer['content'],'elapsed':round(time.monotonic()-start,1)},flush=True)
        if answer['status']!='complete' or not answer['content'].strip():raise SystemExit('Live reply failed.')
        break
    time.sleep(.6)
else:raise SystemExit('Live reply did not finish before timeout; left queued state intact.')
