"""Small stdlib-only streaming contract used by the isolated 31B worker/queue."""
import json
import math
import time

MAX_CHUNK_BYTES = 256 * 1024
MAX_STREAM_BYTES = 16 * 1024 * 1024


class StableTokenChunks:
    """Emit only a decoded prefix outside a held Unicode/tokenizer tail.

    push/end are called inside generate's streamer callbacks. assert_final never
    emits: a completed generation cannot masquerade as a live token stream.
    """
    def __init__(self, decode, emit, tail_chars=32, clock=time.time):
        self.decode, self.emit, self.tail_chars, self.clock = decode, emit, tail_chars, clock
        self.text = ''; self.seq = 0; self.ended = False; self.first_at = None

    def _send(self, text):
        if not text.startswith(self.text):
            raise ValueError('Decoded prefix changed after streaming')
        delta = text[len(self.text):]
        if delta:
            delta.encode('utf-8', errors='strict')
            self.seq += 1; at = self.clock()
            if self.first_at is None: self.first_at = at
            self.emit({'seq': self.seq, 'delta': delta, 'at': at})
            self.text = text

    def push(self, tokens):
        if self.ended: raise ValueError('Token received after streamer end')
        text = self.decode(tokens)
        if not text.startswith(self.text): raise ValueError('Decoded prefix changed after streaming')
        end = max(0, len(text) - self.tail_chars)
        replacement = text.find('\ufffd')
        if replacement >= 0: end = min(end, replacement)
        self._send(text[:max(len(self.text), end)])

    def end(self, tokens):
        if self.ended: raise ValueError('Duplicate streamer end')
        self._send(self.decode(tokens)); self.ended = True

    def assert_final(self, content):
        if not self.ended or self.text != content:
            raise ValueError('Streamed text differs from final decoded content')


class ChunkSequence:
    def __init__(self, identifier):
        self.identifier = identifier; self.seq = 0; self.parts = []; self.bytes = 0; self.closed = False

    def accept(self, value):
        if self.closed or value.get('event') != 'chunk' or type(value.get('id')) is not type(self.identifier) or value.get('id') != self.identifier:
            raise ValueError('Unexpected streaming event or request identifier')
        if type(value.get('seq')) is not int or value['seq'] != self.seq + 1:
            raise ValueError('Nonconsecutive streaming chunk sequence')
        delta, at = value.get('delta'), value.get('at')
        if not isinstance(delta, str) or not delta or type(at) not in (int, float) or not math.isfinite(at):
            raise ValueError('Invalid streaming chunk data')
        size = len(delta.encode('utf-8', errors='strict'))
        if size > MAX_CHUNK_BYTES or self.bytes + size > MAX_STREAM_BYTES:
            raise ValueError('Streaming output exceeds transport bounds')
        self.seq += 1; self.bytes += size; self.parts.append(delta)
        return value

    def terminal(self, envelope):
        if self.closed or type(envelope.get('id')) is not type(self.identifier) or envelope.get('id') != self.identifier:
            raise ValueError('Unexpected terminal streaming identifier')
        self.closed = True
        if 'error' in envelope: return
        response = envelope.get('response', {})
        choices = response.get('choices', [])
        if len(choices) != 1 or choices[0].get('finish_reason') != 'stop':
            raise ValueError('Streaming generation did not finish successfully')
        if ''.join(self.parts) != choices[0].get('message', {}).get('content'):
            raise ValueError('Streaming chunks differ from final content')
        proof = response.get('evidence', {}).get('json_grammar', {})
        if any(proof.get(key) is not True for key in ('full_output_replayed', 'eos_terminated', 'strict_json_parsed')):
            raise ValueError('Final streaming grammar verification is missing')


def follow_response(response, stream, identifier, state, emit, cancel, validate_file,
                    timeout=990, clock=time.monotonic, sleep=time.sleep):
    """Tail complete flushed JSONL records before the final response exists."""
    sequence = ChunkSequence(identifier); deadline = clock() + timeout; offset = 0; pending = b''
    def drain():
        nonlocal offset, pending
        if stream.exists():
            validate_file(stream)
            with stream.open('rb') as handle:
                handle.seek(offset); raw = handle.read(MAX_CHUNK_BYTES + 1); offset += len(raw)
            pending += raw
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if len(line) > MAX_CHUNK_BYTES: raise ValueError('Oversized stream record')
                value = sequence.accept(json.loads(line.decode('utf-8', errors='strict')))
                emit(value)
            if len(pending) > MAX_CHUNK_BYTES: raise ValueError('Oversized incomplete stream record')
            return bool(raw)
        return False
    while clock() < deadline:
        if drain(): continue
        if response.exists():
            validate_file(response)
            envelope = json.loads(response.read_text())
            # Publication follows the supervisor's last stream write. A write
            # may have raced the preceding empty read, so drain again after
            # observing publication before checking concatenation/terminal.
            while drain(): pass
            if pending: raise ValueError('Incomplete final stream record')
            sequence.terminal(envelope)
            emit({'event': 'result', 'envelope': envelope}); return
        status = state()
        if status.get('status') == 'failed' or status.get('stage') == 'closed':
            raise RuntimeError('Worker unavailable before terminal response')
        sleep(.05)
    cancel(); raise TimeoutError('Remote streaming response deadline')
