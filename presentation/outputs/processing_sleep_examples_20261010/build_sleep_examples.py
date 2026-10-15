from __future__ import annotations

import ast
from collections import Counter
import gzip
import json
from pathlib import Path
import runpy
import sqlite3
import struct

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SOURCE = Path('/Users/chihun/Documents/ChatGPT/HOP_data')
DATA = SOURCE / 'deliverables/malssi_stage1_training_20261009/data/train.jsonl.gz'
NUMERIC = SOURCE / 'outputs/private/numeric'
EXAMPLE_ID = 'sft_6a520c1157977c0bd6be556f69ba0025eb2f3aa1fc05b1f55fb92526ff20f98d'
HELPERS = runpy.run_path(str(OUT.parent / 'processing_examples_20261010/build_examples.py'))
font, wrap = HELPERS['font'], HELPERS['wrap']


def extract():
    with gzip.open(DATA, 'rt', encoding='utf-8') as stream:
        for line_number, line in enumerate(stream, 1):
            record = json.loads(line)
            if record['id'] == EXAMPLE_ID:
                break
        else:
            raise ValueError('Example not found')
    db = SOURCE / 'outputs/private/corpus.sqlite'
    connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
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
    assert reconstructed == record['messages'][1:]
    assert record['loss_message_mask'] == [0] * (len(record['messages']) - 1) + [1]
    assert record['target_origin'] == 'observed_counselor_utterance'
    client, target = turns[-2:]
    assert client['text'] == record['messages'][-2]['content']
    assert target['text'] == record['messages'][-1]['content']
    sentences = []
    for row in connection.execute(
        'SELECT sentence_id, ordinal, text, start_char, end_char FROM sentences '
        'WHERE utterance_id=? ORDER BY start_char', (client['utterance_id'],),
    ):
        sentence = dict(row)
        assert client['text'][sentence['start_char']:sentence['end_char']] == sentence['text']
        sentence['words'] = [dict(word) for word in connection.execute(
            'SELECT surface, normalized, start_char, end_char FROM words '
            'WHERE sentence_id=? ORDER BY ordinal', (sentence['sentence_id'],),
        )]
        for word in sentence['words']:
            assert client['text'][word['start_char']:word['end_char']] == word['surface']
        sentence['characters'] = len(sentence['text'])
        sentence['nonspace_characters'] = sum(not ch.isspace() for ch in sentence['text'])
        sentence['tokens'] = len(sentence['words'])
        sentence['unique_tokens'] = len({w['normalized'] for w in sentence['words']})
        sentences.append(sentence)
    connection.close()
    missing = {s['sentence_id'] for s in sentences}
    mappings = {}
    with (NUMERIC / 'sentence_rows.jsonl').open() as stream:
        for mapping_line, line in enumerate(stream, 1):
            row = json.loads(line)
            if row['id'] in missing:
                mappings[row['id']] = {**row, 'mapping_line': mapping_line}
                missing.remove(row['id'])
                if not missing:
                    break
    assert not missing
    with (NUMERIC / 'sentence_statistics.npy').open('rb') as stream:
        assert stream.read(6) == b'\x93NUMPY'
        version = tuple(stream.read(2))
        fmt = '<H' if version == (1, 0) else '<I'
        header_length = struct.unpack(fmt, stream.read(struct.calcsize(fmt)))[0]
        header = ast.literal_eval(stream.read(header_length).decode('latin1'))
        assert header['descr'] == '<f4' and not header['fortran_order']
        offset, width = stream.tell(), header['shape'][1]
        for sentence in sentences:
            mapping = mappings[sentence['sentence_id']]
            assert mapping['split'] == record['split']
            stream.seek(offset + mapping['row'] * width * 4)
            saved = list(struct.unpack('<4f', stream.read(16)))
            assert saved == [sentence[k] for k in ['characters', 'nonspace_characters', 'tokens', 'unique_tokens']]
            sentence['numeric_row'] = mapping['row']
            sentence['mapping_line'] = mapping['mapping_line']
            sentence['stored_statistics'] = saved
    counts = Counter(w['normalized'] for s in sentences for w in s['words'])
    pairs = []
    for sentence in sentences:
        words = [w['normalized'] for w in sentence['words']]
        pairs.append([{'left': left, 'right': right, 'distance': distance}
                      for i, left in enumerate(words)
                      for distance, right in enumerate(words[i + 1:i + 3], 1)])
    assert [s['characters'] for s in sentences] == [20, 24, 22]
    assert [s['tokens'] for s in sentences] == [7, 7, 5]
    result = {
        'data_kind': 'observed_source_dialogue_excerpt',
        'source': {'sqlite_path': str(db), 'training_path': str(DATA),
                   'training_jsonl_line': line_number, 'sft_id': EXAMPLE_ID,
                   'source_conversation_id': record['source_conversation_id'],
                   'split': record['split'], 'numeric_directory': str(NUMERIC)},
        'client_turn': client, 'previous_counselor': turns[-3], 'target': target,
        'sentences': sentences,
        'direct_statistics': {'characters': len(client['text']), 'sentences': len(sentences),
                              'surface_words': sum(counts.values()), 'frequencies': dict(counts)},
        'local_cooccurrences_by_sentence': pairs,
        'cooccurrence_definition': 'Original word occurrences within the same sentence, distance <=2; directly counted, not fitted global matrix values',
        'training': {'full_input_messages_including_system': len(record['messages']) - 1,
                     'context_original_ordinals': [0, record['target_start_ordinal'] - 1],
                     'target_original_ordinal': record['target_start_ordinal'],
                     'loss_message_mask': record['loss_message_mask'],
                     'target_origin': record['target_origin'], 'display_is_excerpt': True},
        'verification': {'full_prefix_matches': True, 'source_spans_match': True,
                         'stored_npy_statistics_match': True, 'target_mask_matches': True},
    }
    (OUT / 'example_data.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


def render(data):
    image = Image.new('RGB', (2400, 1600), '#FBFCF9')
    draw = ImageDraw.Draw(image)
    green, dark, muted = '#246447', '#172B25', '#64746B'
    draw.text((70, 60), '잠과 생각에 관한 실제 대화의 데이터 처리', font=font(68, True), fill=dark)
    draw.text((74, 166), '원문을 나누고, 특징을 세고, 다음 상담사 답변과 연결하기', font=font(42), fill=muted)
    xs, y0, height, width = [70, 835, 1600], 260, 1190, 730
    for x, title in zip(xs, ['01  원문 정리', '02  특징 수치화', '03  학습 자료 구성']):
        draw.rounded_rectangle((x, y0, x + width, y0 + height), 30, fill='white', outline='#CDDED0', width=3)
        draw.rounded_rectangle((x + 22, y0 + 22, x + width - 22, y0 + 138), 22, fill='#E4EDDA')
        draw.text((x + 52, y0 + 48), title, font=font(52, True), fill=green)

    def block(x, y, text, size=36, bold=False, color=dark, max_width=626):
        lines = wrap(draw, text, font(size, bold), max_width)
        for line in lines:
            draw.text((x, y), line, font=font(size, bold), fill=color)
            y += size + 12
        return y

    x = xs[0] + 52
    y = block(x, 432, '내담자 원문', 35, True, green)
    y = block(x, y + 12, data['client_turn']['text'], 39)
    draw.line((x, y + 20, x + 626, y + 20), fill='#E2E8E0', width=3)
    y = block(x, y + 48, '문장 3개로 분리', 36, True, green)
    for i, sentence in enumerate(data['sentences'], 1):
        y = block(x, y + 16, f"{i}. {sentence['text']}", 36)
    y = block(x, y + 23, '2번 문장의 단어', 35, True, green)
    y = block(x, y + 12, '[잠을] [못] [자겠는] [거예요]\n[생각이] [계속] [나서]', 34, True)
    assert y < 1350
    block(x, 1370, '화자·순서·원문 위치를 함께 보존', 29, color=muted)

    x = xs[1] + 52
    y = block(x, 432, '문장 길이 · 공백/문장부호 포함', 34, True, green)
    chart_y = y + 30
    for i, sentence in enumerate(data['sentences'], 1):
        yy = chart_y + (i - 1) * 138
        draw.text((x, yy), f'{i}번 문장', font=font(35), fill=dark)
        draw.text((x + 394, yy), f"{sentence['characters']}자 · {sentence['tokens']}단어", font=font(35, True), fill=dark)
        draw.rounded_rectangle((x, yy + 55, x + 626, yy + 99), 12, fill='#EEF3EA')
        bar_width = 626 * sentence['characters'] / max(s['characters'] for s in data['sentences'])
        draw.rounded_rectangle((x, yy + 55, x + bar_width, yy + 99), 12, fill=green if i == 2 else '#9FBEA4')
    y = block(x, chart_y + 438, '발화 전체 68자 · 19단어', 38, True)
    y = block(x, y + 35, '함께 나타난 단어 · 2번 문장', 35, True, green)
    for left, right in [('잠을', '못'), ('생각이', '계속'), ('계속', '나서')]:
        pair_count = sum({p['left'], p['right']} == {left, right} for p in data['local_cooccurrences_by_sentence'][1])
        assert pair_count == 1
        y = block(x, y + 18, f'{left} ↔ {right}     {pair_count}쌍', 42, True)
    block(x, 1320, '같은 문장 안에서 거리 2단어 이내\n이 발화의 표면 단어를 직접 계수', 29, color=muted)

    x = xs[2] + 52
    y = block(x, 432, '입력: 앞선 대화 + 내담자 발화', 34, True, green)
    y = block(x, y + 15, data['client_turn']['text'], 39)
    draw.line((x, y + 23, x + 626, y + 23), fill='#E2E8E0', width=3)
    y = block(x, y + 52, '정답: 원본의 다음 상담사 답변', 34, True, green)
    y = block(x, y + 15, data['target']['text'], 39)
    y = block(x, y + 35, '이전 대화 → 다음 답변', 42, True)
    y = block(x, y + 15, '입력 마스크 0 · 정답 마스크 1', 34)
    assert y < 1320
    block(x, 1320, f"표시는 발췌. 실제 입력은 앞선 대화\n전체 {data['training']['full_input_messages_including_system']}메시지(system 포함).", 29, color=muted)
    draw.text((74, 1500), '실제 원문·저장된 문장 수치·학습 정답 대조 완료  |  단어는 표면 단위  |  수치 표현은 분석용', font=font(30), fill=muted)
    image.save(OUT / 'three_stage_sleep_examples.png')
    for x, name in zip(xs, ['01_원문정리.png', '02_특징수치화.png', '03_학습자료구성.png']):
        image.crop((x, y0, x + width, y0 + height)).save(OUT / name)
    return str(OUT / 'three_stage_sleep_examples.png')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    data = extract()
    print(json.dumps({'statistics': data['direct_statistics'], 'verification': data['verification'], 'image': render(data)}, ensure_ascii=False))
