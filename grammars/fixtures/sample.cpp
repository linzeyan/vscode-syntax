#include <string>
#include <vector>

namespace poly {

template <typename T>
class Registry {
public:
    void add(T value) { items_.push_back(std::move(value)); }
    [[nodiscard]] size_t size() const noexcept { return items_.size(); }

private:
    std::vector<T> items_;
};

}  // namespace poly
