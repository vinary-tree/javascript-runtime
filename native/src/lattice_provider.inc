constexpr size_t kMaximumProviderBytes = 16 * 1024 * 1024;

struct JsLatticeProviderContext {
  std::atomic<uint64_t> references{1};
  std::atomic_flag active = ATOMIC_FLAG_INIT;
  napi_env env{};
  napi_ref provider{};
  napi_threadsafe_function cleanup{};
  std::thread::id owner_thread;
  VtLatticeVTable lattice_table{};
};

void destroy_js_lattice_provider(napi_env env, napi_value, void*, void* data) {
  auto* context = static_cast<JsLatticeProviderContext*>(data);
  if (env != nullptr && context->provider != nullptr) {
    (void)napi_delete_reference(env, context->provider);
  }
  delete context;
}

VtStatus js_lattice_try_retain(JsLatticeProviderContext* context) {
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

void js_lattice_retain(void* raw_context) {
  (void)js_lattice_try_retain(static_cast<JsLatticeProviderContext*>(raw_context));
}

void js_lattice_release(void* raw_context) {
  auto* context = static_cast<JsLatticeProviderContext*>(raw_context);
  if (context == nullptr) return;
  uint64_t current = context->references.load(std::memory_order_acquire);
  while (current != 0) {
    if (!context->references.compare_exchange_weak(
            current, current - 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
      continue;
    }
    if (current != 1) return;
    if (std::this_thread::get_id() == context->owner_thread) {
      if (context->provider != nullptr) {
        (void)napi_delete_reference(context->env, context->provider);
        context->provider = nullptr;
      }
      (void)napi_release_threadsafe_function(context->cleanup, napi_tsfn_abort);
      delete context;
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
VtStatus with_js_lattice_provider(
    JsLatticeProviderContext* context, Operation&& operation) noexcept {
  const auto retained = js_lattice_try_retain(context);
  if (retained != VT_STATUS_OK) return retained;
  if (std::this_thread::get_id() != context->owner_thread) {
    js_lattice_release(context);
    return VT_STATUS_PROVIDER_ERROR;
  }
  if (context->active.test_and_set(std::memory_order_acquire)) {
    js_lattice_release(context);
    return VT_STATUS_PROVIDER_ERROR;
  }
  struct CallbackLease {
    JsLatticeProviderContext* context;
    ~CallbackLease() {
      context->active.clear(std::memory_order_release);
      js_lattice_release(context);
    }
  } lease{context};
  return operation();
}

const VtResourceVTable* js_lattice_resource_table();

VtStatus js_lattice_query_interface(
    void* raw_context, const VtInterfaceId* interface_id,
    uint32_t minimum_version, const void** out_vtable) {
  if (raw_context == nullptr || interface_id == nullptr || out_vtable == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  *out_vtable = nullptr;
  auto* context = static_cast<JsLatticeProviderContext*>(raw_context);
  if (minimum_version > VT_LATTICE_INTERFACE_VERSION ||
      std::memcmp(interface_id->bytes, VT_LATTICE_INTERFACE_ID.bytes,
                  sizeof(interface_id->bytes)) != 0) {
    return VT_STATUS_UNSUPPORTED;
  }
  *out_vtable = &context->lattice_table;
  return VT_STATUS_OK;
}

const VtResourceVTable* js_lattice_resource_table() {
  static const VtResourceVTable table{
      sizeof(VtResourceVTable), VT_ABI_VERSION, 0,
      js_lattice_retain, js_lattice_release, js_lattice_query_interface};
  return &table;
}

bool exact_domain_id(napi_env env, napi_value value, VtInterfaceId* output) {
  std::string encoded;
  if (!string(env, value, &encoded) || encoded.size() != sizeof(output->bytes)) return false;
  for (const unsigned char character : encoded) {
    if (character < 0x20 || character > 0x7e) return false;
  }
  std::memcpy(output->bytes, encoded.data(), sizeof(output->bytes));
  return true;
}

bool lattice_provider_contract(
    napi_env env, napi_value provider, bool* stable, bool* batch) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, provider, &type) != napi_ok || type != napi_object ||
      is_null(env, provider)) {
    return false;
  }
  bool present = false;
  for (const char* method : {"join", "meet", "equal", "diagnostic"}) {
    if (!provider_has_method(env, provider, method, &present) || !present) return false;
  }
  if (!provider_has_method(env, provider, "stableBytes", stable)) return false;
  bool join_many = false;
  bool meet_many = false;
  if (!provider_has_method(env, provider, "joinMany", &join_many) ||
      !provider_has_method(env, provider, "meetMany", &meet_many) ||
      join_many != meet_many) {
    return false;
  }
  *batch = join_many;
  return true;
}

VtStatus js_lattice_join(
    void* raw_context, const VtResource* other, VtResource* out_value);
VtStatus js_lattice_meet(
    void* raw_context, const VtResource* other, VtResource* out_value);
VtStatus js_lattice_equal(
    void* raw_context, const VtResource* other, uint8_t* out_equal);
VtStatus js_lattice_stable_bytes(
    void* raw_context, uint8_t* out_bytes, size_t capacity,
    size_t* out_written, size_t* out_required);
VtStatus js_lattice_diagnostic(
    void* raw_context, uint8_t* out_bytes, size_t capacity,
    size_t* out_written, size_t* out_required);
VtStatus js_lattice_join_many(
    void* raw_context, const VtResource* others, size_t count, VtResource* out_value);
VtStatus js_lattice_meet_many(
    void* raw_context, const VtResource* others, size_t count, VtResource* out_value);

JsLatticeProviderContext* create_js_lattice_context(
    napi_env env, napi_value provider, const VtInterfaceId& domain) {
  bool stable = false;
  bool batch = false;
  if (!lattice_provider_contract(env, provider, &stable, &batch)) {
    clear_pending_exception(env);
    return nullptr;
  }
  uint64_t flags = VT_LATTICE_FLAG_THREAD_BOUND;
  if (stable) flags |= VT_LATTICE_FLAG_STABLE_BYTES;
  if (batch) flags |= VT_LATTICE_FLAG_BATCH;
  auto* context = new JsLatticeProviderContext{};
  context->env = env;
  context->owner_thread = std::this_thread::get_id();
  if (napi_create_reference(env, provider, 1, &context->provider) != napi_ok) {
    clear_pending_exception(env);
    delete context;
    return nullptr;
  }
  napi_value resource_name;
  auto status = napi_create_string_utf8(
      env, "Vinary Tree lattice provider", NAPI_AUTO_LENGTH, &resource_name);
  if (status == napi_ok) {
    status = napi_create_threadsafe_function(
        env, nullptr, nullptr, resource_name, 1, 1, nullptr, nullptr, nullptr,
        destroy_js_lattice_provider, &context->cleanup);
  }
  if (status != napi_ok) {
    (void)napi_delete_reference(env, context->provider);
    context->provider = nullptr;
    clear_pending_exception(env);
    delete context;
    return nullptr;
  }
  context->lattice_table = VtLatticeVTable{
      sizeof(VtLatticeVTable),
      VT_LATTICE_INTERFACE_VERSION,
      0,
      flags,
      domain,
      js_lattice_join,
      js_lattice_meet,
      js_lattice_equal,
      stable ? js_lattice_stable_bytes : nullptr,
      js_lattice_diagnostic,
      batch ? js_lattice_join_many : nullptr,
      batch ? js_lattice_meet_many : nullptr,
  };
  return context;
}

bool copy_lattice_bytes(
    const VtResource& resource, const VtLatticeVTable& table,
    std::vector<uint8_t>* output) {
  if ((table.flags & VT_LATTICE_FLAG_STABLE_BYTES) == 0 ||
      table.stable_bytes == nullptr) {
    return false;
  }
  size_t written = 0;
  size_t required = 0;
  auto status = table.stable_bytes(
      resource.context, nullptr, 0, &written, &required);
  if (status != VT_STATUS_OK || written != 0 || required > kMaximumProviderBytes) {
    return false;
  }
  output->resize(required);
  status = table.stable_bytes(
      resource.context, required == 0 ? nullptr : output->data(), output->size(),
      &written, &required);
  return status == VT_STATUS_OK && written == output->size() &&
         required == output->size();
}

napi_value byte_array(napi_env env, const uint8_t* data, size_t length) {
  napi_value buffer;
  void* destination = nullptr;
  if (napi_create_arraybuffer(env, length, &destination, &buffer) != napi_ok) return nullptr;
  if (length != 0) std::memcpy(destination, data, length);
  napi_value result;
  if (napi_create_typedarray(
          env, napi_uint8_array, length, buffer, 0, &result) != napi_ok) {
    return nullptr;
  }
  return result;
}

bool lattice_operand(
    JsLatticeProviderContext* receiver, const VtResource& resource,
    napi_value* output) {
  if (resource.context == nullptr || resource.vtable == nullptr) return false;
  const void* raw_table = nullptr;
  const auto query = resource.vtable->query_interface(
      resource.context, &VT_LATTICE_INTERFACE_ID,
      VT_LATTICE_INTERFACE_VERSION, &raw_table);
  if (query != VT_STATUS_OK || raw_table == nullptr) return false;
  const auto* table = static_cast<const VtLatticeVTable*>(raw_table);
  if (std::memcmp(table->domain_id.bytes, receiver->lattice_table.domain_id.bytes,
                  sizeof(table->domain_id.bytes)) != 0) {
    return false;
  }

  napi_value object;
  if (napi_create_object(receiver->env, &object) != napi_ok) return false;
  napi_value domain;
  if (napi_create_string_utf8(
          receiver->env,
          reinterpret_cast<const char*>(table->domain_id.bytes),
          sizeof(table->domain_id.bytes), &domain) != napi_ok) {
    return false;
  }
  property(receiver->env, object, "domainId", domain);

  napi_value local;
  if (resource.vtable == js_lattice_resource_table()) {
    auto* context = static_cast<JsLatticeProviderContext*>(resource.context);
    if (context->env != receiver->env ||
        napi_get_reference_value(receiver->env, context->provider, &local) != napi_ok) {
      return false;
    }
  } else if (napi_get_null(receiver->env, &local) != napi_ok) {
    return false;
  }
  property(receiver->env, object, "localValue", local);

  napi_value stable_bytes;
  std::vector<uint8_t> bytes;
  if (resource.vtable != js_lattice_resource_table() &&
      (table->flags & VT_LATTICE_FLAG_STABLE_BYTES) != 0) {
    if (!copy_lattice_bytes(resource, *table, &bytes)) return false;
    stable_bytes = byte_array(receiver->env, bytes.data(), bytes.size());
    if (stable_bytes == nullptr) return false;
  } else if (napi_get_null(receiver->env, &stable_bytes) != napi_ok) {
    return false;
  }
  property(receiver->env, object, "stableBytes", stable_bytes);
  *output = object;
  return true;
}

VtStatus js_lattice_binary(
    void* raw_context, const VtResource* other, VtResource* out_value,
    const char* method) {
  if (other == nullptr || out_value == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsLatticeProviderContext*>(raw_context);
  return with_js_lattice_provider(context, [&]() {
    napi_value operand;
    napi_value result;
    if (!lattice_operand(context, *other, &operand) ||
        !call_provider_method(context, method, 1, &operand, &result)) {
      clear_pending_exception(context->env);
      return VT_STATUS_PROVIDER_ERROR;
    }
    auto* result_context = create_js_lattice_context(
        context->env, result, context->lattice_table.domain_id);
    if (result_context == nullptr) return VT_STATUS_PROVIDER_ERROR;
    *out_value = VtResource{result_context, js_lattice_resource_table()};
    return VT_STATUS_OK;
  });
}

VtStatus js_lattice_join(
    void* context, const VtResource* other, VtResource* output) {
  return js_lattice_binary(context, other, output, "join");
}

VtStatus js_lattice_meet(
    void* context, const VtResource* other, VtResource* output) {
  return js_lattice_binary(context, other, output, "meet");
}

VtStatus js_lattice_equal(
    void* raw_context, const VtResource* other, uint8_t* out_equal) {
  if (other == nullptr || out_equal == nullptr) return VT_STATUS_NULL_POINTER;
  auto* context = static_cast<JsLatticeProviderContext*>(raw_context);
  return with_js_lattice_provider(context, [&]() {
    napi_value operand;
    napi_value result;
    bool equal = false;
    if (!lattice_operand(context, *other, &operand) ||
        !call_provider_method(context, "equal", 1, &operand, &result) ||
        !js_boolean(context->env, result, &equal)) {
      clear_pending_exception(context->env);
      return VT_STATUS_PROVIDER_ERROR;
    }
    *out_equal = equal ? 1 : 0;
    return VT_STATUS_OK;
  });
}

VtStatus write_provider_bytes(
    JsLatticeProviderContext* context, const char* method,
    uint8_t* out_bytes, size_t capacity,
    size_t* out_written, size_t* out_required, bool diagnostic) {
  if (out_written == nullptr || out_required == nullptr ||
      (capacity != 0 && out_bytes == nullptr)) {
    return VT_STATUS_NULL_POINTER;
  }
  return with_js_lattice_provider(context, [&]() {
    napi_value result;
    std::vector<uint8_t> copied;
    if (!call_provider_method(context, method, 0, nullptr, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    if (diagnostic) {
      std::string text;
      if (!string(context->env, result, &text) || text.size() > kMaximumProviderBytes) {
        clear_pending_exception(context->env);
        return VT_STATUS_PROVIDER_ERROR;
      }
      copied.assign(text.begin(), text.end());
    } else {
      void* data = nullptr;
      size_t length = 0;
      if (!typed_array(
              context->env, result, napi_uint8_array, &data, &length) ||
          length > kMaximumProviderBytes) {
        clear_pending_exception(context->env);
        return VT_STATUS_PROVIDER_ERROR;
      }
      copied.assign(
          static_cast<const uint8_t*>(data),
          static_cast<const uint8_t*>(data) + length);
    }
    const size_t written = std::min(capacity, copied.size());
    if (written != 0) std::memcpy(out_bytes, copied.data(), written);
    *out_written = written;
    *out_required = copied.size();
    return VT_STATUS_OK;
  });
}

VtStatus js_lattice_stable_bytes(
    void* raw_context, uint8_t* out_bytes, size_t capacity,
    size_t* out_written, size_t* out_required) {
  return write_provider_bytes(
      static_cast<JsLatticeProviderContext*>(raw_context), "stableBytes",
      out_bytes, capacity, out_written, out_required, false);
}

VtStatus js_lattice_diagnostic(
    void* raw_context, uint8_t* out_bytes, size_t capacity,
    size_t* out_written, size_t* out_required) {
  return write_provider_bytes(
      static_cast<JsLatticeProviderContext*>(raw_context), "diagnostic",
      out_bytes, capacity, out_written, out_required, true);
}

VtStatus js_lattice_many(
    void* raw_context, const VtResource* others, size_t count,
    VtResource* out_value, const char* method) {
  if ((count != 0 && others == nullptr) || out_value == nullptr) {
    return VT_STATUS_NULL_POINTER;
  }
  if (count > VT_RECOMMENDED_LATTICE_BATCH) return VT_STATUS_LIMIT_EXCEEDED;
  auto* context = static_cast<JsLatticeProviderContext*>(raw_context);
  return with_js_lattice_provider(context, [&]() {
    napi_value array;
    if (napi_create_array_with_length(context->env, count, &array) != napi_ok) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    for (size_t index = 0; index < count; ++index) {
      napi_value operand;
      if (!lattice_operand(context, others[index], &operand) ||
          napi_set_element(
              context->env, array, static_cast<uint32_t>(index), operand) != napi_ok) {
        clear_pending_exception(context->env);
        return VT_STATUS_PROVIDER_ERROR;
      }
    }
    napi_value result;
    if (!call_provider_method(context, method, 1, &array, &result)) {
      return VT_STATUS_PROVIDER_ERROR;
    }
    auto* result_context = create_js_lattice_context(
        context->env, result, context->lattice_table.domain_id);
    if (result_context == nullptr) return VT_STATUS_PROVIDER_ERROR;
    *out_value = VtResource{result_context, js_lattice_resource_table()};
    return VT_STATUS_OK;
  });
}

VtStatus js_lattice_join_many(
    void* context, const VtResource* others, size_t count, VtResource* output) {
  return js_lattice_many(context, others, count, output, "joinMany");
}

VtStatus js_lattice_meet_many(
    void* context, const VtResource* others, size_t count, VtResource* output) {
  return js_lattice_many(context, others, count, output, "meetMany");
}

void lattice_finalize(napi_env, void* data, void*) {
  auto* handle = static_cast<LatticeHandle*>(data);
  if (handle->value != nullptr) lling_lattice_free(handle->value);
  delete handle;
}

napi_value lattice_external(napi_env env, LlingLatticeValue* value) {
  napi_value result;
  auto* handle = new LatticeHandle{value};
  const auto status = napi_create_external(
      env, handle, lattice_finalize, nullptr, &result);
  if (status != napi_ok) {
    lattice_finalize(env, handle, nullptr);
    return fail_napi(env, "napi_create_external", status);
  }
  return result;
}

napi_value host_lattice_new(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 2);
  VtInterfaceId domain{};
  if (args.size() != 2 || !exact_domain_id(env, args[1], &domain)) {
    napi_throw_type_error(env, nullptr, "lattice provider requires a 16-byte ASCII domain");
    return nullptr;
  }
  auto* context = create_js_lattice_context(env, args[0], domain);
  if (context == nullptr) {
    napi_throw_type_error(env, nullptr, "invalid lattice provider contract");
    return nullptr;
  }
  const VtResource resource{context, js_lattice_resource_table()};
  LlingLatticeValue* value = nullptr;
  const auto status = lling_lattice_open(&resource, &value);
  js_lattice_release(context);
  return status == LLING_STATUS_OK ? lattice_external(env, value)
                                   : lling_error(env, status);
}

LatticeHandle* lattice_handle(napi_env env, napi_value value) {
  auto* handle = external<LatticeHandle>(env, value);
  if (handle == nullptr || handle->value == nullptr) {
    if (handle != nullptr) lling_error(env, LLING_STATUS_CLOSED);
    return nullptr;
  }
  return handle;
}

napi_value lattice_close(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* handle = args.size() == 1 ? external<LatticeHandle>(env, args[0]) : nullptr;
  if (handle == nullptr) return nullptr;
  if (handle->value != nullptr) {
    lling_lattice_free(std::exchange(handle->value, nullptr));
  }
  return undefined(env);
}

napi_value lattice_binary(napi_env env, napi_callback_info info, bool join) {
  const auto args = arguments(env, info, 2);
  auto* left = args.size() == 2 ? lattice_handle(env, args[0]) : nullptr;
  auto* right = args.size() == 2 ? lattice_handle(env, args[1]) : nullptr;
  if (left == nullptr || right == nullptr) return nullptr;
  LlingLatticeValue* output = nullptr;
  const auto status = join
      ? lling_lattice_join(left->value, right->value, &output)
      : lling_lattice_meet(left->value, right->value, &output);
  return status == LLING_STATUS_OK ? lattice_external(env, output)
                                   : lling_error(env, status);
}

napi_value lattice_join(napi_env env, napi_callback_info info) {
  return lattice_binary(env, info, true);
}

napi_value lattice_meet(napi_env env, napi_callback_info info) {
  return lattice_binary(env, info, false);
}

napi_value lattice_equal_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 2);
  auto* left = args.size() == 2 ? lattice_handle(env, args[0]) : nullptr;
  auto* right = args.size() == 2 ? lattice_handle(env, args[1]) : nullptr;
  if (left == nullptr || right == nullptr) return nullptr;
  uint8_t equal = 0;
  const auto status = lling_lattice_equal(left->value, right->value, &equal);
  return status == LLING_STATUS_OK ? boolean(env, equal != 0)
                                   : lling_error(env, status);
}

napi_value read_lattice_bytes(
    napi_env env, LatticeHandle* handle, bool diagnostic) {
  size_t written = 0;
  size_t required = 0;
  auto status = diagnostic
      ? lling_lattice_diagnostic(
            handle->value, nullptr, 0, &written, &required)
      : lling_lattice_stable_bytes(
            handle->value, nullptr, 0, &written, &required);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (written != 0 || required > kMaximumProviderBytes) {
    napi_throw_error(env, nullptr, "lattice provider returned invalid byte metadata");
    return nullptr;
  }
  std::vector<uint8_t> bytes(required);
  status = diagnostic
      ? lling_lattice_diagnostic(
            handle->value, required == 0 ? nullptr : bytes.data(), bytes.size(),
            &written, &required)
      : lling_lattice_stable_bytes(
            handle->value, required == 0 ? nullptr : bytes.data(), bytes.size(),
            &written, &required);
  if (status != LLING_STATUS_OK) return lling_error(env, status);
  if (written != bytes.size() || required != bytes.size()) {
    napi_throw_error(env, nullptr, "lattice provider changed byte length");
    return nullptr;
  }
  if (!diagnostic) return byte_array(env, bytes.data(), bytes.size());
  napi_value result;
  const auto string_status = napi_create_string_utf8(
      env, reinterpret_cast<const char*>(bytes.data()), bytes.size(), &result);
  if (string_status != napi_ok) {
    return fail_napi(env, "napi_create_string_utf8", string_status);
  }
  return result;
}

napi_value lattice_stable_bytes_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* handle = args.size() == 1 ? lattice_handle(env, args[0]) : nullptr;
  return handle == nullptr ? nullptr : read_lattice_bytes(env, handle, false);
}

napi_value lattice_diagnostic_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  auto* handle = args.size() == 1 ? lattice_handle(env, args[0]) : nullptr;
  return handle == nullptr ? nullptr : read_lattice_bytes(env, handle, true);
}

bool lattice_handle_array(
    napi_env env, napi_value value, std::vector<LlingLatticeValue*>* output) {
  bool array = false;
  uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length > VT_RECOMMENDED_LATTICE_BATCH) {
    return false;
  }
  output->clear();
  output->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    if (napi_get_element(env, value, index, &item) != napi_ok) return false;
    auto* handle = lattice_handle(env, item);
    if (handle == nullptr) return false;
    output->push_back(handle->value);
  }
  return true;
}

napi_value lattice_many_value(
    napi_env env, napi_callback_info info, bool join) {
  const auto args = arguments(env, info, 2);
  auto* receiver = args.size() == 2 ? lattice_handle(env, args[0]) : nullptr;
  std::vector<LlingLatticeValue*> others;
  if (receiver == nullptr || !lattice_handle_array(env, args[1], &others)) {
    if (receiver != nullptr) {
      napi_throw_type_error(env, nullptr, "lattice fold requires at most 256 values");
    }
    return nullptr;
  }
  std::vector<const LlingLatticeValue*> borrowed(others.begin(), others.end());
  LlingLatticeValue* output = nullptr;
  const auto status = join
      ? lling_lattice_join_many(
            receiver->value, borrowed.data(), borrowed.size(), &output)
      : lling_lattice_meet_many(
            receiver->value, borrowed.data(), borrowed.size(), &output);
  return status == LLING_STATUS_OK ? lattice_external(env, output)
                                   : lling_error(env, status);
}

napi_value lattice_join_many_value(napi_env env, napi_callback_info info) {
  return lattice_many_value(env, info, true);
}

napi_value lattice_meet_many_value(napi_env env, napi_callback_info info) {
  return lattice_many_value(env, info, false);
}

napi_value lattice_validate_laws_value(napi_env env, napi_callback_info info) {
  const auto args = arguments(env, info, 1);
  std::vector<LlingLatticeValue*> values;
  if (args.size() != 1 || !lattice_handle_array(env, args[0], &values)) {
    napi_throw_type_error(env, nullptr, "lattice law sample must contain at most 256 values");
    return nullptr;
  }
  std::vector<const LlingLatticeValue*> borrowed(values.begin(), values.end());
  const auto status = lling_lattice_validate_laws(
      borrowed.data(), borrowed.size());
  return status == LLING_STATUS_OK ? undefined(env) : lling_error(env, status);
}
