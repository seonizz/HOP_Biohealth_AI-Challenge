from __future__ import annotations

import ast
from collections import Counter
import io
import json
from pathlib import Path
import runpy
import sqlite3
import struct
import zipfile

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SOURCE = Path('/Users/chihun/Documents/ChatGPT/HOP_data/outputs/private')
SID = 'sent_0ede49b58535add6753857af0ba40888691ea62d51ac539b9695e43ea0a32f07'
HELPERS = runpy.run_path(str(OUT.parent / 'processing_examples_20261010/build_examples.py'))
font, wrap = HELPERS['font'], HELPERS['wrap']


def header(stream):
    assert stream.read(6) == b'\x93NUMPY'
    version = tuple(stream.read(2))
    fmt = '<H' if version == (1, 0) else '<I'
    length = struct.unpack(fmt, stream.read(struct.calcsize(fmt)))[0]
    metadata = ast.literal_eval(stream.read(length).decode('latin1'))
    assert not metadata['fortran_order']
    return metadata, stream.tell()


def extract():
    db = SOURCE / 'corpus.sqlite'
    connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    sentence = dict(connection.execute('SELECT * FROM sentences WHERE sentence_id=?', (SID,)).fetchone())
    words = [dict(row) for row in connection.execute(
        'SELECT word_occurrence_id, ordinal, surface, normalized, start_char, end_char FROM words WHERE sentence_id=? ORDER BY ordinal', (SID,))]
    utterance = dict(connection.execute(
        'SELECT utterance_id, ordinal, speaker, text FROM utterances WHERE utterance_id=?', (sentence['utterance_id'],)).fetchone())
    next_turn = dict(connection.execute(
        'SELECT utterance_id, ordinal, speaker, text FROM utterances WHERE conversation_id=? AND ordinal=?',
        (sentence['conversation_id'], utterance['ordinal'] + 1)).fetchone())
    assert utterance['text'][sentence['start_char']:sentence['end_char']] == sentence['text']
    for word in words:
        assert utterance['text'][word['start_char']:word['end_char']] == word['surface']
    connection.close()
    numeric = SOURCE / 'numeric'
    with (numeric / 'sentence_rows.jsonl').open() as stream:
        for line_number, line in enumerate(stream, 1):
            mapping = json.loads(line)
            if mapping['id'] == SID:
                break
        else:
            raise ValueError('Numerical row not found')
    with (numeric / 'sentence_statistics.npy').open('rb') as stream:
        metadata, start = header(stream)
        assert metadata['descr'] == '<f4'
        stream.seek(start + mapping['row'] * metadata['shape'][1] * 4)
        statistics = list(struct.unpack('<4f', stream.read(16)))
    counts = Counter(word['normalized'] for word in words)
    assert statistics == [len(sentence['text']), sum(not c.isspace() for c in sentence['text']), len(words), len(counts)]
    vocabulary = json.loads((numeric / 'vocabulary.json').read_text())
    terms = vocabulary['terms']
    with zipfile.ZipFile(numeric / 'sentence_tfidf.npz') as archive:
        parts = {}
        for name in ['indptr', 'indices', 'data']:
            stream = io.BytesIO(archive.read(name + '.npy'))
            metadata, offset = header(stream)
            parts[name] = (metadata, offset, stream)
        metadata, offset, stream = parts['indptr']
        fmt = {'<i4': 'i', '<i8': 'q'}[metadata['descr']]
        size = struct.calcsize('<' + fmt)
        stream.seek(offset + mapping['row'] * size)
        a, b = struct.unpack('<2' + fmt, stream.read(size * 2))
        def values(name, type_map):
            metadata, offset, stream = parts[name]
            fmt = type_map[metadata['descr']]
            size = struct.calcsize('<' + fmt)
            stream.seek(offset + a * size)
            return struct.unpack('<' + str(b - a) + fmt, stream.read((b - a) * size))
        columns = values('indices', {'<i4': 'i', '<i8': 'q'})
        weights = values('data', {'<f4': 'f', '<f8': 'd'})
    tfidf = [{'column': column, 'term': terms[column], 'value': weight} for column, weight in zip(columns, weights, strict=True)]
    oov = [word for word in counts if 'u:' + word not in terms]
    assert statistics == [20, 14, 7, 6] and counts['되든'] == 2
    assert oov == ['죽이', '밥이']
    result = {
        'source': {'database': str(db), 'statistics': str(numeric / 'sentence_statistics.npy'),
                   'mapping': str(numeric / 'sentence_rows.jsonl'), 'mapping_line': line_number,
                   'numeric_row': mapping['row'], 'tfidf': str(numeric / 'sentence_tfidf.npz'),
                   'vocabulary': str(numeric / 'vocabulary.json')},
        'sentence': sentence, 'utterance': utterance, 'word_occurrences': words,
        'surface_word_counts': dict(counts),
        'stored_statistics': {'characters': statistics[0], 'nonspace_characters': statistics[1],
                              'surface_words': statistics[2], 'unique_surface_words': statistics[3]},
        'stored_tfidf_nonzero_values': tfidf,
        'tfidf_oov_surface_words': oov,
        'interpretation': {'kind': 'contextual_assistant_interpretation_not_stored_label',
                            'text': '결과가 어떻든 일단 시도하겠다는 뜻의 관용표현으로 읽을 수 있음'},
        'actual_next_counselor_turn': next_turn,
        'verification': {'original_spans_match': True, 'stored_statistics_match': True,
                         'tfidf_read_from_saved_npz': True, 'oov_confirmed_against_fitted_vocabulary': True},
    }
    (OUT / 'example_data.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


def render(data):
    image = Image.new('RGB', (2400, 1490), '#FBFCF9')
    draw = ImageDraw.Draw(image)
    green, dark, muted = '#246447', '#172B25', '#64746B'
    draw.text((70, 55), '“죽이 되든 밥이 되든”은 어떻게 데이터가 됐을까?', font=font(63, True), fill=dark)
    draw.text((74, 155), '실제 원문 → 단어와 길이 → 저장된 TF-IDF', font=font(40), fill=muted)
    xs, top, width, height = [70, 835, 1600], 250, 730, 950
    for x, title in zip(xs, ['01  실제 원문', '02  단어·길이 수치', '03  실제 TF-IDF']):
        draw.rounded_rectangle((x, top, x + width, top + height), 30, fill='white', outline='#CDDED0', width=3)
        draw.rounded_rectangle((x + 22, top + 22, x + width - 22, top + 134), 22, fill='#E4EDDA')
        draw.text((x + 50, top + 47), title, font=font(48, True), fill=green)
    def block(x, y, text, size=38, bold=False, color=dark):
        for line in wrap(draw, text, font(size, bold), 626):
            draw.text((x, y), line, font=font(size, bold), fill=color)
            y += size + 12
        return y
    x = xs[0] + 52
    y = block(x, 420, '내담자 · 원문 그대로', 34, True, green)
    y = block(x, y + 18, data['sentence']['text'], 49, True)
    y = block(x, y + 50, '단어 등장 7개', 35, True, green)
    y = block(x, y + 18, '[죽이] [되든] [밥이] [되든]\n[일단] [할] [거야]', 40)
    y = block(x, y + 45, '관용표현의 문맥상 해석', 35, True, green)
    block(x, y + 18, '결과가 어떻든\n일단 시도하겠다.', 47, True)
    block(x, 1140, '해석은 설명용 · 원문에 붙은 라벨 아님', 27, color=muted)
    x = xs[1] + 52
    y = block(x, 420, '저장된 문장 통계', 34, True, green)
    labels = [('전체 글자 수', '20자'), ('공백 제외', '14자'), ('단어 등장', '7개'), ('서로 다른 단어', '6개')]
    for i, (label, value) in enumerate(labels):
        yy = y + 30 + i * 78
        draw.text((x, yy), label, font=font(39), fill=dark)
        draw.text((x + 450, yy), value, font=font(46, True), fill=green)
    y = block(x, y + 370, '단어 빈도', 35, True, green)
    y = block(x, y + 18, '되든 2회\n죽이·밥이·일단·할·거야 각 1회', 38)
    y = block(x, y + 30, '통계 배열  [20, 14, 7, 6]', 37, True)
    block(x, 1140, '글자 수: 공백·문장부호 포함', 29, color=muted)
    x = xs[2] + 52
    y = block(x, 420, '현재 저장된 5개 특성', 34, True, green)
    display = sorted(data['stored_tfidf_nonzero_values'], key=lambda row: row['value'], reverse=True)
    for i, row in enumerate(display):
        yy = y + 30 + i * 87
        label = row['term'].removeprefix('u:').removeprefix('b:').replace('\x1f', ' + ')
        draw.text((x, yy), label, font=font(38), fill=dark)
        draw.text((x + 474, yy), f"{row['value']:.4f}", font=font(39, True), fill=dark)
        draw.rounded_rectangle((x, yy + 48, x + 626 * row['value'], yy + 65), 7, fill=green)
    y = block(x, y + 488, '죽이·밥이: 현재 어휘 밖', 38, True)
    block(x, y + 18, '원문에는 보존됨\n현재 TF-IDF에는 표현 없음', 31, color=muted)
    draw.text((74, 1260), '이 숫자는 길이·빈도·단어 특성입니다. “어떤 결과든 해보겠다”라는 뜻을 직접 저장한 점수가 아닙니다.', font=font(38, True), fill=dark)
    draw.text((74, 1330), '원문과 앞뒤 대화를 함께 읽어야 관용표현의 뜻을 이해할 수 있습니다.', font=font(37), fill=green)
    image.save(OUT / 'idiom_processed_data.png')
    return str(OUT / 'idiom_processed_data.png')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    data = extract()
    print(json.dumps({'text': data['sentence']['text'], 'statistics': data['stored_statistics'], 'tfidf': data['stored_tfidf_nonzero_values'], 'image': render(data), 'verification': data['verification']}, ensure_ascii=False))
