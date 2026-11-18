# 실험 2: 진행 시뮬레이션 (모델 없이 참조 계획 규칙으로 질문셋 구조만 비교)
# 가정: 이용자는 질문 본문이 명시적으로 묻는 정보는 p_text, 도움말에만 있는 정보는 p_help,
#       묻지 않았지만 상황 설명에 흔히 섞이는 정보는 p_spill 확률로 함께 말한다.
import json, random, itertools, statistics as st
T=json.load(open('../../seeds/questionnaire-v3/tasks.json'))['tasks']
TASK={t['id']:t for t in T}
ORDERS={'O0(3.0 번호순)':[1,2,3,4,5,6,7,8,9],'O1(목적→상황→관계…)':[1,3,2,4,5,6,7,8,9],'O2(필수정보 우선)':[1,3,9,8,2,4,5,6,7]}
# 문항별: 본문이 묻는 정보(text) / 도움말만 언급(help) / 흔히 섞여 나오는 정보(spill)
def cues(v):
    c={1:dict(text={'goal_intent','support_goal'},help=set(),spill={'reported_scene','relationship','boundary_intent','proposal_intent'}),
       2:dict(text={'relationship'},help=set(),spill=set()),
       3:dict(text={'reported_scene','boundary_scope','proposed_action','agreement_items'},help=set(),spill={'relationship','target_observation','supporter_experience','supporter_response'}),
       4:dict(text={'target_observation'},help=set(),spill={'target_preference'}),
       5:dict(text={'supporter_response','target_response','agreement_items'},help=set(),spill=set()),
       6:dict(text={'supporter_experience'},help=set(),spill=set()),
       7:dict(text={'target_preference'},help=set(),spill=set()),
       8:dict(text={'supporter_capacity'},help={'supporter_available_time'},spill={'supporter_intent','chosen_action'}),
       9:dict(text={'supporter_intent','boundary_intent','proposal_intent','chosen_action','support_goal'},help=set(),spill=set())}
    if v>=1:  # Q3 본문이 '누구와의'를 물음
        c[3]['text']=c[3]['text']|{'relationship'}; c[3]['spill']=c[3]['spill']-{'relationship'}
    if v>=2:  # Q8 본문이 시간을 물음
        c[8]['text']=c[8]['text']|{'supporter_available_time'}; c[8]['help']=set()
    if v>=3:  # Q4 도움말이 상대의 바람을 언급
        c[4]['help']={'target_preference'}; c[4]['spill']=set()
    return c
VARIANTS={'W0(3.0 문구)':0,'W1(+Q3 관계)':1,'W2(+Q8 시간)':2,'W3(+Q4 도움말 바람)':3}
def needs(task):
    return {int(k[-2:]):set(v) for k,v in TASK[task].get('question_needs',{}).items() if k!='Q3-10'}
def run(task,order,cue,p,rng,budget,reserve,reqonly=False):
    known={'goal_intent'}; asked=[]; unknown=set(); wasted=0
    req=set(TASK[task]['required_facts']); nd=needs(task)
    def ask(q):
        nonlocal wasted
        asked.append(q); got=set()
        for f in cue[q]['text']:
            if rng.random()<p['text']: got.add(f)
        for f in cue[q]['help']:
            if rng.random()<p['help']: got.add(f)
        for f in cue[q]['spill']:
            if rng.random()<p['spill']: got.add(f)
        new=(got-known)
        if not (new & (set().union(*nd.values())|req|{'support_goal'})): wasted+=1
        known.update(got)
    ask(1)
    while len(asked)<budget:
        cand=[q for q in order if q in nd and q not in asked and (nd[q]-known)]
        if reqonly: cand=[q for q in cand if nd[q]&(req-known)]
        if reserve:
            miss=req-known; left=budget-len(asked)
            if len(miss)>=left: cand=[q for q in cand if nd[q]&miss] or cand
        if not cand: break
        ask(cand[0])
    miss=req-known
    # 필수 정보가 빠졌고 담당 문항을 이미 썼다면 맞춤 추가 질문이 필요한 상황
    custom=sum(1 for f in miss if any(f in nd.get(q,set()) for q in asked))
    return dict(n=len(asked),complete=not miss,wasted=wasted,custom=custom)
def cell(order,v,p,budget,reserve,N=4000,seed=7):
    rng=random.Random(seed); rows=[]
    for task in TASK:
        for _ in range(N): rows.append(run(task,ORDERS[order],cues(VARIANTS[v]),p,rng,budget,reserve))
    m=lambda k: round(st.mean(r[k] for r in rows),3)
    return dict(avg_questions=m('n'),required_complete=m('complete'),wasted_per_session=m('wasted'),custom_needed=m('custom'))
P={'text':0.9,'help':0.3,'spill':0.35}
res={}
for budget,reserve in [(4,False),(4,True),(10,False)]:
    for o in ORDERS:
        for v in VARIANTS:
            res[f'budget{budget}{"+필수예약" if reserve else ""}|{o}|{v}']=cell(o,v,P,budget,reserve)
# 민감도: 확률 가정을 바꿔도 3.1(O1,W2)이 3.0(O0,W0)보다 나쁘지 않은가
sens=[]
for pt,ph,ps in itertools.product([0.7,0.9,1.0],[0.1,0.3,0.6],[0.1,0.35,0.6]):
    p={'text':pt,'help':ph,'spill':ps}
    a=cell('O0(3.0 번호순)','W0(3.0 문구)',p,4,False,N=1500); b=cell('O1(목적→상황→관계…)','W2(+Q8 시간)',p,4,False,N=1500)
    sens.append(dict(p=p,v30=a,v31=b))
res['_sensitivity']=dict(cases=len(sens),
  v31_fewer_or_equal_questions=sum(s['v31']['avg_questions']<=s['v30']['avg_questions']+0.01 for s in sens),
  v31_higher_or_equal_complete=sum(s['v31']['required_complete']>=s['v30']['required_complete']-0.005 for s in sens),
  v31_fewer_custom=sum(s['v31']['custom_needed']<=s['v30']['custom_needed']+0.002 for s in sens),
  mean_delta_questions=round(st.mean(s['v31']['avg_questions']-s['v30']['avg_questions'] for s in sens),3),
  mean_delta_complete=round(st.mean(s['v31']['required_complete']-s['v30']['required_complete'] for s in sens),3))
# 과업별
bytask={}
for task in TASK:
    for name,(o,v) in {'3.0':('O0(3.0 번호순)','W0(3.0 문구)'),'3.1':('O1(목적→상황→관계…)','W2(+Q8 시간)')}.items():
        rng=random.Random(11); rows=[run(task,ORDERS[o],cues(VARIANTS[v]),P,rng,4,False) for _ in range(6000)]
        bytask[f'{task}|{name}']=dict(avg_q=round(st.mean(r['n'] for r in rows),2),complete=round(st.mean(r['complete'] for r in rows),3),custom=round(st.mean(r['custom'] for r in rows),3))
res['_by_task_budget4']=bytask
json.dump(res,open('e2_result.json','w'),ensure_ascii=False,indent=1)
for k,v in res.items():
    if k.startswith('_'): print(k, json.dumps(v,ensure_ascii=False))
    else: print(f'{k:58s}',v)

# 필수 정보만 묻는 계획(앱 프롬프트의 "꼭 필요한 경우에만"에 가장 가까움) + 시드 5회 반복
print('--- 필수정보만 묻는 계획, 예산 4, 시드 5회 ---')
rep={}
for name,(o,v) in {'3.0':('O0(3.0 번호순)','W0(3.0 문구)'),'3.1':('O1(목적→상황→관계…)','W2(+Q8 시간)')}.items():
    runs=[]
    for seed in [1,2,3,4,5]:
        rng=random.Random(seed); rows=[]
        for task in TASK:
            for _ in range(4000): rows.append(run(task,ORDERS[o],cues(VARIANTS[v]),P,rng,4,False,True))
        runs.append((st.mean(r['n'] for r in rows),st.mean(r['complete'] for r in rows),st.mean(r['custom'] for r in rows),st.mean(r['wasted'] for r in rows)))
    rep[name]=dict(avg_questions=[round(r[0],3) for r in runs],required_complete=[round(r[1],3) for r in runs],custom_needed=[round(r[2],3) for r in runs],wasted=[round(r[3],3) for r in runs])
    print(name,rep[name])
res['_required_only_5seeds']=rep
bt={}
for task in TASK:
    for name,(o,v) in {'3.0':('O0(3.0 번호순)','W0(3.0 문구)'),'3.1':('O1(목적→상황→관계…)','W2(+Q8 시간)')}.items():
        rng=random.Random(11); rows=[run(task,ORDERS[o],cues(VARIANTS[v]),P,rng,4,False,True) for _ in range(6000)]
        bt[f'{task}|{name}']=dict(avg_q=round(st.mean(r['n'] for r in rows),2),complete=round(st.mean(r['complete'] for r in rows),3),custom=round(st.mean(r['custom'] for r in rows),3))
res['_required_only_by_task']=bt; print(json.dumps(bt,ensure_ascii=False))
json.dump(res,open('e2_result.json','w'),ensure_ascii=False,indent=1)
