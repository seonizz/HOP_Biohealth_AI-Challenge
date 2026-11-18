import json, hashlib, os, shutil, re
import os; APP=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..'))
SRC=f'{APP}/seeds/questionnaire-v3'; DST=f'{APP}/seeds/questionnaire-v3.1'
OLD='malssi-intake-3.0.0-rc1'; NEW='malssi-intake-3.1.0-rc1'
ORDER=['Q3-01','Q3-03','Q3-02','Q3-04','Q3-05','Q3-06','Q3-07','Q3-08','Q3-09']
TEXT={
 'Q3-03':'이번에 다루고 싶은 일은 누구와의 어떤 일인가요?',
 'Q3-04':'그 상황에서 상대가 실제로 한 말이나 행동은 무엇인가요?',
 'Q3-05':'이 일로 지금까지 본인이 상대에게 한 말이나 행동이 있나요? 있다면 상대는 어떻게 반응했나요?',
 'Q3-07':'이 일과 관련해 상대가 바란다고 했거나 하지 말아 달라고 한 것이 있나요?',
 'Q3-08':'앞으로 본인이 할 수 있는 일과 가능한 시간은 어느 정도인가요?',
 'Q3-09':'이번 일에서 본인이 하고 싶은 것은 무엇인가요?',
}
HELP={
 'Q3-03':"지금 다루고 싶은 장면부터 적어 주세요. 상대는 실명 대신 '친구', '어머니'처럼 관계로 적어 주시면 됩니다. 여러 일이면 나누어 적어도 됩니다. 언제의 일인지 아는 범위에서 적고, 앞으로의 일이나 가정이라면 그대로 밝혀 주세요.",
 'Q3-05':'실제로 한 말이나 행동과 그 뒤에 알게 된 상대의 반응을 나누어 적어 주세요. 아는 부분만 답해도 됩니다. 아직 아무것도 하지 않았거나 반응을 모르면 그대로 적어 주세요. 앞으로 하려는 일은 여기에 적지 않아도 됩니다.',
 'Q3-07':'상대가 직접 말했거나 메시지로 전한 바람과 거절을 적어 주세요. 다른 사람에게 전해 들었다면 그렇다고 적어 주세요. 말한 적이 없는 것과 본인이 모르는 것은 다릅니다. 추측으로 채우지 않아도 됩니다.',
 'Q3-08':'할 수 있는 방법을 고르고, 가능한 시간·횟수·범위를 아는 만큼 적어 주세요. 가능하다는 답은 하겠다는 약속이 아닙니다. 여력이 없다는 것도 답입니다.',
}
COLLECTS_ADD={'Q3-03':['relationship']}
os.makedirs(DST,exist_ok=True)
dump=lambda o,p: open(p,'w',encoding='utf-8').write(json.dumps(o,ensure_ascii=False,indent=2)+'\n')
def swap(o):
    if isinstance(o,dict): return {k:swap(v) for k,v in o.items()}
    if isinstance(o,list): return [swap(v) for v in o]
    return NEW if o==OLD else o
q=swap(json.load(open(f'{SRC}/questions.json')))
q['created_date']='2026-11-19'; q['default_priority']=ORDER; q['supersedes']=OLD
for item in q['questions']:
    i=item['id']
    if i in ORDER: item['order']=ORDER.index(i)+1
    if i in TEXT: item['text']=TEXT[i]
    if i in HELP: item['help']['text']=HELP[i]
    for c in COLLECTS_ADD.get(i,[]):
        if c not in item['collects']: item['collects'].append(c)
q['planning']['forward_only']=True
q['planning']['forward_only_rule']='once_a_later_priority_question_is_shown_earlier_unshown_questions_are_not_offered'
q['planning']['custom_followup']={
  'focus_owner':{'behavior':['Q3-04','Q3-05'],'emotion':['Q3-06'],'relationship':['Q3-02'],'support':['Q3-08'],'goal':['Q3-09']},
  'focus_blocked_when':'every_owner_question_already_shown',
  'reject_unspecific_questions':True}
dump(q,f'{DST}/questions.json')
t=swap(json.load(open(f'{SRC}/tasks.json'))); t['created_date']='2026-11-19'
if 'default_priority' in t: t['default_priority']=ORDER
for task in t['tasks']:
    if 'Q3-03' in task.get('question_needs',{}) and 'Q3-02' in task['allowed_question_ids'] and 'relationship' not in task['question_needs']['Q3-03']:
        task['question_needs']['Q3-03'].append('relationship')
    task['allowed_question_ids']=sorted(task['allowed_question_ids'],key=lambda x:(ORDER+['Q3-10']).index(x))
dump(t,f'{DST}/tasks.json')
p=swap(json.load(open(f'{SRC}/policy.json'))); p['question_progression']['base_order']=ORDER
dump(p,f'{DST}/policy.json')
c=swap(json.load(open(f'{SRC}/codebook.json'))); dump(c,f'{DST}/codebook.json')
b=swap(json.load(open(f'{SRC}/bundle.json'))); b['created_date']='2026-11-19'; b['supersedes']=OLD
for a in b['assets']:
    name=a['path'].split('/')[-1]
    if a['path'].startswith('active/'):
        raw=open(f'{DST}/{name}','rb').read(); a['bytes']=len(raw); a['sha256']=hashlib.sha256(raw).hexdigest()
    else: a['carried_from']=OLD
dump(b,f'{DST}/bundle.json')
# 앱 실행 행: 3.0 행을 보존하고 3.1 행 생성
rows=json.load(open(f'{APP}/seeds/questions.json'))
if not os.path.exists(f'{APP}/seeds/questions-v3.0.json'): shutil.copy(f'{APP}/seeds/questions.json',f'{APP}/seeds/questions-v3.0.json')
rows=json.load(open(f'{APP}/seeds/questions-v3.0.json'))
for r in rows:
    sid=r['definition']['source_id']  # sort_order는 3.0 그대로 둔다(앱은 목적→상황을 compact flow로 먼저 묻는다)
    if sid in TEXT: r['definition']['q']=TEXT[sid]
    if sid in HELP: r['definition']['help']=HELP[sid]
rows.sort(key=lambda r:r['sort_order'])
dump(rows,f'{APP}/seeds/questions.json')
# 마이그레이션
sql=f"""-- 질문셋 v3.1: 문구와 순서만 바꾼다. 이전 3.0 행은 보관하고, 저장된 대화 스냅샷은 건드리지 않는다.
INSERT INTO question_bank_archive(bundle_id, rows)
SELECT 'before-{NEW}', COALESCE(jsonb_agg(to_jsonb(q) ORDER BY sort_order,id), '[]'::jsonb)
FROM questions q
ON CONFLICT (bundle_id) DO NOTHING;
UPDATE questions SET enabled=FALSE, updated_at=CURRENT_TIMESTAMP WHERE enabled;
INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
SELECT id,kind,sort_order,enabled,subject,definition
FROM jsonb_to_recordset($v31${json.dumps(rows,ensure_ascii=False,indent=2)}$v31$::jsonb)
AS q(id TEXT,kind TEXT,sort_order INTEGER,enabled BOOLEAN,subject TEXT,definition JSONB)
ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind,sort_order=EXCLUDED.sort_order,
  enabled=EXCLUDED.enabled,subject=EXCLUDED.subject,definition=EXCLUDED.definition,updated_at=CURRENT_TIMESTAMP;
"""
open(f'{APP}/migrations/015_questionnaire_v3_1.sql','w',encoding='utf-8').write(sql)
print('ok'); [print(a['path'],a['bytes'],a['sha256'][:16]) for a in b['assets'] if a['path'].startswith('active/')]
