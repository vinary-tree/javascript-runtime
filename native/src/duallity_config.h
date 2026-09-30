#ifndef VIN_TREE_DUALLITY_CONFIG_TRANSPORT_H
#define VIN_TREE_DUALLITY_CONFIG_TRANSPORT_H

#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "duallity.h"

namespace duallity_config {

constexpr uint32_t kMagic = 0x31434644;

struct Reader {
  const uint8_t* bytes;
  size_t size;
  size_t offset = 0;

  bool take(size_t count, const uint8_t** output) {
    if (count > size - offset) return false;
    *output = bytes + offset;
    offset += count;
    return true;
  }

  bool u32(uint32_t* output) {
    const uint8_t* data;
    if (!take(4, &data)) return false;
    *output = uint32_t(data[0]) | (uint32_t(data[1]) << 8) |
              (uint32_t(data[2]) << 16) | (uint32_t(data[3]) << 24);
    return true;
  }

  bool u64(uint64_t* output) {
    const uint8_t* data;
    if (!take(8, &data)) return false;
    *output = 0;
    for (unsigned index = 0; index < 8; ++index) *output |= uint64_t(data[index]) << (8 * index);
    return true;
  }

  bool f64(double* output) {
    uint64_t bits;
    if (!u64(&bits)) return false;
    std::memcpy(output, &bits, sizeof(bits));
    return true;
  }

  bool text(std::vector<uint8_t>* output) {
    uint32_t count;
    const uint8_t* data;
    if (!u32(&count) || count > 1'048'576 || !take(count, &data)) return false;
    output->assign(data, data + count);
    return true;
  }
};

struct OwnedPair {
  std::vector<uint8_t> source;
  std::vector<uint8_t> target;
};

struct OwnedOperation {
  std::vector<uint8_t> name;
  std::vector<OwnedPair> pairs;
  std::vector<DuallityRestrictionV1> restrictions;
};

inline DuallityRecordHeaderV1 header(uint32_t size) { return {size, 1, 0}; }

struct Parsed {
  DuallityWfstOptionsV1 options{};
  std::optional<DuallityGeneralizedLimitsV1> limits;
  std::vector<OwnedOperation> owned;
  std::vector<DuallityOperationV1> operations;

  void refresh() {
    options.limits = limits ? &*limits : nullptr;
    options.operations = operations.empty() ? nullptr : operations.data();
  }
};

inline bool parse(const uint8_t* bytes, size_t size, Parsed* output, std::string* error) {
  if (size > 2'000'000 || (size != 0 && bytes == nullptr)) {
    *error = "duallity configuration exceeds 2 MiB or has no data";
    return false;
  }
  Reader reader{bytes, size};
  uint32_t magic, version, has_limits, count;
  auto& options = output->options;
  options.header = header(sizeof(options));
  if (!reader.u32(&magic) || !reader.u32(&version) || magic != kMagic || version != 1 ||
      !reader.u32(&options.kind) || !reader.u32(&options.algorithm) ||
      !reader.u64(&options.maximum_distance) || !reader.u32(&options.cache_policy) ||
      !reader.u64(&options.cache_capacity) || !reader.u32(&has_limits) ||
      !reader.u32(&count) || has_limits > 1 || count > 4096) {
    *error = "invalid or truncated duallity configuration header";
    return false;
  }
  if (has_limits == 1) {
    DuallityGeneralizedLimitsV1 limits{};
    limits.header = header(sizeof(limits));
    uint64_t* fields[] = {
      &limits.max_query_bytes, &limits.max_query_scalars,
      &limits.max_operation_source_scalars, &limits.max_operation_query_scalars,
      &limits.max_retained_dictionary_nodes, &limits.max_retained_wfst_states,
      &limits.max_paths_per_expansion, &limits.max_work_units_per_expansion,
    };
    for (uint64_t* field : fields) {
      if (!reader.u64(field)) {
        *error = "truncated duallity limits";
        return false;
      }
    }
    output->limits = limits;
  }
  output->owned.reserve(count);
  output->operations.reserve(count);
  size_t total_pairs = 0;
  size_t total_text = 0;
  for (uint32_t index = 0; index < count; ++index) {
    DuallityOperationV1 operation{};
    operation.header = header(sizeof(operation));
    uint32_t pair_count;
    OwnedOperation owned;
    if (!reader.u64(&operation.consume_x) || !reader.u64(&operation.consume_y) ||
        !reader.f64(&operation.weight) || !reader.u32(&operation.applicability) ||
        !reader.text(&owned.name) || !reader.u32(&pair_count) || pair_count > 4096 ||
        pair_count > 4096 - total_pairs) {
      *error = "invalid or truncated duallity operation";
      return false;
    }
    total_pairs += pair_count;
    total_text += owned.name.size();
    owned.pairs.reserve(pair_count);
    owned.restrictions.reserve(pair_count);
    for (uint32_t pair = 0; pair < pair_count; ++pair) {
      OwnedPair value;
      if (!reader.text(&value.source) || !reader.text(&value.target)) {
        *error = "invalid or truncated duallity restriction";
        return false;
      }
      total_text += value.source.size() + value.target.size();
      DuallityRestrictionV1 record{};
      record.header = header(sizeof(record));
      record.source_data = value.source.data();
      record.source_len = value.source.size();
      record.target_data = value.target.data();
      record.target_len = value.target.size();
      owned.pairs.push_back(std::move(value));
      owned.restrictions.push_back(record);
    }
    if (total_text > 1'048'576) {
      *error = "custom operation text exceeds 1 MiB";
      return false;
    }
    operation.name_data = owned.name.data();
    operation.name_len = owned.name.size();
    operation.restrictions = owned.restrictions.empty() ? nullptr : owned.restrictions.data();
    operation.restriction_count = pair_count;
    operation.restriction_stride = pair_count == 0 ? 0 : sizeof(DuallityRestrictionV1);
    output->owned.push_back(std::move(owned));
    output->operations.push_back(operation);
  }
  if (reader.offset != size) {
    *error = "duallity configuration has trailing bytes";
    return false;
  }
  options.operation_count = count;
  options.operation_stride = count == 0 ? 0 : sizeof(DuallityOperationV1);
  output->refresh();
  return true;
}

inline void put_u32(std::vector<uint8_t>* output, uint32_t value) {
  for (unsigned index = 0; index < 4; ++index) output->push_back(uint8_t(value >> (8 * index)));
}

inline void put_u64(std::vector<uint8_t>* output, uint64_t value) {
  for (unsigned index = 0; index < 8; ++index) output->push_back(uint8_t(value >> (8 * index)));
}

inline bool put_text(std::vector<uint8_t>* output, const uint8_t* data, uint64_t length) {
  if (length > 1'048'576 || length > std::numeric_limits<uint32_t>::max() ||
      (length > 0 && data == nullptr)) return false;
  put_u32(output, uint32_t(length));
  if (length > 0) output->insert(output->end(), data, data + length);
  return true;
}

inline bool encode(const DuallityWfstOptionsV1& options, std::vector<uint8_t>* output) {
  if (options.operation_count > 4096 ||
      (options.operation_count > 0 && options.operations == nullptr)) return false;
  put_u32(output, kMagic);
  put_u32(output, 1);
  put_u32(output, options.kind);
  put_u32(output, options.algorithm);
  put_u64(output, options.maximum_distance);
  put_u32(output, options.cache_policy);
  put_u64(output, options.cache_capacity);
  put_u32(output, options.limits == nullptr ? 0 : 1);
  put_u32(output, uint32_t(options.operation_count));
  if (options.limits != nullptr) {
    const auto& l = *options.limits;
    for (uint64_t value : {l.max_query_bytes, l.max_query_scalars,
                           l.max_operation_source_scalars, l.max_operation_query_scalars,
                           l.max_retained_dictionary_nodes, l.max_retained_wfst_states,
                           l.max_paths_per_expansion, l.max_work_units_per_expansion}) put_u64(output, value);
  }
  for (uint64_t index = 0; index < options.operation_count; ++index) {
    const auto& op = options.operations[index];
    if (op.restriction_count > 4096 ||
        (op.restriction_count > 0 && op.restrictions == nullptr)) return false;
    put_u64(output, op.consume_x);
    put_u64(output, op.consume_y);
    uint64_t bits;
    std::memcpy(&bits, &op.weight, sizeof(bits));
    put_u64(output, bits);
    put_u32(output, op.applicability);
    if (!put_text(output, op.name_data, op.name_len)) return false;
    put_u32(output, uint32_t(op.restriction_count));
    for (uint64_t pair = 0; pair < op.restriction_count; ++pair) {
      const auto& r = op.restrictions[pair];
      if (!put_text(output, r.source_data, r.source_len) ||
          !put_text(output, r.target_data, r.target_len)) return false;
    }
  }
  return true;
}

} // namespace duallity_config

#endif
