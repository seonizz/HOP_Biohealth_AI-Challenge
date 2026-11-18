# 실험 1: 문구 후보 정적 점검 (혼동 가능성·이중 질문·시점 표지·전제어)
import json, itertools, re, sys
V30 = {q['id']: q['text'] for q in json.load(open('../../seeds/questionnaire-v3/questions.json'))['questions']}
CANDS = {
 'Q3-03': {'a(3.0)': V30['Q3-03'],
           'b': '누구와 어떤 일이 있었는지 알려 주실 수 있나요?',
           'c': '이번에 다루고 싶은 일은 누구와의 어떤 일인가요?'},
 'Q3-04': {'a(3.0)': V30['Q3-04'],
           'b': '그 상황에서 상대가 실제로 한 말이나 행동은 무엇인가요?',
           'c': '그때 상대가 실제로 한 말이나 행동을 알려 주실 수 있나요?'},
 'Q3-05': {'a(3.0)': V30['Q3-05'],
           'b': '지금까지 이 일로 상대에게 이미 한 말이나 행동이 있었나요? 있었다면 그 뒤 상대는 어떻게 반응했나요?',
           'c': '이 일로 지금까지 본인이 상대에게 한 말이나 행동이 있나요? 있다면 상대는 어떻게 반응했나요?'},
 'Q3-07': {'a(3.0)': V30['Q3-07'],
           'b': '이 일과 관련해 상대가 "이렇게 해 줬으면 좋겠다"거나 "이건 안 했으면 좋겠다"고 말한 적이 있나요?',
           'c': '이 일과 관련해 상대가 바란다고 했거나 하지 말아 달라고 한 것이 있나요?'},
 'Q3-08': {'a(3.0)': V30['Q3-08'],
           'b': '앞으로 본인이 해 줄 수 있는 도움은 어느 정도인가요? 가능한 시간이 있다면 함께 알려 주세요.',
           'c': '앞으로 본인이 할 수 있는 일과 가능한 시간은 어느 정도인가요?'},
 'Q3-09': {'a(3.0)': V30['Q3-09'],
           'b': '할 수 있는지와는 별개로, 이번에 본인은 어떻게 하고 싶으신가요?',
           'c': '이번 일에서 본인이 하고 싶은 것은 무엇인가요?'},
}
norm = lambda s: re.sub(r'[\s\W_]+','',s)
def grams(s):
    s=norm(s); return {s[i:i+2] for i in range(len(s)-1)}
jac = lambda a,b: len(grams(a)&grams(b))/len(grams(a)|grams(b))
PAST = re.compile(r'지금까지|이미|그때|했|있었'); FUT = re.compile(r'앞으로')
def lint(qid, t):
    return dict(chars=len(t), sentences=len(re.findall(r'[?.](?:\s|$)', t)), qmarks=t.count('?'),
        time_anchor=bool(PAST.search(t)) if qid in('Q3-04','Q3-05') else bool(FUT.search(t)) if qid=='Q3-08' else None,
        presumes_help='도움' in t if qid in('Q3-07','Q3-08') else None,
        or_pairs=len(re.findall(r'거나|이나|또는', t)))
def set_stats(texts):
    pairs=[(a,b,jac(texts[a],texts[b])) for a,b in itertools.combinations(sorted(texts),2)]
    top=sorted(pairs,key=lambda p:-p[2])[:3]
    return dict(mean=round(sum(p[2] for p in pairs)/len(pairs),3), max=round(top[0][2],3),
                top3=[(a,b,round(j,3)) for a,b,j in top], total_chars=sum(len(t) for t in texts.values()),
                total_qmarks=sum(t.count('?') for t in texts.values()))
out={'per_candidate':{}, 'sets':{}}
for qid,c in CANDS.items():
    for k,t in c.items(): out['per_candidate'][f'{qid}:{k}']={'text':t,**lint(qid,t)}
base={k:v for k,v in V30.items() if k!='Q3-10'}
out['sets']['3.0']=set_stats(base)
best=None
for combo in itertools.product(*[[(qid,k) for k in c] for qid,c in CANDS.items()]):
    texts=dict(base)
    for qid,k in combo: texts[qid]=CANDS[qid][k]
    s=set_stats(texts); key=(s['max'],s['mean'],s['total_qmarks'],s['total_chars'])
    name=','.join(f"{q[-2:]}{k[0]}" for q,k in combo)
    if best is None or key<best[0]: best=(key,name,s)
    if name in ('03c,04b,05c,07c,08c,09c','03b,04b,05b,07b,08b,09b'): out['sets'][name]=s
out['sets']['argmin(max,mean,qmarks,chars) '+best[1]]=best[2]
out['q5_vs_q8']={'3.0':round(jac(V30['Q3-05'],V30['Q3-08']),3),
  'b':round(jac(CANDS['Q3-05']['b'],CANDS['Q3-08']['b']),3),'c':round(jac(CANDS['Q3-05']['c'],CANDS['Q3-08']['c']),3)}
out['q8_vs_q9']={'3.0':round(jac(V30['Q3-08'],V30['Q3-09']),3),'c/b':round(jac(CANDS['Q3-08']['c'],CANDS['Q3-09']['b']),3),'c/c':round(jac(CANDS['Q3-08']['c'],CANDS['Q3-09']['c']),3)}
json.dump(out,open('e1_result.json','w'),ensure_ascii=False,indent=1)
for k,v in out['per_candidate'].items(): print(k, {x:y for x,y in v.items() if x!='text' and y is not None})
for k,v in out['sets'].items(): print(k, v)
print(out['q5_vs_q8'], out['q8_vs_q9'])
