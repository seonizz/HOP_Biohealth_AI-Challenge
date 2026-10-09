-- Latest frontend e811e87: update untouched defaults only.
-- Existing intake snapshots and customized question definitions/settings stay unchanged.
WITH defaults AS (
  SELECT * FROM jsonb_to_recordset($frontend_defaults$[
  {
    "id": "events",
    "sort_order": 1200,
    "subject": "patient",
    "before": {
      "sec": "어려움의 원인과 생활환경",
      "face": "ponder",
      "q": "최근 1년 사이 {name}에게 있었던 일을 모두 골라 주세요.",
      "type": "multi",
      "opts": [
        [
          "이별·이혼",
          {
            "r": "breakup"
          }
        ],
        [
          "가까운 사람과의 사별",
          {
            "r": "bereavement"
          }
        ],
        [
          "실직·퇴사·휴학",
          {
            "r": "job_school_loss"
          }
        ],
        [
          "경제적 어려움",
          {
            "r": "financial_difficulty"
          }
        ],
        [
          "이사·환경 변화",
          {
            "r": "environment_change"
          }
        ],
        [
          "본인 또는 가족의 질병",
          {
            "r": "illness"
          }
        ],
        [
          "학업·업무 스트레스",
          {
            "r": "academic_work_stress"
          }
        ],
        [
          "대인관계 갈등",
          {
            "r": "interpersonal_conflict"
          }
        ],
        [
          "없어요",
          {
            "none": 1
          }
        ]
      ],
      "when": {
        "selected": {
          "question_id": "cause",
          "option": "네"
        }
      }
    },
    "after": {
      "sec": "어려움의 원인과 생활환경",
      "face": "ponder",
      "fu": true,
      "q": "어떤 일이 있었나요?\n최근 1년 사이 {name}에게 있었던 일을 모두 골라 주세요.",
      "type": "multi",
      "opts": [
        [
          "이별·이혼",
          {
            "r": "breakup"
          }
        ],
        [
          "가까운 사람과의 사별",
          {
            "r": "bereavement"
          }
        ],
        [
          "실직·퇴사·휴학",
          {
            "r": "job_school_loss"
          }
        ],
        [
          "경제적 어려움",
          {
            "r": "financial_difficulty"
          }
        ],
        [
          "이사·환경 변화",
          {
            "r": "environment_change"
          }
        ],
        [
          "본인 또는 가족의 질병",
          {
            "r": "illness"
          }
        ],
        [
          "학업·업무 스트레스",
          {
            "r": "academic_work_stress"
          }
        ],
        [
          "대인관계 갈등",
          {
            "r": "interpersonal_conflict"
          }
        ],
        [
          "없어요",
          {
            "none": 1
          }
        ]
      ],
      "when": {
        "selected": {
          "question_id": "cause",
          "option": "네"
        }
      }
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
      "ph": "예: 승진에서 떨어지고 나서부터라고들 해요"
    },
    "after": {
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
    }
  },
  {
    "id": "support",
    "sort_order": 1400,
    "subject": "patient",
    "before": {
      "sec": "어려움의 원인과 생활환경",
      "face": "joy",
      "q": "{name}에게 힘이 되어 주는 사람, 관계, 활동이 있나요?",
      "type": "one",
      "noOwn": true,
      "noSkip": true,
      "opts": [
        [
          "네",
          {
            "input": true,
            "ph": "예: 교회 친구들, 강아지 산책",
            "p": "social_support"
          }
        ],
        [
          "아니요",
          {
            "r": "lack_of_support"
          }
        ]
      ]
    },
    "after": {
      "sec": "어려움의 원인과 생활환경",
      "face": "joy",
      "q": "{name}에게 힘이 되어 주는 사람, 관계, 활동이 있나요?",
      "type": "one",
      "noOwn": true,
      "noSkip": true,
      "opts": [
        [
          "네",
          {
            "input": true,
            "ask": "어떤 사람이나 관계, 활동인가요?",
            "ph": "예: 교회 친구들, 강아지 산책",
            "p": "social_support"
          }
        ],
        [
          "아니요",
          {
            "r": "lack_of_support"
          }
        ]
      ]
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
    }
  },
  {
    "id": "extra",
    "sort_order": 1800,
    "subject": "patient",
    "before": {
      "sec": "{name:의} 생활 배경과 가치관",
      "face": "empathy",
      "q": "{name:와} 관련해서 따로 걱정되는 부분이 있다면 들려주세요.",
      "type": "text",
      "cue": true,
      "ph": "없으면 \"없어요\"라고 적어도 괜찮아요"
    },
    "after": {
      "sec": "{name:의} 생활 배경과 가치관",
      "face": "empathy",
      "q": "{name:와} 관련해서 추가적으로 걱정되는 부분이 있다면 들려주세요.",
      "type": "text",
      "cue": true,
      "ph": "예: 요즘 술 마시는 날이 부쩍 늘어서 걱정돼요"
    }
  },
  {
    "id": "help",
    "sort_order": 2000,
    "subject": "patient",
    "before": {
      "sec": "지금까지의 대처와 도움",
      "face": "listen",
      "q": "{name:이} 지금까지 받아 본 도움을 모두 골라 주세요.",
      "type": "multi",
      "opts": [
        [
          "정신건강의학과 진료",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "약물 치료",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "심리상담",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "정신건강복지센터·중독관리센터",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "학교·직장 상담",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "종교 기관",
          {
            "t": "help_religion"
          }
        ],
        [
          "가족·친구의 도움",
          {
            "p": "social_support"
          }
        ],
        [
          "아직 받은 적 없어요",
          {
            "none": 1,
            "t": "help_none"
          }
        ],
        [
          "잘 모르겠어요",
          {
            "none": 1
          }
        ]
      ]
    },
    "after": {
      "sec": "지금까지의 대처와 도움",
      "face": "listen",
      "q": "{name:은} 지금까지 어려움을 견디거나 해결하려고 어떤 방법을 써 왔나요?\n받아 본 도움을 모두 고르고, 그 밖에 해 온 방법이 있다면 적어 주세요.",
      "type": "multi",
      "cue": true,
      "ownPh": "예: 술을 마시거나, 친구를 만나 이야기해요",
      "opts": [
        [
          "정신건강의학과 진료",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "약물 치료",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "심리상담",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "정신건강복지센터·중독관리센터",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "학교·직장 상담",
          {
            "p": "accepting_attitude",
            "t": "help_treat"
          }
        ],
        [
          "종교 기관",
          {
            "t": "help_religion"
          }
        ],
        [
          "가족·친구의 도움",
          {
            "p": "social_support"
          }
        ],
        [
          "아직 받은 적 없어요",
          {
            "none": 1,
            "t": "help_none"
          }
        ],
        [
          "잘 모르겠어요",
          {
            "none": 1
          }
        ]
      ]
    }
  },
  {
    "id": "moment",
    "sort_order": 2400,
    "subject": "supporter",
    "before": {
      "required": true,
      "sec": "당신의 마음",
      "face": "empathy",
      "intro": "이제 당신에 대해 여쭤볼게요. 누군가를 곁에서 돕는 일은 생각보다 많이 지치는 일이에요.",
      "q": "요즘 {name:의} 일로 가장 마음이 쓰이거나 힘들었던 순간은 언제였나요?",
      "type": "text",
      "ph": "예: 새벽까지 연락이 안 됐을 때"
    },
    "after": {
      "required": true,
      "sec": "당신의 마음",
      "face": "empathy",
      "intro": "이제 당신에 대해 여쭤볼게요. 누군가를 곁에서 돕는 일은 생각보다 많이 지치는 일이에요.",
      "q": "요즘 당신이 가장 마음 쓰였거나 힘들었던 순간은 언제였나요?",
      "type": "text",
      "ph": "예: 새벽까지 연락이 안 됐을 때"
    }
  },
  {
    "id": "cgchange_more",
    "sort_order": 2800,
    "subject": "supporter",
    "before": {
      "sec": "당신의 마음",
      "face": "hear",
      "q": "위의 변화에 대해 더 들려주고 싶은 게 있다면 적어 주세요.",
      "type": "one",
      "noOwn": true,
      "noSkip": true,
      "opts": [
        [
          "네",
          {
            "input": true,
            "ph": "예: 저도 요즘 출근이 힘들어요"
          }
        ],
        "없어요"
      ],
      "when": {
        "any": [
          {
            "tag_prefix": "cg_"
          },
          {
            "custom": "cgchange"
          }
        ]
      }
    },
    "after": {
      "sec": "당신의 마음",
      "face": "hear",
      "q": "위의 변화에 대해 더 들려주고 싶은 게 있다면 적어 주세요.",
      "type": "text",
      "ph": "예: 저도 요즘 출근이 힘들어요",
      "when": {
        "any": [
          {
            "tag_prefix": "cg_"
          },
          {
            "custom": "cgchange"
          }
        ]
      }
    }
  }
]$frontend_defaults$::jsonb)
    AS d(id TEXT, sort_order INTEGER, subject TEXT, before JSONB, after JSONB)
)
UPDATE questions AS q
SET definition = d.after, updated_at = CURRENT_TIMESTAMP
FROM defaults AS d
WHERE q.id = d.id AND q.kind = 'base' AND q.enabled = TRUE
  AND q.sort_order = d.sort_order AND q.subject = d.subject AND q.definition = d.before;

-- Retain coping if help was customized instead of being merged by this migration.
UPDATE questions
SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE id = 'coping' AND kind = 'base' AND enabled = TRUE
  AND sort_order = 1900 AND subject = 'patient'
  AND definition = $default_coping${
  "sec": "지금까지의 대처와 도움",
  "face": "listen",
  "q": "{name:은} 현재의 어려움을 해결하거나 견디기 위해 어떤 방법을 사용해 왔나요?",
  "type": "text",
  "cue": true,
  "ph": "예: 술을 마시거나, 친구를 만나 이야기해요"
}$default_coping$::jsonb
  AND EXISTS (SELECT 1 FROM questions WHERE id = 'help' AND kind = 'base' AND enabled = TRUE
    AND sort_order = 2000 AND subject = 'patient'
    AND definition = $merged_help${
  "sec": "지금까지의 대처와 도움",
  "face": "listen",
  "q": "{name:은} 지금까지 어려움을 견디거나 해결하려고 어떤 방법을 써 왔나요?\n받아 본 도움을 모두 고르고, 그 밖에 해 온 방법이 있다면 적어 주세요.",
  "type": "multi",
  "cue": true,
  "ownPh": "예: 술을 마시거나, 친구를 만나 이야기해요",
  "opts": [
    [
      "정신건강의학과 진료",
      {
        "p": "accepting_attitude",
        "t": "help_treat"
      }
    ],
    [
      "약물 치료",
      {
        "p": "accepting_attitude",
        "t": "help_treat"
      }
    ],
    [
      "심리상담",
      {
        "p": "accepting_attitude",
        "t": "help_treat"
      }
    ],
    [
      "정신건강복지센터·중독관리센터",
      {
        "p": "accepting_attitude",
        "t": "help_treat"
      }
    ],
    [
      "학교·직장 상담",
      {
        "p": "accepting_attitude",
        "t": "help_treat"
      }
    ],
    [
      "종교 기관",
      {
        "t": "help_religion"
      }
    ],
    [
      "가족·친구의 도움",
      {
        "p": "social_support"
      }
    ],
    [
      "아직 받은 적 없어요",
      {
        "none": 1,
        "t": "help_none"
      }
    ],
    [
      "잘 모르겠어요",
      {
        "none": 1
      }
    ]
  ]
}$merged_help$::jsonb);
