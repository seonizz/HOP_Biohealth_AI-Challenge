import unittest
from gpu31b_stream_metrics import MeasuredTokenChunks


class StreamMetricsTests(unittest.TestCase):
    def test_measurement_preserves_deltas_and_counts_full_prefix_decode(self):
        timer = iter([0,2,3,7,8,9])
        emitted = []
        stream = MeasuredTokenChunks(lambda tokens: ''.join(tokens), emitted.append, tail_chars=0, timer=lambda: next(timer))
        stream.push(['a','b']); stream.end(['a','b']); stream.assert_final('ab')
        self.assertEqual([row['delta'] for row in emitted], ['ab'])
        self.assertEqual(stream.timings()['decode_calls'], 2)
        self.assertEqual(stream.timings()['decode_seconds'], 3)
        self.assertEqual(stream.timings()['emit_calls'], 1)
        self.assertEqual(stream.timings()['emit_seconds'], 4)


if __name__ == '__main__': unittest.main()
