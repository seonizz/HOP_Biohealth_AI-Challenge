-- Apply the latest frontend's required name prompt only to the untouched default.
-- Existing intake snapshots and administrator-customized questions stay unchanged.
UPDATE questions
SET definition = jsonb_set(definition - 'follow_up', '{required}', 'true'::jsonb),
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'name'
  AND kind = 'base'
  AND sort_order = 100
  AND enabled = TRUE
  AND subject = 'patient'
  AND definition = $default_name${
    "sec": "시작",
    "face": "hello",
    "q": "오늘 이야기할 분을 어떻게 부르면 될까요?\n이름이나 별명, 호칭 무엇이든 괜찮아요.",
    "why": "기록의 제목으로 쓰여요.",
    "type": "text",
    "ph": "예: 엄마, 친구 지수",
    "short": true,
    "follow_up": {
      "when": { "rule": "thin_text", "min": 1 },
      "merge": "name",
      "question": {
        "type": "text",
        "q": "부르기 편한 호칭 하나만 정해 주세요. \"친구\", \"동생\"처럼 적어도 괜찮아요.",
        "ph": "예: 동생",
        "short": true
      }
    }
  }$default_name$::jsonb;
