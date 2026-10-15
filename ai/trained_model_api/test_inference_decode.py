from contextlib import contextmanager
from types import SimpleNamespace
import unittest

from inference_decode import install_eager_decode


class DecodeTests(unittest.TestCase):
    def test_decode_context_is_scoped_and_prefill_unmodified(self):
        events = []
        @contextmanager
        def context():
            events.append("enter")
            try: yield
            finally: events.append("exit")
        def original(*args, **kwargs):
            events.append("forward")
            if kwargs.get("fail"): raise RuntimeError("test")
            return "output"
        model = SimpleNamespace(training=False, parameters=lambda: iter([SimpleNamespace(requires_grad=False, device=SimpleNamespace(type="cuda"))]), forward=original)
        torch = SimpleNamespace(is_grad_enabled=lambda: False, compiler=SimpleNamespace(is_compiling=lambda: False))
        install_eager_decode(model, torch, context)
        ids = SimpleNamespace(ndim=2, shape=(1, 1))
        self.assertEqual(model.forward(input_ids=ids, past_key_values=object()), "output")
        self.assertEqual(events, ["enter", "forward", "exit"])
        events.clear()
        with self.assertRaises(RuntimeError): model.forward(input_ids=ids, past_key_values=object(), fail=True)
        self.assertEqual(events, ["enter", "forward", "exit"])
        for kwargs in ({"input_ids": SimpleNamespace(ndim=2, shape=(1, 4096)), "past_key_values": object()}, {"input_ids": ids}):
            events.clear();model.forward(**kwargs);self.assertEqual(events, ["forward"])
        for field in ("grad", "compile"):
            if field == "grad": torch.is_grad_enabled = lambda: True
            else:
                torch.is_grad_enabled = lambda: False
                torch.compiler.is_compiling = lambda: True
            events.clear();model.forward(input_ids=ids, past_key_values=object());self.assertEqual(events, ["forward"])
        with self.assertRaises(ValueError): install_eager_decode(model, torch, context)


if __name__ == "__main__":
    unittest.main()
