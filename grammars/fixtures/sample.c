#include <stdio.h>
#include <stdlib.h>

typedef struct {
    int id;
    const char *name;
} user_t;

int main(void) {
    user_t u = {.id = 1, .name = "poly"};
    printf("Hello, %s (%d)\n", u.name, u.id);
    return EXIT_SUCCESS;
}
