#include <string>

namespace math {
/// Small deterministic calculator.
class Calculator {
public:
  int add(int left, int right);
  explicit operator bool() const {
    return true;
  }
};
}
