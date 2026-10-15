"""Run existing focused regressions and persist verifiable test evidence."""
from datetime import datetime, timezone
import io
from pathlib import Path
import time
import unittest
from .numeric import dump, fingerprint


def check_code(output):
    root=Path(__file__).resolve().parents[1]
    files=sorted((root/'counseling_pipeline').glob('*.py'))+sorted((root/'tests').glob('test_*.py'))
    hashes={str(p.relative_to(root)):fingerprint(p) for p in files}
    started=time.monotonic();stream=io.StringIO()
    suite=unittest.defaultTestLoader.discover(str(root/'tests'))
    result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
    log=stream.getvalue();print(log,flush=True)
    output=Path(output);output.mkdir(exist_ok=True,parents=True)
    (output/'tests.log').write_text(log)
    report={'tests_run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
       'skipped':len(result.skipped),'checks_passed':result.wasSuccessful() and not result.skipped,
       'elapsed_seconds':time.monotonic()-started,'code_sha256':hashes,
       'timestamp':datetime.now(timezone.utc).isoformat(),
       'scope':'synthetic regression tests, not actual AI labeling records'}
    dump(output/'tests_result.json',report);return report
