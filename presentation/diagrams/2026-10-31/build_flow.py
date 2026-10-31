"""Build a presentation diagram from the current service flow; no source data."""
from pathlib import Path
from html import escape

OUT = Path(__file__).resolve().parent
W, H = 1800, 1120
ink, muted, purple, line = '#252C43', '#69748A', '#7474D7', '#B0B4D7'
parts = [f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
<title id="title">말씨 서비스 흐름 관계도</title>
<desc id="desc">대화 입력과 원문 근거 준비, 상황 이해와 질문 조정, 맞춤 안내 생성과 검토 및 저장의 세 단계. 질문은 문맥에 따라 생략하며 원문에 없는 답변을 생성하지 않는다. 기관 안내는 별도 경로다.</desc>
<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L9 4.5 L0 9Z" fill="{line}"/></marker></defs>
<rect width="{W}" height="{H}" fill="#FFFFFF"/>
<g font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif">''']

def text(x, y, value, size=24, color=ink, weight=400, anchor='start'):
    parts.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}">{escape(value)}</text>')

def path(d, dash=False):
    parts.append(f'<path d="{d}" fill="none" stroke="{line}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)"'+(' stroke-dasharray="7 7"' if dash else '')+'/>')

def lane(num, title, y):
    parts.append(f'<rect x="64" y="{y-29}" width="44" height="36" rx="10" fill="{purple}"/>')
    text(86, y-3, num, 21, '#FFFFFF', 600, 'middle')
    text(125, y, title, 29, ink, 600)

def node(col, y, title, lines, strong=False):
    x=70+340*col
    if strong:
        parts.append(f'<rect x="{x}" y="{y}" width="280" height="142" rx="22" fill="{purple}"/>')
    title_color='#FFFFFF' if strong else ink
    body_color='#F2F1FF' if strong else muted
    text(x+140,y+45,title,27,title_color,600,'middle')
    for i,t in enumerate(lines):
        text(x+140,y+80+i*28,t,22,body_color,400,'middle')
    if col<4:
        path(f'M{x+294} {y+71} H{x+325}')

text(64,66,'말씨',38,purple,700)
text(160,66,'서비스 흐름 관계도',38,ink,600)
text(64,106,'가족·친구의 이야기에서 출발해, 원문에 근거한 대화와 행동을 준비합니다.',25,muted)
text(1736,64,'2026.10.31 · 현재 소스 기준',20,muted,400,'end')
parts.append('<path d="M64 134 H1736" stroke="#E7E8F1"/>')

lane('01','대화 입력·원문 근거 준비',184)
row1=[
 ('사용자 상황 입력',['대상자·관계·관찰 내용','이용자 감정·도움 목적'],False),
 ('입력 확인·저장',['선택·직접 입력 보존','모름·거절·미응답 구분'],False),
 ('원문 문서화',['사람·문항·출처 연결','현재 답변과 정정 반영'],False),
 ('대화 내 근거 검색',['단어·문자 조각 기반','최신·안전 관련 원문 포함'],True),
 ('단계별 근거 제공',['생성·검토 시 원문 대조','현재 대화의 답변 사용'],False),
]
for i,(t,ls,hi) in enumerate(row1):node(i,218,t,ls,hi)
path('M1570 367 V389 H40 V453 H210 V460')
text(900,381,'원문과 출처를 유지해 상황 이해에 전달',20,muted,400,'middle')

lane('02','상황 이해·질문 조정',435)
row2=[
 ('대화 맥락 해석',['대상자와 이용자 구분','이름·관계·목적 확인'],False),
 ('상태·관계 갱신',['원문 사실·잠정 해석 구분','미확인 정보는 따로 유지'],True),
 ('상태·안전 검토',['별도 모델 요청으로 검토','오류는 수정 후 재검토'],False),
 ('질문 선택·생략',['중복·불필요한 질문 조정','필요 시 후속 질문 제안'],True),
 ('다음 질문·대화 완료',['남은 질문은 입력 반복','대화 완료 시 안내 준비'],False),
]
for i,(t,ls,hi) in enumerate(row2):node(i,469,t,ls,hi)
text(1090,644,'생략한 문항의 답변을 만들거나 사실 근거로 사용하지 않음',20,muted,400,'middle')
path('M1570 617 V672 H40 V735 H210 V744')
text(1570,654,'완료',19,muted,400,'middle')

lane('03','맞춤 안내 생성·검토·저장',716)
row3=[
 ('관계 분석·대화 전략',['관계 분석 후 대화 방향 구성','각 단계 생성·독립 검토'],False),
 ('맞춤 안내 작성',['돌봄·대화문·실천·회피','다음 단계 안내 포함'],True),
 ('카드별 검토·수정',['원문·카드 역할·안전 확인','통과한 카드부터 부분 표시'],False),
 ('전체 검토·최종 검증',['품질·통합·저장 상세 검토','오류 시 수정·재검토'],False),
 ('결과 저장·다시 보기',['PostgreSQL에 최종 저장','세션별 조회·삭제'],True),
]
for i,(t,ls,hi) in enumerate(row3):node(i,750,t,ls,hi)
path('M890 897 V934 H550 V899',True)
text(720,925,'카드 반려 시 해당 항목 재작성',19,muted,400,'middle')
text(1550,931,'저장 완료 후 최종 완료 표시',20,muted,400,'middle')

parts.append('<path d="M64 973 H1736" stroke="#E7E8F1"/>')
text(64,1019,'별도 기관 안내',23,purple,600)
text(280,1019,'원문·안전 신호 확인',23,ink)
path('M526 1011 H575')
text(598,1019,'필요 시 독립 분류',23,ink)
path('M824 1011 H873')
text(896,1019,'조건에 맞는 도움 정보 표시',23,ink)
text(64,1080,'대화 원문은 세션별로 분리  ·  원문 근거 검증  ·  검토·검증을 통과한 최종 결과만 저장',21,muted)
parts.append('</g></svg>')
target=OUT/'malssi-service-flow.svg'
target.write_text('\n'.join(parts),encoding='utf-8')
print(target)
