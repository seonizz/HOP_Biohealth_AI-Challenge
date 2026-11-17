"""Trusted offline validation bootstrap: no site hooks before process restrictions."""
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import platform
import re
import runpy
import stat
import sys

BASE = Path('/home/slim/choieram')
VENV = BASE / 'malssi-validation-20261009/.venv'
DEVICES = ['/dev/null', '/dev/nvidia0', '/dev/nvidia1', '/dev/nvidiactl', '/dev/nvidia-uvm']
DENY_SYSCALLS = '''chmod fchmod fchmodat fchmodat2 chown fchown lchown fchownat
setxattr lsetxattr fsetxattr removexattr lremovexattr fremovexattr
utime utimes futimesat utimensat mount umount2 pivot_root chroot
fsopen fsconfig fsmount move_mount open_tree mount_setattr
ptrace process_vm_writev pidfd_getfd io_uring_setup
connect sendto sendmsg sendmmsg
reboot kexec_load kexec_file_load init_module finit_module delete_module swapon swapoff
sethostname setdomainname acct quotactl'''.split()

def require(value, message):
    if not value:
        raise RuntimeError(message)

def real_owned(p, *, directory=True):
    require(p.resolve() == p and p.is_relative_to(BASE), f'noncanonical scope: {p}')
    for q in [p, *p.parents]:
        if q == BASE.parent:
            break
        s = q.lstat()
        require(not stat.S_ISLNK(s.st_mode) and s.st_dev == BASE.stat().st_dev, f'link/mount: {q}')
    require(p.stat().st_uid == os.getuid(), 'unexpected owner')
    require(p.is_dir() if directory else p.is_file(), 'wrong path type')

def sandbox(writable, devices):
    require(platform.machine() == 'x86_64', 'unsupported architecture')
    lib = ctypes.CDLL(None, use_errno=True)
    lib.syscall.restype = ctypes.c_long
    abi = lib.syscall(444, 0, 0, 1)
    require(abi >= 6, f'Landlock ABI too old: {abi}')
    # Handle all filesystem mutation rights available since ABI 5, but not reads/execs.
    handled = sum(1 << b for b in [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    allowed = sum(1 << b for b in [1, 4, 5, 7, 8, 9, 13, 14])
    class Ruleset(ctypes.Structure):
        _fields_ = [('handled_access_fs', ctypes.c_uint64),
                    ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]
    class Beneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
    attr = Ruleset(handled, 0, 3)
    fd = lib.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    require(fd >= 0, f'create ruleset errno {ctypes.get_errno()}')
    def grant(path, rights):
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            rule = Beneath(rights, pfd)
            require(lib.syscall(445, fd, 1, ctypes.byref(rule), 0) == 0,
                    f'add rule errno {ctypes.get_errno()}: {path}')
        finally:
            os.close(pfd)
    grant(str(writable), allowed)
    for dev in devices:
        p = Path(dev)
        require(not p.is_symlink() and stat.S_ISCHR(p.stat().st_mode), f'not char device: {dev}')
        grant(dev, (1 << 1) | (1 << 15))
    require(lib.prctl(38, 1, 0, 0, 0) == 0, 'no_new_privs failed')
    require(lib.syscall(446, fd, 0) == 0, f'restrict_self errno {ctypes.get_errno()}')
    os.close(fd)
    sec = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    sec.seccomp_init.argtypes = [ctypes.c_uint32]
    sec.seccomp_init.restype = ctypes.c_void_p
    sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    sec.seccomp_syscall_resolve_name.restype = ctypes.c_int
    sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    sec.seccomp_rule_add.restype = ctypes.c_int
    sec.seccomp_load.argtypes = [ctypes.c_void_p]
    sec.seccomp_load.restype = ctypes.c_int
    sec.seccomp_release.argtypes = [ctypes.c_void_p]
    class Compare(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                    ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]
    sec.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                         ctypes.c_uint, ctypes.POINTER(Compare)]
    sec.seccomp_rule_add_array.restype = ctypes.c_int
    ctx = sec.seccomp_init(0x7fff0000)
    require(ctx, 'seccomp init failed')
    loaded = []
    try:
        for name in DENY_SYSCALLS:
            number = sec.seccomp_syscall_resolve_name(name.encode())
            require(number >= 0, f'unknown required syscall: {name}')
            require(sec.seccomp_rule_add(ctx, 0x50000 | errno.EPERM, number, 0) == 0,
                    f'seccomp rule failed: {name}')
            loaded.append(name)
        # CUDA needs a process-local abstract Unix listener. Internet socket creation
        # remains blocked; connect/send* remain denied, including the global MPS pipe.
        comparison = Compare(0, 1, 1, 0)  # arg0 != AF_UNIX, SCMP_CMP_NE
        number = sec.seccomp_syscall_resolve_name(b'socket')
        require(number >= 0 and sec.seccomp_rule_add_array(
            ctx, 0x50000 | errno.EPERM, number, 1, ctypes.byref(comparison)) == 0,
            'socket family rule failed')
        require(sec.seccomp_load(ctx) == 0, 'seccomp load failed')
    finally:
        sec.seccomp_release(ctx)
    return {'landlock_abi': abi, 'writable_regular_tree': str(writable),
            'device_operation_exceptions': devices, 'seccomp_denied': loaded,
            'socket_family_allowed': 'AF_UNIX only', 'landlock_scoped': 3}

def expect_denied(action):
    try:
        result = action()
        if isinstance(result, int):
            os.close(result)
    except OSError as error:
        require(error.errno in (errno.EACCES, errno.EPERM, errno.EXDEV), f'wrong denial: {error}')
        return error.errno
    raise RuntimeError('expected operation was not denied')
