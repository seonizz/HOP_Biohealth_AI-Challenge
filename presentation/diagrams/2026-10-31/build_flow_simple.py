"""Build the concise presentation version of the service diagram."""
from pathlib import Path
from html import escape

OUT = Path(__file__).resolve().parent
parts = ['''<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-labelledby="title desc">
<title id="title">말씨 핵심 서비스 흐름</title>
<desc id="desc">상황 입력, 맥락 이해, 맞춤 안내, 검토와 저장의 네 단계. 답변에 따라 질문을 조정하고 대화 원문을 근거로 대화문과 실천 및 돌봄 안내를 만든다. 검토에서 문제가 있으면 수정한다.</desc>
<defs><marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L12 6 L0 12Z" fill="#AAAAD0"/></marker></defs>
<rect width="1600" height="900" fill="#FFFFFF"/>
<g font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif">''']

def text(x,y,label,size=28,color='#252C43',weight=400,anchor='start'):
    parts.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}">{escape(label)}</text>')

text(70,88,'말씨',38,'#7474D7',700)
text(170,88,'서비스 핵심 흐름',27,'#6A7187')
text(70,177,'걱정되는 상황에서, 건넬 말과 행동까지',49,'#252C43',600)

steps = [
    ('01','상황 입력',['관계·관찰·고민 입력']),
    ('02','맥락 이해',['답변에 맞춰 질문 조정','대화 원문에서 근거 확인']),
    ('03','맞춤 안내',['대화문·실천·돌봄 제안']),
    ('04','검토·저장',['원문 근거·안전 검토','결과 저장·다시 보기']),
]
for i,(num,title,lines) in enumerate(steps):
    x=60+390*i
    strong=i==2
    if strong:
        parts.append(f'<rect x="{x}" y="300" width="310" height="248" rx="26" fill="#7474D7"/>')
    elif i==1:
        parts.append(f'<rect x="{x}" y="300" width="310" height="248" rx="26" fill="#F1F0FC"/>')
    text(x+155,347,num,25,'#E7E6FF' if strong else '#7474D7',500,'middle')
    text(x+155,401,title,37,'#FFFFFF' if strong else '#252C43',600,'middle')
    for j,label in enumerate(lines):
        text(x+155,456+j*40,label,25,'#F4F3FF' if strong else '#687189',400,'middle')
    if i<3:
        parts.append(f'<path d="M{x+328} 423 H{x+372}" stroke="#AAAAD0" stroke-width="3" fill="none" marker-end="url(#arrow)"/>')

parts.append('<path d="M1385 560 V602 H995 V560" stroke="#AAAAD0" stroke-width="2" stroke-dasharray="7 7" fill="none" marker-end="url(#arrow)"/>')
text(1190,637,'검토에서 문제가 있으면 수정',23,'#6A7187',400,'middle')
parts.append('<path d="M70 701 H1530" stroke="#E5E5EF" stroke-width="1.5"/>')
text(800,773,'무슨 말을 할지 · 어떻게 도울지 · 나를 어떻게 돌볼지',32,'#252C43',500,'middle')
text(1530,854,'2026.10.31 · 현재 구현 기준',20,'#83889A',400,'end')
parts.append('</g></svg>')
target=OUT/'malssi-service-flow-simple.svg'
target.write_text('\n'.join(parts),encoding='utf-8')
print(target)
