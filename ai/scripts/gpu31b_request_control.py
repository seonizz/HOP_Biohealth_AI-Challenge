"""Cooperative request cancellation; never sends signals or stops a worker."""
import json
import os
import stat
from pathlib import Path
import uuid


def request_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('A canonical UUID request ID is required')
    return value


def _directory(root, create=False):
    root = Path(root)
    if not root.is_absolute() or root != root.resolve(strict=True) or not root.is_dir():
        raise ValueError('Request control requires a canonical existing task root')
    directory = root / 'request-cancellations'
    if create:
        directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.exists() and (not directory.is_dir() or directory.resolve() != directory):
        raise ValueError('Cancellation directory must remain inside the task root')
    return directory


def cancel_request(root, identifier):
    """An idempotent marker affects only this UUID, including before dispatch."""
    identifier = request_id(identifier)
    path = _directory(root, create=True) / (identifier + '.json')
    content = (json.dumps({'request_id': identifier, 'cancelled': True}) + '\n').encode()
    if path.exists() or path.is_symlink():
        if not RequestControl(root, identifier).cancelled():
            raise ValueError('Existing cancellation marker is invalid')
    else:
        temporary = path.with_name('.' + identifier + '.' + uuid.uuid4().hex)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(content); handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    return {'status': 'request_cancel_requested', 'request_id': identifier}


def control_for_request(root, identifier):
    # Historical integer/non-UUID IDs retain their original uncancellable path.
    try:
        request_id(identifier)
    except (ValueError, AttributeError):
        return None
    return RequestControl(root, identifier)


class RequestControl:
    def __init__(self, root, identifier):
        self.root, self.identifier = Path(root), request_id(identifier)
        self.observed = False

    def cancelled(self):
        if self.observed:
            return True
        path = _directory(self.root) / (self.identifier + '.json')
        try:
            fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        except FileNotFoundError:
            return False
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024:
                raise ValueError('Unsafe cancellation marker')
            value = json.loads(handle.read(1025))
        if value != {'request_id': self.identifier, 'cancelled': True}:
            raise ValueError('Cancellation marker does not match the active request')
        self.observed = True
        return True


def recovery_receipt(identifier, evidence):
    """Call only after generate() returned through its cleanup/integrity finally."""
    before, after = evidence.get('adapter_digest_before'), evidence.get('adapter_digest_after')
    clean = isinstance(evidence.get('cache_entries_cleared_after'), list)
    unchanged = isinstance(before, str) and bool(before) and before == after
    return {'version': 1, 'request_id': identifier, 'request_stopped': True,
            'cache_cleared': clean, 'adapter_unchanged': unchanged, 'worker_reusable': clean and unchanged}
