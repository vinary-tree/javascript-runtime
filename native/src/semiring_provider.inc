constexpr size_t kMaximumSemiringValues = 0xffffu;

struct JsSemiringSlot {
  uint32_t generation{1};
  napi_ref value{};
};

struct JsSemiringProviderContext {
  std::atomic<uint64_t> references{1};
  std::atomic_flag active = ATOMIC_FLAG_INIT;
  napi_env env{};
  napi_ref provider{};
  napi_threadsafe_function cleanup{};
  std::thread::id owner_thread;
  uint64_t cookie{};
  bool division{};
  bool star{};
  bool numeric{};
  bool closure_known{};
  size_t closure_bound{};
  std::vector<JsSemiringSlot> slots;
  std::vector<uint32_t> free_slots;
  VtSemiringVTable semiring_table{};
  VtSemiringDivisionVTable division_table{};
  VtSemiringStarVTable star_table{};
  VtSemiringNumericVTable numeric_table{};
  VtSemiringPropertiesVTable properties_table{};
};

std::atomic<uint64_t> next_semiring_identity{1};

void destroy_js_semiring_provider(napi_env env, napi_value, void*, void* data) {
  auto* context = static_cast<JsSemiringProviderContext*>(data);
  if (env != nullptr) {
    for (auto& slot : context->slots) {
      if (slot.value != nullptr) (void)napi_delete_reference(env, slot.value);
    }
    if (context->provider != nullptr) (void)napi_delete_reference(env, context->provider);
  }
  delete context;
}

VtStatus js_semiring_try_retain(JsSemiringProviderContext* context) {
  if (context == nullptr) return VT_STATUS_CLOSED;
  uint64_t current = context->references.load(std::memory_order_relaxed);
  while (current != 0 && current != std::numeric_limits<uint64_t>::max()) {
    if (context->references.compare_exchange_weak(
            current, current + 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return VT_STATUS_OK;
    }
  }
  return current == 0 ? VT_STATUS_CLOSED : VT_STATUS_LIMIT_EXCEEDED;
}

void js_semiring_retain(void* raw_context) {
  (void)js_semiring_try_retain(static_cast<JsSemiringProviderContext*>(raw_context));
}

void js_semiring_release(void* raw_context) {
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  if (context == nullptr) return;
  uint64_t current = context->references.load(std::memory_order_acquire);
  while (current != 0) {
    if (!context->references.compare_exchange_weak(
            current, current - 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
      continue;
    }
    if (current != 1) return;
    if (std::this_thread::get_id() == context->owner_thread) {
      auto cleanup = context->cleanup;
      destroy_js_semiring_provider(context->env, nullptr, nullptr, context);
      (void)napi_release_threadsafe_function(cleanup, napi_tsfn_abort);
      return;
    }
    const auto queued = napi_call_threadsafe_function(
        context->cleanup, context, napi_tsfn_nonblocking);
    (void)napi_release_threadsafe_function(context->cleanup, napi_tsfn_release);
    if (queued != napi_ok) delete context;
    return;
  }
}

template <typename Operation>
VtStatus with_js_semiring_provider(
    JsSemiringProviderContext* context, Operation&& operation) noexcept {
  const auto retained = js_semiring_try_retain(context);
  if (retained != VT_STATUS_OK) return retained;
  if (std::this_thread::get_id() != context->owner_thread) {
    js_semiring_release(context);
    return VT_STATUS_PROVIDER_ERROR;
  }
  if (context->active.test_and_set(std::memory_order_acquire)) {
    js_semiring_release(context);
    return VT_STATUS_PROVIDER_ERROR;
  }
  struct CallbackLease {
    JsSemiringProviderContext* context;
    ~CallbackLease() {
      context->active.clear(std::memory_order_release);
      js_semiring_release(context);
    }
  } lease{context};
  return operation();
}

const VtResourceVTable* js_semiring_resource_table();

VtStatus js_semiring_query_interface(
    void* raw_context, const VtInterfaceId* interface_id,
    uint32_t minimum_version, const void** out_vtable) {
  if (raw_context == nullptr || interface_id == nullptr || out_vtable == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  *out_vtable = nullptr;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  const auto selected = [&](const VtInterfaceId& expected, uint32_t version,
                            const void* table, bool supported) {
    return supported && minimum_version <= version &&
           std::memcmp(interface_id->bytes, expected.bytes, sizeof(expected.bytes)) == 0
        ? table : nullptr;
  };
  *out_vtable = selected(VT_SEMIRING_INTERFACE_ID, VT_SEMIRING_INTERFACE_VERSION,
                         &context->semiring_table, true);
  if (*out_vtable == nullptr) {
    *out_vtable = selected(VT_SEMIRING_DIVISION_INTERFACE_ID,
        VT_SEMIRING_DIVISION_INTERFACE_VERSION, &context->division_table, context->division);
  }
  if (*out_vtable == nullptr) {
    *out_vtable = selected(VT_SEMIRING_STAR_INTERFACE_ID,
        VT_SEMIRING_STAR_INTERFACE_VERSION, &context->star_table, context->star);
  }
  if (*out_vtable == nullptr) {
    *out_vtable = selected(VT_SEMIRING_NUMERIC_INTERFACE_ID,
        VT_SEMIRING_NUMERIC_INTERFACE_VERSION, &context->numeric_table, context->numeric);
  }
  if (*out_vtable == nullptr) {
    *out_vtable = selected(VT_SEMIRING_PROPERTIES_INTERFACE_ID,
        VT_SEMIRING_PROPERTIES_INTERFACE_VERSION, &context->properties_table, true);
  }
  return *out_vtable == nullptr ? VT_STATUS_UNSUPPORTED : VT_STATUS_OK;
}

const VtResourceVTable* js_semiring_resource_table() {
  static const VtResourceVTable table{
      sizeof(VtResourceVTable), VT_ABI_VERSION, 0,
      js_semiring_retain, js_semiring_release, js_semiring_query_interface};
  return &table;
}

bool semiring_token_value(
    JsSemiringProviderContext* context, const VtSemiringValue* token,
    napi_value* output) {
  if (token == nullptr || token->word1 != context->cookie) return false;
  const uint32_t low = static_cast<uint32_t>(token->word0);
  const uint32_t generation = static_cast<uint32_t>(token->word0 >> 32);
  if (low == 0 || generation == 0) return false;
  const size_t index = static_cast<size_t>(low - 1);
  if (index >= context->slots.size()) return false;
  const auto& slot = context->slots[index];
  if (slot.value == nullptr || slot.generation != generation) return false;
  napi_value box;
  return napi_get_reference_value(context->env, slot.value, &box) == napi_ok &&
         napi_get_named_property(context->env, box, "value", output) == napi_ok;
}

bool semiring_store_value(
    JsSemiringProviderContext* context, napi_value value, VtSemiringValue* output) {
  if (output == nullptr) return false;
  uint32_t index = 0;
  if (!context->free_slots.empty()) {
    index = context->free_slots.back();
    context->free_slots.pop_back();
  } else {
    if (context->slots.size() >= kMaximumSemiringValues) return false;
    index = static_cast<uint32_t>(context->slots.size());
    context->slots.push_back(JsSemiringSlot{});
  }
  auto& slot = context->slots[index];
  // N-API references can only retain objects and functions. Semiring domains
  // commonly use primitive JavaScript values, so root a stable box and unwrap
  // its payload whenever the ABI token is resolved.
  napi_value box;
  if (napi_create_object(context->env, &box) != napi_ok ||
      napi_set_named_property(context->env, box, "value", value) != napi_ok ||
      napi_create_reference(context->env, box, 1, &slot.value) != napi_ok) {
    context->free_slots.push_back(index);
    clear_pending_exception(context->env);
    return false;
  }
  output->word0 = (static_cast<uint64_t>(slot.generation) << 32) |
                  static_cast<uint64_t>(index + 1);
  output->word1 = context->cookie;
  return true;
}

VtStatus semiring_constructor(
    void* raw_context, VtSemiringValue* out_value, const char* method) {
  if (out_value == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value result;
    return call_provider_method(context, method, 0, nullptr, &result) &&
                   semiring_store_value(context, result, out_value)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_zero(void* context, VtSemiringValue* output) {
  return semiring_constructor(context, output, "zero");
}

VtStatus js_semiring_one(void* context, VtSemiringValue* output) {
  return semiring_constructor(context, output, "one");
}

VtStatus js_semiring_clone(
    void* raw_context, const VtSemiringValue* value, VtSemiringValue* out_value) {
  if (value == nullptr || out_value == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value local;
    return semiring_token_value(context, value, &local) &&
                   semiring_store_value(context, local, out_value)
        ? VT_STATUS_OK : VT_STATUS_CLOSED;
  });
}

VtStatus js_semiring_release_values(
    void* raw_context, VtSemiringValue* values, size_t count) {
  if (count != 0 && values == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    for (size_t position = 0; position < count; ++position) {
      auto& token = values[position];
      napi_value ignored;
      if (!semiring_token_value(context, &token, &ignored)) return VT_STATUS_CLOSED;
      const uint32_t index = static_cast<uint32_t>(token.word0) - 1;
      auto& slot = context->slots[index];
      if (napi_delete_reference(context->env, slot.value) != napi_ok) {
        clear_pending_exception(context->env);
        return VT_STATUS_PROVIDER_ERROR;
      }
      slot.value = nullptr;
      slot.generation = slot.generation == UINT32_MAX ? 1 : slot.generation + 1;
      context->free_slots.push_back(index);
      token = VtSemiringValue{};
    }
    return VT_STATUS_OK;
  });
}

VtStatus semiring_binary(
    void* raw_context, const VtSemiringValue* left,
    const VtSemiringValue* right, VtSemiringValue* out_value,
    const char* method) {
  if (left == nullptr || right == nullptr || out_value == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value arguments[2], result;
    return semiring_token_value(context, left, &arguments[0]) &&
                   semiring_token_value(context, right, &arguments[1]) &&
                   call_provider_method(context, method, 2, arguments, &result) &&
                   semiring_store_value(context, result, out_value)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_plus(void* context, const VtSemiringValue* left,
                          const VtSemiringValue* right, VtSemiringValue* output) {
  return semiring_binary(context, left, right, output, "plus");
}

VtStatus js_semiring_times(void* context, const VtSemiringValue* left,
                           const VtSemiringValue* right, VtSemiringValue* output) {
  return semiring_binary(context, left, right, output, "times");
}

VtStatus semiring_comparison(
    void* raw_context, const VtSemiringValue* left,
    const VtSemiringValue* right, double epsilon, uint8_t* out_equal,
    const char* method, bool approximate) {
  if (left == nullptr || right == nullptr || out_equal == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value arguments[3], result;
    if (!semiring_token_value(context, left, &arguments[0]) ||
        !semiring_token_value(context, right, &arguments[1])) return VT_STATUS_CLOSED;
    size_t count = 2;
    if (approximate) {
      if (napi_create_double(context->env, epsilon, &arguments[2]) != napi_ok) {
        return VT_STATUS_PROVIDER_ERROR;
      }
      count = 3;
    }
    bool equal = false;
    if (!call_provider_method(context, method, count, arguments, &result) ||
        !js_boolean(context->env, result, &equal)) return VT_STATUS_PROVIDER_ERROR;
    *out_equal = equal ? 1 : 0;
    return VT_STATUS_OK;
  });
}

VtStatus js_semiring_equal(void* context, const VtSemiringValue* left,
    const VtSemiringValue* right, uint8_t* output) {
  return semiring_comparison(context, left, right, 0.0, output, "equal", false);
}

VtStatus js_semiring_approx_equal(void* context, const VtSemiringValue* left,
    const VtSemiringValue* right, double epsilon, uint8_t* output) {
  return semiring_comparison(
      context, left, right, epsilon, output, "approximatelyEqual", true);
}

VtStatus js_semiring_natural_order(
    void* raw_context, const VtSemiringValue* left,
    const VtSemiringValue* right, int32_t* out_order) {
  if (left == nullptr || right == nullptr || out_order == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value arguments[2], result;
    std::string order;
    if (!semiring_token_value(context, left, &arguments[0]) ||
        !semiring_token_value(context, right, &arguments[1]) ||
        !call_provider_method(context, "naturalOrder", 2, arguments, &result) ||
        !string(context->env, result, &order)) return VT_STATUS_PROVIDER_ERROR;
    if (order == "better") *out_order = VT_SEMIRING_ORDER_BETTER;
    else if (order == "equal") *out_order = VT_SEMIRING_ORDER_EQUAL;
    else if (order == "worse") *out_order = VT_SEMIRING_ORDER_WORSE;
    else if (order == "incomparable") *out_order = VT_SEMIRING_ORDER_INCOMPARABLE;
    else return VT_STATUS_PROVIDER_ERROR;
    return VT_STATUS_OK;
  });
}

VtStatus semiring_bytes(
    void* raw_context, const VtSemiringValue* value,
    uint8_t* out_bytes, size_t capacity, size_t* out_written,
    size_t* out_required, const char* method, bool diagnostic) {
  if (out_written == nullptr || out_required == nullptr ||
      (capacity != 0 && out_bytes == nullptr)) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value argument, result;
    size_t count = 0;
    if (value != nullptr) {
      if (!semiring_token_value(context, value, &argument)) return VT_STATUS_CLOSED;
      count = 1;
    }
    if (!call_provider_method(context, method, count, count == 0 ? nullptr : &argument, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    std::vector<uint8_t> copied;
    if (diagnostic) {
      std::string text;
      if (!string(context->env, result, &text)) return VT_STATUS_PROVIDER_ERROR;
      copied.assign(text.begin(), text.end());
    } else {
      void* data = nullptr;
      size_t length = 0;
      if (!typed_array(context->env, result, napi_uint8_array, &data, &length)) {
        return VT_STATUS_PROVIDER_ERROR;
      }
      copied.assign(static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + length);
    }
    if (copied.size() > kMaximumProviderBytes) return VT_STATUS_LIMIT_EXCEEDED;
    const size_t written = std::min(capacity, copied.size());
    if (written != 0) std::memcpy(out_bytes, copied.data(), written);
    *out_written = written;
    *out_required = copied.size();
    return VT_STATUS_OK;
  });
}

VtStatus js_semiring_stable_bytes(void* context, const VtSemiringValue* value,
    uint8_t* bytes, size_t capacity, size_t* written, size_t* required) {
  if (value == nullptr) return VT_STATUS_NULL_POINTER;
  return semiring_bytes(context, value, bytes, capacity, written, required,
                        "stableBytes", false);
}

VtStatus js_semiring_diagnostic(void* context, const VtSemiringValue* value,
    uint8_t* bytes, size_t capacity, size_t* written, size_t* required) {
  return semiring_bytes(context, value, bytes, capacity, written, required,
                        "diagnostic", true);
}

VtStatus semiring_many(void* raw_context, const VtSemiringValue* values,
    size_t count, VtSemiringValue* output, const char* method) {
  if ((count != 0 && values == nullptr) || output == nullptr) return VT_STATUS_NULL_POINTER;
  if (count > VT_RECOMMENDED_SEMIRING_BATCH) return VT_STATUS_LIMIT_EXCEEDED;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value array, result;
    if (napi_create_array_with_length(context->env, count, &array) != napi_ok) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    for (size_t index = 0; index < count; ++index) {
      napi_value local;
      if (!semiring_token_value(context, &values[index], &local) ||
          napi_set_element(context->env, array, static_cast<uint32_t>(index), local) != napi_ok) {
        return VT_STATUS_PROVIDER_ERROR;
      }
    }
    return call_provider_method(context, method, 1, &array, &result) &&
                   semiring_store_value(context, result, output)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_plus_many(void* context, const VtSemiringValue* values,
    size_t count, VtSemiringValue* output) {
  return semiring_many(context, values, count, output, "plusMany");
}

VtStatus js_semiring_times_many(void* context, const VtSemiringValue* values,
    size_t count, VtSemiringValue* output) {
  return semiring_many(context, values, count, output, "timesMany");
}

VtStatus semiring_optional_binary(void* raw_context,
    const VtSemiringValue* left, const VtSemiringValue* right,
    VtSemiringValue* output, const char* method) {
  if (left == nullptr || right == nullptr || output == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value arguments[2], result;
    if (!semiring_token_value(context, left, &arguments[0]) ||
        !semiring_token_value(context, right, &arguments[1]) ||
        !call_provider_method(context, method, 2, arguments, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    if (is_null(context->env, result)) return VT_STATUS_END;
    return semiring_store_value(context, result, output)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_divide(void* context, const VtSemiringValue* left,
    const VtSemiringValue* right, VtSemiringValue* output) {
  return semiring_optional_binary(context, left, right, output, "divide");
}

VtStatus js_semiring_left_divide(void* context, const VtSemiringValue* left,
    const VtSemiringValue* right, VtSemiringValue* output) {
  return semiring_optional_binary(context, left, right, output, "leftDivide");
}

VtStatus js_semiring_star(void* raw_context, const VtSemiringValue* value,
    VtSemiringValue* output) {
  if (value == nullptr || output == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value argument, result;
    if (!semiring_token_value(context, value, &argument) ||
        !call_provider_method(context, "star", 1, &argument, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    if (is_null(context->env, result)) return VT_STATUS_END;
    return semiring_store_value(context, result, output)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus semiring_numeric(void* raw_context, const VtSemiringValue* value,
    double* output, const char* method) {
  if (value == nullptr || output == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value argument, result;
    return semiring_token_value(context, value, &argument) &&
                   call_provider_method(context, method, 1, &argument, &result) &&
                   js_number(context->env, result, output)
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_numerical_value(void* context, const VtSemiringValue* value,
    double* output) {
  return semiring_numeric(context, value, output, "numericalValue");
}

VtStatus js_semiring_to_probability(void* context, const VtSemiringValue* value,
    double* output) {
  return semiring_numeric(context, value, output, "toProbability");
}

VtStatus js_semiring_quantize(void* raw_context, const VtSemiringValue* value,
    double epsilon, int64_t* output) {
  if (value == nullptr || output == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  return with_js_semiring_provider(context, [&]() {
    napi_value arguments[2], result;
    if (!semiring_token_value(context, value, &arguments[0]) ||
        napi_create_double(context->env, epsilon, &arguments[1]) != napi_ok ||
        !call_provider_method(context, "quantize", 2, arguments, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    bool lossless = false;
    return napi_get_value_bigint_int64(context->env, result, output, &lossless) == napi_ok && lossless
        ? VT_STATUS_OK : VT_STATUS_PROVIDER_ERROR;
  });
}

VtStatus js_semiring_closure_bound(
    void* raw_context, size_t* out_bound, uint8_t* out_known) {
  if (raw_context == nullptr || out_bound == nullptr || out_known == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  const auto* context = static_cast<JsSemiringProviderContext*>(raw_context);
  *out_bound = context->closure_bound;
  *out_known = context->closure_known ? 1 : 0;
  return VT_STATUS_OK;
}

bool semiring_provider_contract(napi_env env, napi_value provider,
    bool* stable, bool* batch, bool* division, bool* star, bool* numeric) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, provider, &type) != napi_ok || type != napi_object ||
      is_null(env, provider)) return false;
  bool present = false;
  for (const char* method : {"zero", "one", "plus", "times", "equal",
                             "approximatelyEqual", "naturalOrder", "diagnostic"}) {
    if (!provider_has_method(env, provider, method, &present) || !present) return false;
  }
  if (!provider_has_method(env, provider, "stableBytes", stable)) return false;
  bool plus_many = false, times_many = false;
  if (!provider_has_method(env, provider, "plusMany", &plus_many) ||
      !provider_has_method(env, provider, "timesMany", &times_many) ||
      plus_many != times_many) return false;
  *batch = plus_many;
  bool divide = false, left_divide = false;
  if (!provider_has_method(env, provider, "divide", &divide) ||
      !provider_has_method(env, provider, "leftDivide", &left_divide) ||
      divide != left_divide) return false;
  *division = divide;
  if (!provider_has_method(env, provider, "star", star)) return false;
  bool numerical = false, quantize = false, probability = false;
  if (!provider_has_method(env, provider, "numericalValue", &numerical) ||
      !provider_has_method(env, provider, "quantize", &quantize) ||
      !provider_has_method(env, provider, "toProbability", &probability) ||
      numerical != quantize || numerical != probability) return false;
  *numeric = numerical;
  return true;
}

JsSemiringProviderContext* create_js_semiring_context(napi_env env,
    napi_value provider, const VtInterfaceId& domain, uint64_t properties,
    bool closure_known, size_t closure_bound) {
  bool stable = false, batch = false, division = false, star = false, numeric = false;
  if (!semiring_provider_contract(
          env, provider, &stable, &batch, &division, &star, &numeric)) {
    clear_pending_exception(env);
    return nullptr;
  }
  auto* context = new JsSemiringProviderContext{};
  context->env = env;
  context->owner_thread = std::this_thread::get_id();
  context->cookie = reinterpret_cast<uintptr_t>(context) ^ UINT64_C(0x73656d6972696e67);
  if (context->cookie == 0) context->cookie = 1;
  context->division = division;
  context->star = star;
  context->numeric = numeric;
  context->closure_known = closure_known;
  context->closure_bound = closure_bound;
  if (napi_create_reference(env, provider, 1, &context->provider) != napi_ok) {
    delete context;
    return nullptr;
  }
  napi_value resource_name;
  auto status = napi_create_string_utf8(
      env, "Vinary Tree semiring provider", NAPI_AUTO_LENGTH, &resource_name);
  if (status == napi_ok) {
    status = napi_create_threadsafe_function(
        env, nullptr, nullptr, resource_name, 1, 1, nullptr, nullptr, nullptr,
        destroy_js_semiring_provider, &context->cleanup);
  }
  if (status != napi_ok) {
    (void)napi_delete_reference(env, context->provider);
    delete context;
    return nullptr;
  }
  uint64_t flags = VT_SEMIRING_FLAG_THREAD_BOUND;
  if (stable) flags |= VT_SEMIRING_FLAG_STABLE_BYTES;
  if (batch) flags |= VT_SEMIRING_FLAG_BATCH;
  context->semiring_table = VtSemiringVTable{
      sizeof(VtSemiringVTable), VT_SEMIRING_INTERFACE_VERSION, 0, flags, domain,
      js_semiring_zero, js_semiring_one, js_semiring_clone,
      js_semiring_release_values, js_semiring_plus, js_semiring_times,
      js_semiring_equal, js_semiring_approx_equal, js_semiring_natural_order,
      stable ? js_semiring_stable_bytes : nullptr, js_semiring_diagnostic,
      batch ? js_semiring_plus_many : nullptr,
      batch ? js_semiring_times_many : nullptr};
  context->division_table = VtSemiringDivisionVTable{
      sizeof(VtSemiringDivisionVTable), VT_SEMIRING_DIVISION_INTERFACE_VERSION, 0,
      division ? js_semiring_divide : nullptr,
      division ? js_semiring_left_divide : nullptr};
  context->star_table = VtSemiringStarVTable{
      sizeof(VtSemiringStarVTable), VT_SEMIRING_STAR_INTERFACE_VERSION, 0,
      star ? js_semiring_star : nullptr};
  context->numeric_table = VtSemiringNumericVTable{
      sizeof(VtSemiringNumericVTable), VT_SEMIRING_NUMERIC_INTERFACE_VERSION, 0,
      numeric ? js_semiring_numerical_value : nullptr,
      numeric ? js_semiring_quantize : nullptr,
      numeric ? js_semiring_to_probability : nullptr};
  context->properties_table = VtSemiringPropertiesVTable{
      sizeof(VtSemiringPropertiesVTable), VT_SEMIRING_PROPERTIES_INTERFACE_VERSION,
      0, properties, js_semiring_closure_bound};
  return context;
}

void semiring_finalize(napi_env, void* data, void*) {
  auto* handle = static_cast<SemiringHandle*>(data);
  if (handle->value != nullptr) lling_semiring_free(handle->value);
  delete handle;
}

void semiring_weight_finalize(napi_env, void* data, void*) {
  auto* handle = static_cast<SemiringWeightHandle*>(data);
  if (handle->value != nullptr) lling_semiring_weight_free(handle->value);
  delete handle;
}

napi_value semiring_external(napi_env env, LlingSemiring* value, uint64_t identity) {
  napi_value result;
  auto* handle = new SemiringHandle{value, identity};
  const auto status = napi_create_external(env, handle, semiring_finalize, nullptr, &result);
  if (status != napi_ok) {
    semiring_finalize(env, handle, nullptr);
    return fail_napi(env, "napi_create_external", status);
  }
  return result;
}

napi_value semiring_weight_external(
    napi_env env, LlingSemiringWeight* value, uint64_t identity) {
  napi_value result;
  auto* handle = new SemiringWeightHandle{value, identity};
  const auto status = napi_create_external(
      env, handle, semiring_weight_finalize, nullptr, &result);
  if (status != napi_ok) {
    semiring_weight_finalize(env, handle, nullptr);
    return fail_napi(env, "napi_create_external", status);
  }
  return result;
}

SemiringHandle* semiring_handle(napi_env env, napi_value value) {
  auto* handle = external<SemiringHandle>(env, value);
  if (handle == nullptr || handle->value == nullptr) {
    if (handle != nullptr) lling_error(env, LLING_STATUS_CLOSED);
    return nullptr;
  }
  return handle;
}

SemiringWeightHandle* semiring_weight_handle(
    napi_env env, napi_value value, uint64_t identity) {
  auto* handle = external<SemiringWeightHandle>(env, value);
  if (handle == nullptr || handle->value == nullptr || handle->identity != identity) {
    if (handle != nullptr && handle->value == nullptr) lling_error(env, LLING_STATUS_CLOSED);
    else if (handle != nullptr) napi_throw_type_error(
        env, nullptr, "semiring weight belongs to a different operation context");
    return nullptr;
  }
  return handle;
}

napi_value host_semiring_new(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 5);
  VtInterfaceId domain{};
  uint64_t properties = 0, bound = 0;
  bool closure_known = false;
  if (args.size() != 5 || !exact_domain_id(env, args[1], &domain) ||
      !uint64(env, args[2], &properties) ||
      !js_boolean(env, args[3], &closure_known) || !uint64(env, args[4], &bound) ||
      bound > std::numeric_limits<size_t>::max()) {
    napi_throw_type_error(env, nullptr, "invalid semiring provider options");
    return nullptr;
  }
  constexpr uint64_t known_properties = VT_SEMIRING_PROPERTY_HASHABLE |
      VT_SEMIRING_PROPERTY_IDEMPOTENT_PLUS | VT_SEMIRING_PROPERTY_K_CLOSED |
      VT_SEMIRING_PROPERTY_ZERO_SUM_FREE | VT_SEMIRING_PROPERTY_COMMUTATIVE_TIMES |
      VT_SEMIRING_PROPERTY_TOTALLY_ORDERED | VT_SEMIRING_PROPERTY_NONNEGATIVE;
  if ((properties & ~known_properties) != 0) {
    napi_throw_range_error(env, nullptr, "unknown semiring property bit");
    return nullptr;
  }
  auto* context = create_js_semiring_context(
      env, args[0], domain, properties, closure_known, static_cast<size_t>(bound));
  if (context == nullptr) {
    napi_throw_type_error(env, nullptr, "invalid semiring provider contract");
    return nullptr;
  }
  const VtResource resource{context, js_semiring_resource_table()};
  LlingSemiring* value = nullptr;
  const auto status = lling_semiring_open(&resource, &value);
  js_semiring_release(context);
  const uint64_t identity = next_semiring_identity.fetch_add(1, std::memory_order_relaxed);
  return status == LLING_STATUS_OK ? semiring_external(env, value, identity)
                                   : lling_error(env, status);
}

napi_value semiring_close(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* handle = args.size() == 1 ? external<SemiringHandle>(env, args[0]) : nullptr;
  if (handle == nullptr) return nullptr;
  if (handle->value != nullptr) lling_semiring_free(std::exchange(handle->value, nullptr));
  return undefined(env);
}

napi_value semiring_identity_weight(napi_env env, napi_callback_info info, bool zero) {
  const auto args = arguments(env, info, 1);
  auto* semiring = args.size() == 1 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  LlingSemiringWeight* output = nullptr;
  const auto status = zero ? lling_semiring_zero(semiring->value, &output)
                           : lling_semiring_one(semiring->value, &output);
  return status == LLING_STATUS_OK ? semiring_weight_external(env, output, semiring->identity)
                                   : lling_error(env, status);
}

napi_value semiring_zero(napi_env env, napi_callback_info info) {
  return semiring_identity_weight(env, info, true);
}

napi_value semiring_one(napi_env env, napi_callback_info info) {
  return semiring_identity_weight(env, info, false);
}

napi_value semiring_weight_close(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* handle = args.size() == 1 ? external<SemiringWeightHandle>(env, args[0]) : nullptr;
  if (handle == nullptr) return nullptr;
  if (handle->value != nullptr) {
    lling_semiring_weight_free(std::exchange(handle->value, nullptr));
  }
  return undefined(env);
}

napi_value semiring_weight_clone(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* source = args.size() == 1 ? external<SemiringWeightHandle>(env, args[0]) : nullptr;
  if (source == nullptr || source->value == nullptr) return lling_error(env, LLING_STATUS_CLOSED);
  LlingSemiringWeight* output = nullptr;
  const auto status = lling_semiring_weight_clone(source->value, &output);
  return status == LLING_STATUS_OK ? semiring_weight_external(env, output, source->identity)
                                   : lling_error(env, status);
}

napi_value semiring_binary_value(napi_env env, napi_callback_info info, bool plus) {
  const auto args = arguments(env, info, 3);
  auto* semiring = args.size() == 3 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* left = semiring_weight_handle(env, args[1], semiring->identity);
  auto* right = semiring_weight_handle(env, args[2], semiring->identity);
  if (left == nullptr || right == nullptr) return nullptr;
  LlingSemiringWeight* output = nullptr;
  const auto status = plus
      ? lling_semiring_plus(semiring->value, left->value, right->value, &output)
      : lling_semiring_times(semiring->value, left->value, right->value, &output);
  return status == LLING_STATUS_OK ? semiring_weight_external(env, output, semiring->identity)
                                   : lling_error(env, status);
}

napi_value semiring_plus(napi_env env, napi_callback_info info) {
  return semiring_binary_value(env, info, true);
}

napi_value semiring_times(napi_env env, napi_callback_info info) {
  return semiring_binary_value(env, info, false);
}

napi_value semiring_compare(napi_env env, napi_callback_info info, bool approximate) {
  const auto args = arguments(env, info, approximate ? 4 : 3);
  if (args.size() != (approximate ? 4u : 3u)) return nullptr;
  auto* semiring = semiring_handle(env, args[0]);
  if (semiring == nullptr) return nullptr;
  auto* left = semiring_weight_handle(env, args[1], semiring->identity);
  auto* right = semiring_weight_handle(env, args[2], semiring->identity);
  double epsilon = 0.0;
  if (left == nullptr || right == nullptr ||
      (approximate && !js_number(env, args[3], &epsilon))) return nullptr;
  uint8_t output = 0;
  const auto status = approximate
      ? lling_semiring_approx_equal(
            semiring->value, left->value, right->value, epsilon, &output)
      : lling_semiring_equal(semiring->value, left->value, right->value, &output);
  return status == LLING_STATUS_OK ? boolean(env, output != 0) : lling_error(env, status);
}

napi_value semiring_equal_value(napi_env env, napi_callback_info info) {
  return semiring_compare(env, info, false);
}

napi_value semiring_approximately_equal(napi_env env, napi_callback_info info) {
  return semiring_compare(env, info, true);
}

napi_value semiring_natural_order_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 3);
  auto* semiring = args.size() == 3 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* left = semiring_weight_handle(env, args[1], semiring->identity);
  auto* right = semiring_weight_handle(env, args[2], semiring->identity);
  if (left == nullptr || right == nullptr) return nullptr;
  int32_t output = 0;
  const auto status = lling_semiring_natural_order(
      semiring->value, left->value, right->value, &output);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  const char* order = output == -1 ? "better" : output == 0 ? "equal" :
                      output == 1 ? "worse" : output == 2 ? "incomparable" : nullptr;
  if (order == nullptr) {
    napi_throw_error(env, nullptr, "semiring returned an invalid natural order");
    return nullptr;
  }
  napi_value result;
  NAPI_OR_RETURN(env, napi_create_string_utf8(env, order, NAPI_AUTO_LENGTH, &result));
  return result;
}

napi_value semiring_read_bytes(napi_env env, SemiringHandle* semiring,
    SemiringWeightHandle* weight, bool diagnostic) {
  size_t written = 0, required = 0;
  const auto query = diagnostic
      ? lling_semiring_diagnostic(semiring->value, weight == nullptr ? nullptr : weight->value,
                                  nullptr, 0, &written, &required)
      : lling_semiring_stable_bytes(semiring->value, weight->value,
                                    nullptr, 0, &written, &required);
  if (query != LLING_STATUS_OK) return lling_error(env, query);
  if (written != 0 || required > kMaximumProviderBytes) {
    napi_throw_error(env, nullptr, "invalid semiring byte-buffer size response");
    return nullptr;
  }
  std::vector<uint8_t> bytes(required);
  const auto status = diagnostic
      ? lling_semiring_diagnostic(semiring->value, weight == nullptr ? nullptr : weight->value,
                                  bytes.empty() ? nullptr : bytes.data(), bytes.size(),
                                  &written, &required)
      : lling_semiring_stable_bytes(semiring->value, weight->value,
                                    bytes.empty() ? nullptr : bytes.data(), bytes.size(),
                                    &written, &required);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (written != bytes.size() || required != bytes.size()) {
    napi_throw_error(env, nullptr, "semiring byte-buffer size changed while copying");
    return nullptr;
  }
  if (!diagnostic) return byte_array(env, bytes.data(), bytes.size());
  napi_value result;
  NAPI_OR_RETURN(env, napi_create_string_utf8(
      env, reinterpret_cast<const char*>(bytes.data()), bytes.size(), &result));
  return result;
}

napi_value semiring_stable_bytes_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 2);
  auto* semiring = args.size() == 2 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* weight = semiring_weight_handle(env, args[1], semiring->identity);
  return weight == nullptr ? nullptr : semiring_read_bytes(env, semiring, weight, false);
}

napi_value semiring_diagnostic_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 2);
  auto* semiring = args.size() == 2 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  if (is_null(env, args[1])) return semiring_read_bytes(env, semiring, nullptr, true);
  auto* weight = semiring_weight_handle(env, args[1], semiring->identity);
  return weight == nullptr ? nullptr : semiring_read_bytes(env, semiring, weight, true);
}

bool semiring_weight_array(napi_env env, napi_value array, uint64_t identity,
    std::vector<const LlingSemiringWeight*>* output) {
  bool is_array = false;
  uint32_t length = 0;
  if (napi_is_array(env, array, &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, array, &length) != napi_ok ||
      length > VT_RECOMMENDED_SEMIRING_BATCH) return false;
  output->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    if (napi_get_element(env, array, index, &item) != napi_ok) return false;
    auto* handle = semiring_weight_handle(env, item, identity);
    if (handle == nullptr) return false;
    output->push_back(handle->value);
  }
  return true;
}

napi_value semiring_many_value(napi_env env, napi_callback_info info, bool plus) {
  const auto args = arguments(env, info, 2);
  auto* semiring = args.size() == 2 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  std::vector<const LlingSemiringWeight*> values;
  if (!semiring_weight_array(env, args[1], semiring->identity, &values)) {
    napi_throw_type_error(env, nullptr, "semiring operands must be an array of local weights");
    return nullptr;
  }
  LlingSemiringWeight* output = nullptr;
  const auto status = plus
      ? lling_semiring_plus_many(semiring->value, values.data(), values.size(), &output)
      : lling_semiring_times_many(semiring->value, values.data(), values.size(), &output);
  return status == LLING_STATUS_OK ? semiring_weight_external(env, output, semiring->identity)
                                   : lling_error(env, status);
}

napi_value semiring_plus_many(napi_env env, napi_callback_info info) {
  return semiring_many_value(env, info, true);
}

napi_value semiring_times_many(napi_env env, napi_callback_info info) {
  return semiring_many_value(env, info, false);
}

napi_value semiring_optional_binary_value(
    napi_env env, napi_callback_info info, bool left_divide) {
  const auto args = arguments(env, info, 3);
  auto* semiring = args.size() == 3 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* left = semiring_weight_handle(env, args[1], semiring->identity);
  auto* right = semiring_weight_handle(env, args[2], semiring->identity);
  if (left == nullptr || right == nullptr) return nullptr;
  LlingSemiringWeight* output = nullptr;
  uint8_t defined = 0;
  const auto status = left_divide
      ? lling_semiring_left_divide(
            semiring->value, left->value, right->value, &output, &defined)
      : lling_semiring_divide(
            semiring->value, left->value, right->value, &output, &defined);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (defined == 0) { napi_value result; napi_get_null(env, &result); return result; }
  return semiring_weight_external(env, output, semiring->identity);
}

napi_value semiring_divide(napi_env env, napi_callback_info info) {
  return semiring_optional_binary_value(env, info, false);
}

napi_value semiring_left_divide(napi_env env, napi_callback_info info) {
  return semiring_optional_binary_value(env, info, true);
}

napi_value semiring_star(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 2);
  auto* semiring = args.size() == 2 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* weight = semiring_weight_handle(env, args[1], semiring->identity);
  if (weight == nullptr) return nullptr;
  LlingSemiringWeight* output = nullptr;
  uint8_t defined = 0;
  const auto status = lling_semiring_star(
      semiring->value, weight->value, &output, &defined);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (defined == 0) { napi_value result; napi_get_null(env, &result); return result; }
  return semiring_weight_external(env, output, semiring->identity);
}

napi_value semiring_numeric_value(
    napi_env env, napi_callback_info info, const char* operation) {
  const auto args = arguments(env, info, 2);
  auto* semiring = args.size() == 2 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* weight = semiring_weight_handle(env, args[1], semiring->identity);
  if (weight == nullptr) return nullptr;
  double output = 0.0;
  const auto status = std::strcmp(operation, "numerical") == 0
      ? lling_semiring_numerical_value(semiring->value, weight->value, &output)
      : lling_semiring_to_probability(semiring->value, weight->value, &output);
  return status == LLING_STATUS_OK ? number(env, output) : lling_error(env, status);
}

napi_value semiring_numerical_value(napi_env env, napi_callback_info info) {
  return semiring_numeric_value(env, info, "numerical");
}

napi_value semiring_to_probability(napi_env env, napi_callback_info info) {
  return semiring_numeric_value(env, info, "probability");
}

napi_value semiring_quantize(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 3);
  auto* semiring = args.size() == 3 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  auto* weight = semiring_weight_handle(env, args[1], semiring->identity);
  double epsilon = 0.0;
  if (weight == nullptr || !js_number(env, args[2], &epsilon)) return nullptr;
  int64_t output = 0;
  const auto status = lling_semiring_quantize(
      semiring->value, weight->value, epsilon, &output);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  napi_value result;
  NAPI_OR_RETURN(env, napi_create_bigint_int64(env, output, &result));
  return result;
}

napi_value semiring_closure_bound(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* semiring = args.size() == 1 ? semiring_handle(env, args[0]) : nullptr;
  if (semiring == nullptr) return nullptr;
  size_t bound = 0;
  uint8_t known = 0;
  const auto status = lling_semiring_closure_bound(semiring->value, &bound, &known);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (known == 0) { napi_value result; napi_get_null(env, &result); return result; }
  return bigint(env, static_cast<uint64_t>(bound));
}

napi_value semiring_validate_laws(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 3);
  auto* semiring = args.size() == 3 ? semiring_handle(env, args[0]) : nullptr;
  double epsilon = 0.0;
  if (semiring == nullptr || !js_number(env, args[2], &epsilon)) return nullptr;
  std::vector<const LlingSemiringWeight*> values;
  if (!semiring_weight_array(env, args[1], semiring->identity, &values) || values.empty()) {
    napi_throw_type_error(env, nullptr, "semiring law samples must contain local weights");
    return nullptr;
  }
  const auto status = lling_semiring_validate_laws(
      semiring->value, values.data(), values.size(), epsilon);
  return status == LLING_STATUS_OK ? undefined(env) : lling_error(env, status);
}
