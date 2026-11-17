"""Opt-in host timings around the unchanged token stream contract."""
import time
from gpu31b_stream_protocol import StableTokenChunks


class MeasuredTokenChunks(StableTokenChunks):
    def __init__(self, decode, emit, tail_chars=32, clock=time.time, timer=time.perf_counter):
        self.measurements = {'decode_calls': 0, 'decode_seconds': 0.0, 'emit_calls': 0, 'emit_seconds': 0.0}
        def measured(name, operation):
            def call(value):
                started = timer()
                try:
                    return operation(value)
                finally:
                    self.measurements[name+'_calls'] += 1
                    self.measurements[name+'_seconds'] += timer()-started
            return call
        super().__init__(measured('decode', decode), measured('emit', emit), tail_chars=tail_chars, clock=clock)

    def timings(self):
        return {**self.measurements,
                'scope': 'Host elapsed tokenizer decoding and synchronous emit callback; included in generation wall time, not separate GPU kernel timing.'}
