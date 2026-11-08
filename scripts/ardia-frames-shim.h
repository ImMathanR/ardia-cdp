// shm_open is variadic, which Swift can't call; this wraps the create case.
#include <fcntl.h>
#include <sys/mman.h>
static inline int shm_create(const char *name) { return shm_open(name, O_CREAT | O_RDWR | O_EXCL, 0600); }
