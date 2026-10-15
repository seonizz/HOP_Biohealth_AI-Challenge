"""Extract one observed dialogue and render the three presentation examples."""
from __future__ import annotations

from collections import Counter
import gzip
import json
from pathlib import Path
import sqlite3

from PIL import Image, ImageDraw, ImageFont


OUT = Path(__file__).resolve().parent
SOURCE = Path('/Users/chihun/Documents/ChatGPT/HOP_data')
DATA = SOURCE / 'deliverables/malssi_stage1_training_20261009/data/train.jsonl.gz'
DB = SOURCE / 'outputs/private/corpus.sqlite'
EXAMPLE_ID = 'sft_bb93fc1a5e5f2dd8c247b5c9ea8e017abac76dbdd845cd43a2ec2e0a3439ed3b'
FONT = '/System/Library/Fonts/AppleSDGothicNeo.ttc'


def extract():
    with gzip.open(DATA, 'rt', encoding='utf-8') as stream:
        for line_number, line in enumerate(stream, 1):
            record = json.loads(line)
            if record['id'] == EXAMPLE_ID:
                break
        else:
            raise ValueError('Observed training example not found')
    connection = sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    turns = [dict(row) for row in connection.execute(
        'SELECT utterance_id, ordinal, speaker, text FROM utterances '
        'WHERE conversation_id=? AND ordinal<=? ORDER BY ordinal',
        (record['source_conversation_id'], record['target_end_ordinal']),
    )]
    reconstructed = []
    for turn in turns:
        role = {'내담자': 'user', '상담사': 'assistant', '상담자': 'assistant'}[turn['speaker']]
        if reconstructed and reconstructed[-1]['role'] == role:
            reconstructed[-1]['content'] += '\n' + turn['text']
        else:
            reconstructed.append({'role': role, 'content': turn['text']})
    assert reconstructed == record['messages'][1:], 'Full original prefix differs'
    assert record['loss_message_mask'] == [0] * (len(record['messages']) - 1) + [1]
    assert record['target_origin'] == 'observed_counselor_utterance'
    previous = turns[-2]
    target = turns[-1]
    assert previous['speaker'] == '내담자'
    assert previous['text'] == record['messages'][-2]['content']
    assert target['text'] == record['messages'][-1]['content']
    sentences = []
    for row in connection.execute(
        'SELECT sentence_id, ordinal, text, start_char, end_char FROM sentences '
        'WHERE utterance_id=? ORDER BY start_char', (previous['utterance_id'],),
    ):
        sentence = dict(row)
        assert previous['text'][sentence['start_char']:sentence['end_char']] == sentence['text']
        sentence['words'] = [dict(word) for word in connection.execute(
            'SELECT surface, normalized, start_char, end_char FROM words '
            'WHERE sentence_id=? ORDER BY ordinal', (sentence['sentence_id'],),
        )]
        for word in sentence['words']:
            assert previous['text'][word['start_char']:word['end_char']] == word['surface']
        sentence['characters'] = len(sentence['text'])
        sentence['nonspace_characters'] = sum(not c.isspace() for c in sentence['text'])
        sentence['surface_word_count'] = len(sentence['words'])
        sentence['unique_surface_words'] = len({w['normalized'] for w in sentence['words']})
        sentences.append(sentence)
    connection.close()
    counts = Counter(w['normalized'] for s in sentences for w in s['words'])
    pair_count = 0
    for sentence in sentences:
        words = [w['normalized'] for w in sentence['words']]
        for i, left in enumerate(words):
            for right in words[i + 1:i + 3]:
                if {left, right} == {'불안', '좌절'}:
                    pair_count += 1
    assert [s['characters'] for s in sentences] == [7, 2, 21]
    assert [s['surface_word_count'] for s in sentences] == [2, 1, 7]
    assert counts['좌절'] == 2 and counts['불안'] == 1 and pair_count == 1
    evidence_path = OUT / 'numeric_evidence.json'
    evidence = json.loads(evidence_path.read_text()) if evidence_path.exists() else None
    assert evidence is not None, 'Stored numerical evidence is required'
    assert evidence['source_utterance_id'] == previous['utterance_id']
    for sentence, saved in zip(sentences, evidence['stored_sentence_statistics'], strict=True):
        assert sentence['sentence_id'] == saved['sentence_id']
        assert [sentence[k] for k in ['characters', 'nonspace_characters', 'surface_word_count', 'unique_surface_words']] == [saved[k] for k in ['characters', 'nonspace_characters', 'tokens', 'unique_tokens']]
    example = {
        'schema_version': 'malssi-three-stage-example-v1',
        'data_kind': 'observed_source_dialogue_excerpt',
        'source': {'sqlite_path': str(DB), 'training_path': str(DATA),
                   'training_jsonl_line': line_number, 'sft_id': EXAMPLE_ID,
                   'source_conversation_id': record['source_conversation_id'],
                   'split': record['split']},
        'stage_1': {'previous_counselor': turns[-3], 'client_turn': previous,
                    'next_counselor': target, 'sentences': sentences},
        'stage_2': {
            'scope': 'Only the displayed client turn; counts computed from observed source spans',
            'characters_including_spaces_and_punctuation': len(previous['text']),
            'sentence_count': len(sentences), 'surface_word_count': sum(counts.values()),
            'surface_word_frequencies': dict(counts),
            'word_method': 'unicode-letter-number-mark-v1; surface units, not Korean morphology or model tokens',
            'cooccurrence': {'terms': ['불안', '좌절'], 'count': pair_count,
                             'scope': 'displayed client turn', 'window': 2,
                             'definition': 'Within each sentence, count each unordered pair of word occurrences at distance <=2 once',
                             'origin': 'directly calculated from original word occurrences; not the fitted global matrix'},
            'stored_numeric_evidence': evidence,
        },
        'stage_3': {'display_is_excerpt': True,
                    'input_excerpt': record['messages'][-3:-1],
                    'target': record['messages'][-1],
                    'actual_full_input_message_count_including_system': len(record['messages']) - 1,
                    'actual_original_context_ordinals': [0, record['target_start_ordinal'] - 1],
                    'target_original_ordinal': record['target_start_ordinal'],
                    'loss_message_mask': record['loss_message_mask'],
                    'target_origin': record['target_origin'],
                    'note': 'Actual SFT uses the complete original prefix; the displayed excerpt alone is not the full training record.'},
        'verification': {'full_prefix_reconstruction_matches': True,
                         'source_sentence_and_word_spans_match': True,
                         'target_and_last_message_mask_match': True},
    }
    (OUT / 'example_data.json').write_text(json.dumps(example, ensure_ascii=False, indent=2) + '\n')
    return example


def font(size, bold=False):
    return ImageFont.truetype(FONT, size, index=6 if bold else 0)


def wrap(draw, value, face, width):
    lines = []
    for paragraph in value.split('\n'):
        line = ''
        for char in paragraph:
            candidate = line + char
            if line and draw.textlength(candidate, font=face) > width:
                if ' ' in line:
                    head, tail = line.rsplit(' ', 1)
                    lines.append(head)
                    line = tail + char
                else:
                    lines.append(line)
                    line = char
            else:
                line = candidate
        lines.append(line)
    return lines


def render(example):
    image = Image.new('RGB', (2400, 1500), '#FBFCF9')
    draw = ImageDraw.Draw(image)
    green, dark, muted = '#246447', '#172B25', '#64746B'
    draw.text((70, 60), '같은 실제 대화로 보는 데이터 처리 3단계', font=font(72, True), fill=dark)
    draw.text((74, 166), '원문 → 문장·단어 → 수치 / 이전 대화 → 다음 상담사 답변', font=font(42), fill=muted)
    card_y, card_h, card_w = 260, 1100, 730
    xs = [70, 835, 1600]
    headings = ['01  원문 정리', '02  특징 수치화', '03  학습 자료 구성']
    for x, heading in zip(xs, headings):
        draw.rounded_rectangle((x, card_y, x + card_w, card_y + card_h), 30, fill='white', outline='#CDDED0', width=3)
        draw.rounded_rectangle((x + 22, card_y + 22, x + card_w - 22, card_y + 138), 22, fill='#E4EDDA')
        draw.text((x + 52, card_y + 48), heading, font=font(52, True), fill=green)

    def block(x, y, text, size=40, bold=False, fill=dark, width=626, gap=13):
        face = font(size, bold)
        lines = wrap(draw, text, face, width)
        for line in lines:
            draw.text((x, y), line, font=face, fill=fill)
            y += size + gap
        return y

    x = xs[0] + 52
    y = block(x, 432, '내담자 원문', 35, True, green)
    y = block(x, y + 15, example['stage_1']['client_turn']['text'], 46)
    draw.line((x, y + 27, x + 626, y + 27), fill='#E2E8E0', width=3)
    y = block(x, y + 55, '문장 3개로 나누기', 38, True, green)
    for i, sentence in enumerate(example['stage_1']['sentences'], 1):
        y = block(x, y + 17, f"{i}. {sentence['text']}", 39)
    y = block(x, y + 35, '첫 문장의 단어', 35, True, green)
    y = block(x, y + 15, '[불안]   [좌절]', 49, True)
    block(x, 1200, '화자·순서·원문 위치를 함께 저장', 32, fill=muted)

    x = xs[1] + 52
    y = block(x, 432, '문장별 길이와 단어 수', 37, True, green)
    table_y = y + 23
    draw.rounded_rectangle((x - 10, table_y - 10, x + 636, table_y + 276), 14, fill='#F2F6EF')
    draw.text((x + 15, table_y + 8), '문장', font=font(37, True), fill=dark)
    draw.text((x + 275, table_y + 8), '글자 수', font=font(37, True), fill=dark)
    draw.text((x + 466, table_y + 8), '단어 수', font=font(37, True), fill=dark)
    for i, s in enumerate(example['stage_1']['sentences'], 1):
        row_y = table_y + 72 + (i - 1) * 65
        draw.text((x + 20, row_y), f'{i}번', font=font(40), fill=dark)
        draw.text((x + 326, row_y), str(s['characters']), font=font(44, True), fill=green)
        draw.text((x + 514, row_y), str(s['surface_word_count']), font=font(44, True), fill=green)
    y = block(x, table_y + 312, '발화 전체: 32자 / 단어 10개', 38, True)
    y = block(x, y + 24, '단어 등장 횟수', 35, True, green)
    y = block(x, y + 14, '좌절 2회 · 불안 1회\n불안하고 1회', 41)
    y = block(x, y + 25, '함께 나온 단어', 35, True, green)
    y = block(x, y + 14, '불안 ↔ 좌절 : 1쌍', 44, True)
    block(x, 1220, '같은 문장 안, 거리 2단어 이내\n이 발화에서 직접 계산한 값', 29, fill=muted)

    x = xs[2] + 52
    y = block(x, 432, '입력: 이전 대화의 마지막 부분', 35, True, green)
    input_text = '상담사: 불안하고.\n내담자: ' + example['stage_1']['client_turn']['text']
    y = block(x, y + 15, input_text, 39)
    draw.line((x, y + 23, x + 626, y + 23), fill='#E2E8E0', width=3)
    y = block(x, y + 51, '정답: 실제 다음 상담사 답변', 35, True, green)
    y = block(x, y + 17, example['stage_3']['target']['content'], 41)
    y = block(x, y + 30, '입력의 마스크 0\n마지막 답변의 마스크 1', 37, True)
    block(x, 1210, '표시는 발췌. 실제 입력은 이전 대화\n전체 53메시지(system 포함).', 29, fill=muted)

    draw.text((74, 1400), '원본·학습 JSONL 대조 완료  |  글자 수는 공백·문장부호 포함  |  단어는 표면 단위  |  수치는 분석용', font=font(30), fill=muted)
    image.save(OUT / 'three_stage_examples.png')
    for i, (x, name) in enumerate(zip(xs, ['01_원문정리.png', '02_특징수치화.png', '03_학습자료구성.png']), 1):
        image.crop((x, card_y, x + card_w, card_y + card_h)).save(OUT / name)
    return {'image': str(OUT / 'three_stage_examples.png'), 'size': list(image.size)}


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    result = extract()
    print(json.dumps({'sft_line': result['source']['training_jsonl_line'],
                      'counts': {key: result['stage_2'][key] for key in ['characters_including_spaces_and_punctuation', 'sentence_count', 'surface_word_count']},
                      'verification': result['verification'],
                      **render(result)}, ensure_ascii=False))
