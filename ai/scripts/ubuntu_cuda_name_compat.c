/* Linux task-local compatibility for NVIDIA's cosmetic helper-thread naming.
 *
 * NVIDIA 595's fopen("/proc/self/task/<tid>/comm", "w") fails under the HOP
 * write boundary and makes CUDA device initialization return error 304. Only
 * that exact write-only path is redirected to this task's bound log sink.
 * No driver setting, GPU arithmetic, filesystem permission or network policy
 * changes. Nonmatching paths/modes use the original libc fopen unchanged.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef HOP_NAME_SINK
#define HOP_NAME_SINK "/home/chihun/Documents/HOP/evaluations/role_eval_20261112/work/cuda-threadnames.log"
#endif

static pthread_once_t resolve_once = PTHREAD_ONCE_INIT;
static FILE *(*libc_fopen)(const char *, const char *);

static void resolve_original(void) {
    *(void **)(&libc_fopen) = dlsym(RTLD_NEXT, "fopen");
}

static int is_own_thread_name_write(const char *path, const char *mode) {
    static const char prefix[] = "/proc/self/task/";
    if (!path || !mode || mode[0] != 'w' || strchr(mode, '+') ||
        strncmp(path, prefix, sizeof(prefix) - 1) != 0)
        return 0;
    const unsigned char *cursor = (const unsigned char *)path + sizeof(prefix) - 1;
    if (!isdigit(*cursor)) return 0;
    while (isdigit(*cursor)) cursor++;
    return strcmp((const char *)cursor, "/comm") == 0;
}

FILE *fopen(const char *path, const char *mode) {
    if (is_own_thread_name_write(path, mode)) {
        const char *sink = getenv("HOP_CUDA_THREAD_NAME_SINK");
        if (!sink || strcmp(sink, HOP_NAME_SINK) != 0) {
            errno = EPERM;
            return NULL;
        }
        int descriptor = open(sink, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (descriptor < 0) return NULL;
        struct stat info;
        if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) ||
            info.st_uid != geteuid() || info.st_nlink != 1) {
            close(descriptor);
            errno = EPERM;
            return NULL;
        }
        FILE *stream = fdopen(descriptor, "a");
        if (!stream) {
            int saved_errno = errno;
            close(descriptor);
            errno = saved_errno;
        }
        return stream;
    }
    pthread_once(&resolve_once, resolve_original);
    if (!libc_fopen) {
        errno = ENOSYS;
        return NULL;
    }
    return libc_fopen(path, mode);
}
