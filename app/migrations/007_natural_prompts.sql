-- Neutral prompts for new conversations only. Preserve customized rows and all
-- encrypted intake snapshots, answers, records and state history.
WITH defaults AS (
  SELECT * FROM jsonb_to_recordset($natural_prompts$[
  {
    "id": "want",
    "sort_order": 200,
    "subject": "user_goal",
    "before": {
      "required": true,
      "sec": "전하고 싶은 말",
      "face": "thanks",
      "intro": "먼저 {name}에게 건네고 싶은 마음부터 여쭤볼게요. 그 마음이 잘 닿도록 필요한 이야기를 이어서 함께 살펴볼게요.",
      "q": "{name}에게 꼭 전하고 싶은 말이 있다면 무엇인가요?",
      "why": "당신의 진심을 그분이 받아들이기 쉬운 말로 옮겨 드릴게요.",
      "type": "text",
      "ph": "예: 네 편이라는 것, 병원에 같이 가 보자는 것"
    },
    "after": {
      "required": true,
      "sec": "전하고 싶은 말",
      "face": "thanks",
      "intro": "먼저 {name}에게 건네고 싶은 마음부터 여쭤볼게요. 그 마음이 잘 닿도록 필요한 이야기를 이어서 함께 살펴볼게요.",
      "q": "{name}에게 꼭 전하고 싶은 말이 있다면 무엇인가요?",
      "why": "당신의 진심을 그분이 받아들이기 쉬운 말로 옮겨 드릴게요.",
      "type": "text",
      "ph": "예: 요즘 어떻게 지내는지 궁금해, 편할 때 이야기해 줘"
    }
  },
  {
    "id": "others_why",
    "sort_order": 1300,
    "subject": "patient",
    "before": {
      "sec": "어려움의 원인과 생활환경",
      "face": "hear",
      "q": "가족이나 주변 사람들은 {name:이} 왜 힘들어한다고 이야기하나요?",
      "type": "text",
      "cue": true,
      "ph": "예: 승진에서 떨어지고 나서부터라고들 해요",
      "ph_by_option": {
        "question_id": "events",
        "values": {
          "breakup": "예: 헤어지고 나서 많이 무너졌다고들 해요",
          "bereavement": "예: 할머니가 돌아가신 뒤로 기운이 없다고들 해요",
          "job_school_loss": "예: 회사를 그만두고 나서 자신감을 잃었다고 해요",
          "financial_difficulty": "예: 빚 걱정 때문에 잠을 못 잔다고들 해요",
          "environment_change": "예: 이사 온 뒤로 아는 사람이 없어 외로워한대요",
          "illness": "예: 몸이 아프고 나서 마음까지 지쳤다고들 해요",
          "academic_work_stress": "예: 승진에서 떨어지고 나서부터라고들 해요",
          "interpersonal_conflict": "예: 친한 친구와 크게 다툰 뒤로 힘들어한대요"
        }
      }
    },
    "after": {
      "sec": "어려움의 원인과 생활환경",
      "face": "hear",
      "q": "가족이나 주변 사람들은 요즘 {name}의 모습을 어떻게 이야기하나요?",
      "type": "text",
      "cue": true,
      "ph": "예: 승진에서 떨어지고 나서부터라고들 해요",
      "ph_by_option": {
        "question_id": "events",
        "values": {
          "breakup": "예: 헤어지고 나서 많이 무너졌다고들 해요",
          "bereavement": "예: 할머니가 돌아가신 뒤로 기운이 없다고들 해요",
          "job_school_loss": "예: 회사를 그만두고 나서 자신감을 잃었다고 해요",
          "financial_difficulty": "예: 빚 걱정 때문에 잠을 못 잔다고들 해요",
          "environment_change": "예: 이사 온 뒤로 아는 사람이 없어 외로워한대요",
          "illness": "예: 몸이 아프고 나서 마음까지 지쳤다고들 해요",
          "academic_work_stress": "예: 승진에서 떨어지고 나서부터라고들 해요",
          "interpersonal_conflict": "예: 친한 친구와 크게 다툰 뒤로 힘들어한대요"
        }
      }
    }
  },
  {
    "id": "burden",
    "sort_order": 1500,
    "subject": "patient",
    "before": {
      "sec": "어려움의 원인과 생활환경",
      "face": "think",
      "q": "반대로, {name:을} 더 힘들게 하거나 회복을 어렵게 하는 생활 속 부담이 있을까요?",
      "type": "one",
      "noOwn": true,
      "noSkip": true,
      "opts": [
        [
          "네",
          {
            "input": true,
            "ask": "어떤 부담인가요?",
            "ph": "예: 빚 문제, 야근이 많은 회사",
            "r": "life_burden"
          }
        ],
        "아니요"
      ]
    },
    "after": {
      "sec": "어려움의 원인과 생활환경",
      "face": "think",
      "q": "요즘 {name}의 일상에서 신경 쓰이거나 부담이 되는 일이 있을까요?",
      "type": "one",
      "noOwn": true,
      "noSkip": true,
      "opts": [
        [
          "네",
          {
            "input": true,
            "ask": "어떤 부담인가요?",
            "ph": "예: 빚 문제, 야근이 많은 회사",
            "r": "life_burden"
          }
        ],
        "아니요"
      ]
    }
  },
  {
    "id": "need",
    "sort_order": 2200,
    "subject": "patient",
    "before": {
      "required": true,
      "sec": "현재 필요한 도움",
      "face": "think",
      "q": "현재 {name}에게 가장 필요하다고 생각하는 도움은 무엇인가요?",
      "type": "text",
      "ph": "예: 전문가 상담, 푹 쉴 수 있는 시간"
    },
    "after": {
      "required": true,
      "sec": "현재 필요한 도움",
      "face": "think",
      "q": "현재 {name}에게 가장 필요하다고 생각하는 도움은 무엇인가요?",
      "type": "text",
      "ph": "예: 푹 쉴 시간, 이야기를 나눌 사람"
    }
  },
  {
    "id": "others_help",
    "sort_order": 2300,
    "subject": "patient",
    "before": {
      "sec": "현재 필요한 도움",
      "face": "hear",
      "q": "가족이나 주변 사람들은 {name}에게 어떤 도움을 권하고 있나요?",
      "type": "text",
      "ph": "예: 병원에 가 보라고 해요"
    },
    "after": {
      "sec": "현재 필요한 도움",
      "face": "hear",
      "q": "가족이나 주변 사람들은 {name}에게 어떤 도움을 권하고 있나요?",
      "type": "text",
      "ph": "예: 함께 산책하거나 이야기를 들어 주겠다고 해요"
    }
  }
]$natural_prompts$::jsonb)
    AS d(id text, sort_order integer, subject text, before jsonb, after jsonb)
)
UPDATE questions q SET definition=d.after, updated_at=CURRENT_TIMESTAMP
FROM defaults d
WHERE q.id=d.id AND q.kind='base' AND q.sort_order=d.sort_order
  AND q.subject=d.subject AND q.enabled=TRUE AND q.definition=d.before;
