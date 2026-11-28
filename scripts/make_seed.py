#!/usr/bin/env python3
"""Builds the one-time private seed for the live-update Worker from a listening-history export.
The output holds hashed song fingerprints and the 36 songs the page shows. Keep it private (never commit it).
Usage: python3 scripts/make_seed.py path/to/export.json path/to/seed-PRIVATE.json"""
import json,re,sys,secrets,hashlib,collections,datetime as dt
from zoneinfo import ZoneInfo
N=12;TZ=ZoneInfo('America/New_York');PH='2a96cbd8b46e442fc41c2b86b821562f'
pages=json.load(open(sys.argv[1],encoding='utf8'))
tr=[t for pg in pages for t in (pg if isinstance(pg,list) else [pg]) if t.get('date')]
norm=lambda s:re.sub(r'\s+',' ',s.lower().strip())
salt=secrets.token_hex(16)
H=lambda a,t:hashlib.sha256((salt+'|'+norm(a)+'|'+norm(t)).encode('utf8')).hexdigest()[:12]
plays=collections.defaultdict(list);meta={}
for t in sorted(tr,key=lambda t:int(t['date']['uts'])):
    a,n=t['artist']['#text'],t['name'];k=H(a,n);plays[k].append(int(t['date']['uts']))
    art=next((i['#text'] for i in t.get('image',[]) if i.get('size')=='large' and i['#text'] and PH not in i['#text']),None)
    m=meta.setdefault(k,{});m.update(title=n,artist=a,album=(t.get('album') or {}).get('#text') or '')
    if art:m['art']=art
day=lambda u:dt.datetime.fromtimestamp(u,TZ).date()
def pick(n,ok=lambda v:True):
    c=sorted(((v[n-1],k,len(v)) for k,v in plays.items() if len(v)>=n and ok(v)),reverse=True)
    return [dict(meta[k],when=u,plays=tot) for u,k,tot in c[:N]]
out={'discovered':pick(1),'returned':pick(2,lambda v:day(v[1])>day(v[0])),'ten':pick(10),
     'totals':{'scrobbles':len(tr),'songs':len(plays),'from':min(min(v) for v in plays.values()),'to':max(max(v) for v in plays.values())}}
shards=collections.defaultdict(dict)
for k,v in plays.items():
    shards[k[:2]][k[2:]]=[len(v),v[0],v[1] if len(v)>1 else 0,v[9] if len(v)>9 else 0]
seed={'salt':salt,'cursor':max(max(v) for v in plays.values()),'out':out,'shards':shards}
open(sys.argv[2],'w',encoding='utf8').write(json.dumps(seed,ensure_ascii=False,separators=(',',':')))
print(len(shards),'shards,',len(plays),'songs, cursor',seed['cursor'])
