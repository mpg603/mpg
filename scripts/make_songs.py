#!/usr/bin/env python3
"""Turns a listening-history export (list of pages of tracks) into the small songs.json the Songs page reads.
Only 3 x 12 songs are written. The export itself is never copied into the site.
Usage: python3 scripts/make_songs.py path/to/scrobbles.json [out.json]"""
import json,re,sys,collections,datetime as dt
from zoneinfo import ZoneInfo
N=12;TZ=ZoneInfo('America/New_York');PLACEHOLDER='2a96cbd8b46e442fc41c2b86b821562f'
src=sys.argv[1];out=sys.argv[2] if len(sys.argv)>2 else 'songs.json'
pages=json.load(open(src,encoding='utf8'))
tr=[t for pg in pages for t in (pg if isinstance(pg,list) else [pg]) if t.get('date')]
norm=lambda s:re.sub(r'\s+',' ',s.lower().strip())
key=lambda t:(norm(t['artist']['#text']),norm(t['name']))
plays=collections.defaultdict(list);meta={}
for t in sorted(tr,key=lambda t:int(t['date']['uts'])):
    k=key(t);plays[k].append(int(t['date']['uts']))
    art=next((i['#text'] for i in t.get('image',[]) if i.get('size')=='large' and i['#text'] and PLACEHOLDER not in i['#text']),None)
    m=meta.setdefault(k,{});m.update(title=t['name'],artist=t['artist']['#text'],album=(t.get('album') or {}).get('#text') or '')
    if art:m['art']=art
day=lambda u:dt.datetime.fromtimestamp(u,TZ).date()
def pick(n,ok=lambda v:True):
    c=[(v[n-1],k,len(v)) for k,v in plays.items() if len(v)>=n and ok(v)]
    c.sort(reverse=True)
    return [dict(meta[k],when=u,plays=tot) for u,k,tot in c[:N]]
res={'discovered':pick(1),
     'returned':pick(2,lambda v:day(v[1])>day(v[0])),   # a second listen on a later day, so a replay the same evening doesn't count
     'ten':pick(10),
     'totals':{'scrobbles':len(tr),'songs':len(plays),'from':min(min(v) for v in plays.values()),'to':max(max(v) for v in plays.values())}}
open(out,'w',encoding='utf8').write(json.dumps(res,ensure_ascii=False,indent=1))
print({k:len(v) for k,v in res.items() if k!='totals'},res['totals'])
