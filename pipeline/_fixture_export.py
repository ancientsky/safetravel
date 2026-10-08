"""Quick fixture exporter (no Gemini) so the frontend can be developed before the real pipeline exists."""
import json, re, unicodedata, hashlib, random
from pathlib import Path
import pandas as pd
ROOT = Path('/home/user/safetravel'); OUT = ROOT/'web/data'
LV = {'第一級:注意(Watch)':1,'第二級:警示(Alert)':2,'第三級:警告(Warning)':3,'解除':0}
levels = {"1":{"zh":"第一級：注意（Watch）","en":"Level 1: Watch","instruction_zh":"提醒遵守當地的一般預防措施","instruction_en":"Practice usual precautions"},
          "2":{"zh":"第二級：警示（Alert）","en":"Level 2: Alert","instruction_zh":"對當地採取加強防護","instruction_en":"Practice enhanced precautions"},
          "3":{"zh":"第三級：警告（Warning）","en":"Level 3: Warning","instruction_zh":"避免至當地所有非必要旅遊","instruction_en":"Avoid all non-essential travel"}}
dis = json.loads((ROOT/'data/manual/diseases.json').read_text()); terr = json.loads((ROOT/'data/manual/territories.json').read_text())
names = json.loads((ROOT/'web/data/countries.json').read_text())
nfkc = lambda s: unicodedata.normalize('NFKC', s or '').strip()
a = pd.read_csv(ROOT/'data/raw/TCDCTravelAlertAll.csv', encoding='utf-8-sig', dtype=str, keep_default_na=False)
a = a[a.alert_disease != '嚴重特殊傳染性肺炎']
a['eff'] = pd.to_datetime(a.effective, utc=True); a = a.sort_values('eff')
a['iso'] = [r.ISO3166 if re.fullmatch(r'[A-Z]{2}', r.ISO3166) else (terr.get(r.areaDesc_EN) or terr.get(r.areaDesc) or '') for r in a.itertuples()]
a['k'] = [r.iso or r.areaDesc for r in a.itertuples()]
last = a.groupby(['alert_disease','k','areaDetail']).tail(1)
act = last[last.severity_level != '解除'].copy(); act['level'] = act.severity_level.map(LV)
glob_keys = {(d,l) for (d,l),g in act.groupby(['alert_disease','level']) if g.iso.nunique() >= 150}
globl = [{"disease":d,"level":int(l),"effective":act[(act.alert_disease==d)&(act.level==l)].effective.str[:10].max(),"countries":int(act[(act.alert_disease==d)&(act.level==l)].iso.nunique())} for d,l in glob_keys]
act = act[[ (r.alert_disease, r.level) not in glob_keys for r in act.itertuples()]]
countries, unmapped = {}, {}
for r in act.sort_values(['level','eff'], ascending=[False,False]).itertuples():
    item = {"disease":r.alert_disease,"level":int(r.level),"effective":r.effective[:10],"area_zh":r.areaDetail,"area_en":r.areaDetail,"iso_sub":r.ISO3166_2}
    if r.iso:
        c = countries.setdefault(r.iso, {"name_zh": r.areaDesc if not r.areaDetail else names.get(r.iso,{}).get('zh',r.areaDesc), "name_en": names.get(r.iso,{}).get('en', r.areaDesc_EN), "max_level":0, "alerts":[]})
    else:
        c = unmapped.setdefault(r.areaDesc_EN or r.areaDesc, {"name_zh": r.areaDesc, "name_en": r.areaDesc_EN, "max_level":0, "alerts":[]})
    c['alerts'].append(item); c['max_level'] = max(c['max_level'], item['level'])
all_d = {d:{"zh":d,"en":dis.get(d,d)} for d in sorted(set(act.alert_disease))}
e = pd.read_csv(ROOT/'data/raw/TCDCIntlEpid.csv', encoding='utf-8-sig', dtype=str, keep_default_na=False)
items = []
for r in e.itertuples():
    desc = nfkc(r.description); head = nfkc(r.headline)
    isos = [x.strip().upper() for x in r.ISO3166.split(',') if re.fullmatch(r'\s*[A-Za-z]{2}\s*', x)]
    m = re.search(r'epidemicId=([\w-]+)', r.web); iid = m.group(1) if m else hashlib.md5((head+r.effective).encode()).hexdigest()[:12]
    first = re.split(r'(?<=[。！？])', desc)[0][:120] if desc else head
    dz = nfkc(r.alert_disease); 
    items.append({"id":iid,"date":r.effective[:10],"disease_zh":dz,"disease_en":dis.get(dz,dz),"headline_zh":head,"headline_en":head,"summary_zh":first,"summary_en":first,"description_zh":desc,"description_en":desc,"countries":isos,"area_zh":r.areaDesc,"area_en":r.areaDesc_EN,"url":r.web,"ai":False, **({"global":True} if r.areaDesc.startswith('全球') else {})})
    for d in set(dz.split(',')): all_d.setdefault(d, {"zh":d,"en":dis.get(d,d)})
items.sort(key=lambda x: x['date'], reverse=True)
overviews = {}
for iso in {c for it in items for c in it['countries']}:
    its = [it for it in items if iso in it['countries']]
    overviews[iso] = {"zh": f"近兩年共 {len(its)} 則疫情摘要，最新為「{its[0]['headline_zh']}」。", "en": f"{len(its)} epidemic digests in the past two years; latest: {its[0]['headline_zh']}.", "items": len(its), "updated": "2026-10-08"}
(OUT/'alerts.json').write_text(json.dumps({"generated_at":"2026-10-08T05:30:00+08:00","levels":levels,"diseases":all_d,"global":globl,"countries":countries,"unmapped":list(unmapped.values())}, ensure_ascii=False), encoding='utf-8')
(OUT/'epidemics.json').write_text(json.dumps({"generated_at":"2026-10-08T05:30:00+08:00","window_start":"2024-10-08","items":items,"overviews":overviews}, ensure_ascii=False), encoding='utf-8')
# synthetic flights fixture (real routes, invented counts)
ap = json.loads((OUT/'airports.json').read_text())
routes_src = {"NRT":("東京(成田)","Tokyo (Narita)",14,13,["CI","BR","JL","JX"]),"HND":("東京(羽田)","Tokyo (Haneda)",6,6,["CI","BR","JL","NH"]),"KIX":("大阪","Osaka",10,10,["CI","BR","JX","IT"]),"NGO":("名古屋","Nagoya",4,4,["CI","JX"]),"FUK":("福岡","Fukuoka",5,5,["CI","BR","IT"]),"CTS":("札幌","Sapporo",4,4,["BR","JX","IT"]),"OKA":("沖繩","Okinawa",6,6,["CI","BR","IT"]),"ICN":("首爾(仁川)","Seoul (Incheon)",16,16,["CI","BR","KE","OZ","7C","TW"]),"GMP":("首爾(金浦)","Seoul (Gimpo)",2,2,["CI","BR"]),"PUS":("釜山","Busan",5,5,["CI","7C","BX"]),"HKG":("香港","Hong Kong",22,22,["CI","BR","CX","HX","UO"]),"MFM":("澳門","Macau",6,6,["BR","NX"]),"PVG":("上海(浦東)","Shanghai (Pudong)",12,12,["CI","BR","MU","FM"]),"PEK":("北京","Beijing",4,4,["CI","CA"]),"CAN":("廣州","Guangzhou",3,3,["CI","CZ"]),"XMN":("廈門","Xiamen",3,3,["MF","BR"]),"BKK":("曼谷","Bangkok",14,14,["CI","BR","TG","TR","IT"]),"SGN":("胡志明市","Ho Chi Minh City",9,9,["CI","BR","VN","VJ"]),"HAN":("河內","Hanoi",6,6,["CI","BR","VN"]),"DAD":("峴港","Da Nang",3,3,["VJ","IT"]),"MNL":("馬尼拉","Manila",10,10,["CI","BR","PR","5J"]),"CEB":("宿霧","Cebu",2,2,["BR","5J"]),"SIN":("新加坡","Singapore",12,12,["CI","BR","SQ","TR","JX"]),"KUL":("吉隆坡","Kuala Lumpur",7,7,["CI","BR","MH","D7"]),"CGK":("雅加達","Jakarta",4,4,["CI","BR","GA"]),"DPS":("峇里島","Denpasar (Bali)",3,3,["CI","BR"]),"PNH":("金邊","Phnom Penh",3,3,["BR","CI"]),"RGN":("仰光","Yangon",1,1,["CI"]),"DEL":("新德里","New Delhi",1,1,["CI"]),"DXB":("杜拜","Dubai",2,2,["EK"]),"DOH":("杜哈","Doha",1,1,["QR"]),"IST":("伊斯坦堡","Istanbul",1,1,["TK"]),"AMS":("阿姆斯特丹","Amsterdam",2,2,["CI","BR"]),"FRA":("法蘭克福","Frankfurt",2,2,["CI","LH"]),"LHR":("倫敦","London",2,2,["CI","BR"]),"CDG":("巴黎","Paris",2,2,["BR","AF"]),"MUC":("慕尼黑","Munich",1,1,["BR"]),"VIE":("維也納","Vienna",1,1,["BR"]),"MXP":("米蘭","Milan",1,1,["BR"]),"PRG":("布拉格","Prague",1,1,["CI"]),"LAX":("洛杉磯","Los Angeles",6,6,["CI","BR","JX","UA"]),"SFO":("舊金山","San Francisco",5,5,["CI","BR","JX","UA"]),"SEA":("西雅圖","Seattle",2,2,["CI","BR","JX"]),"JFK":("紐約","New York",3,3,["CI","BR","JX"]),"ORD":("芝加哥","Chicago",1,1,["BR"]),"DFW":("達拉斯","Dallas",1,1,["BR"]),"YVR":("溫哥華","Vancouver",3,3,["CI","BR","AC"]),"YYZ":("多倫多","Toronto",1,1,["BR"]),"HNL":("檀香山","Honolulu",1,1,["CI"]),"GUM":("關島","Guam",1,1,["UA"]),"SYD":("雪梨","Sydney",2,2,["CI"]),"BNE":("布里斯本","Brisbane",1,1,["CI","BR"]),"MEL":("墨爾本","Melbourne",1,1,["CI"]),"AKL":("奧克蘭","Auckland",1,1,["CI"]),"ROR":("帛琉","Palau",1,1,["CI"])}
routes=[]; 
for iata,(zh,en,d,ar,al) in routes_src.items():
    p=ap.get(iata); 
    if not p: print('missing',iata); continue
    routes.append({"iata":iata,"city_zh":zh,"city_en":en,"country":p['country'],"lat":p['lat'],"lon":p['lon'],"departures":d,"arrivals":ar,"airlines":al})
(OUT/'flights.json').write_text(json.dumps({"date":"2026-10-08","fetched_at":"2026-10-08T05:30:00+08:00","source":"fixture","hub":{"iata":"TPE","name_en":"Taiwan Taoyuan International Airport","name_zh":"臺灣桃園國際機場","lat":25.0777,"lon":121.233},"routes":routes,"totals":{"departures":sum(r['departures'] for r in routes),"arrivals":sum(r['arrivals'] for r in routes),"destinations":len(routes)}}, ensure_ascii=False), encoding='utf-8')
(OUT/'meta.json').write_text(json.dumps({"generated_at":"2026-10-08T05:30:00+08:00","model":"gemini-3.5-flash","sources":{"alerts":{"url":"https://www.cdc.gov.tw/CountryEpidLevel/ExportCSV?type=0&fileName=TCDCTravelAlertAll.csv","fetched_at":"2026-10-08T05:00:00+08:00","rows":len(a)},"epidemics":{"url":"https://www.cdc.gov.tw/TravelEpidemic/ExportCSV?type=1&fileName=TCDCIntlEpid.csv","fetched_at":"2026-10-08T05:00:00+08:00","rows":len(e)},"flights":{"url":"fixture","fetched_at":"2026-10-08T05:00:00+08:00","date":"2026-10-08","ok":True}},"counts":{"countries_with_alerts":len(countries),"level3":sum(c['max_level']==3 for c in countries.values()),"level2":sum(c['max_level']==2 for c in countries.values()),"level1":sum(c['max_level']==1 for c in countries.values()),"epidemic_items":len(items),"ai_translated":0}}, ensure_ascii=False))
print("countries",len(countries),"unmapped",len(unmapped),"global",globl,"items",len(items))
print({k:v['max_level'] for k,v in countries.items() if v['max_level']==3})
print(json.dumps(countries['CD'],ensure_ascii=False)[:600])
print(json.dumps(countries['CN'],ensure_ascii=False)[:500])
