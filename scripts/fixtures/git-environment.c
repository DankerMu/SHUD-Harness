#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static const char *const allowed[] = {
    "PATH", "HOME", "LC_ALL", "GIT_OPTIONAL_LOCKS", "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "GIT_CEILING_DIRECTORIES"
};

static void field(FILE *trace, const char *value, size_t length) {
    fwrite(value, 1, length, trace);
    fputc(0, trace);
}

int main(int argc, char **argv) {
    FILE *trace = fopen(TRACE_PATH, "ab");
    if (trace == NULL) {
        perror("git environment trace");
        return 125;
    }

    /* Each record: argc, args, key count, keys, value count, key/value pairs.
       All fields are NUL-terminated; counts are decimal. No secret values are logged. */
    fprintf(trace, "%d%c", argc - 1, 0);
    for (int i = 1; i < argc; i++) field(trace, argv[i], strlen(argv[i]));

    size_t key_count = 0;
    while (environ[key_count] != NULL) key_count++;
    fprintf(trace, "%zu%c", key_count, 0);
    for (size_t i = 0; i < key_count; i++) {
        field(trace, environ[i], strcspn(environ[i], "="));
    }

    const size_t allowed_count = sizeof(allowed) / sizeof(allowed[0]);
    size_t value_count = 0;
    for (size_t i = 0; i < allowed_count; i++) {
        if (getenv(allowed[i]) != NULL) value_count++;
    }
    fprintf(trace, "%zu%c", value_count, 0);
    for (size_t i = 0; i < allowed_count; i++) {
        const char *value = getenv(allowed[i]);
        if (value == NULL) continue;
        field(trace, allowed[i], strlen(allowed[i]));
        field(trace, value, strlen(value));
    }

    const int failed = ferror(trace);
    const int closed = fclose(trace);
    if (failed || closed != 0) {
        fputs("cannot write git environment trace\n", stderr);
        return 125;
    }
    execv(REAL_GIT, argv);
    perror("exec real git");
    return 126;
}
