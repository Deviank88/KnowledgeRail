#include <stddef.h>

/** Add two integers. */
int sum(int left, int right) {
  return left + right;
}

int declared_only(int value);

#define GENERATED(name) \
  int name(void) { return 0; }
