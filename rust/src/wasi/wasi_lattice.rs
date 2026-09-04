//! WASI preview-1 fallback for JavaScript-defined immutable lattice values.
//!
//! The preview-1 transport cannot pass native vtable pointers into JavaScript.
//! Instead, Rust resources contain generational host-table handles and proxy
//! each bounded operation through explicit imports. The process-global Rust
//! registry is never held across a provider callback.

use super::*;
use lling_llang::dynamic_lattice::DynamicLatticeValue;
use vinary_tree_interop::{
    lattice_flags, VtLatticeVTable, VT_LATTICE_INTERFACE_ID, VT_LATTICE_INTERFACE_VERSION,
    VT_RECOMMENDED_LATTICE_BATCH,
};

const MAXIMUM_PROVIDER_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_LAW_SAMPLES: usize = 16;
const LATTICE_JOIN: u32 = 1;
const LATTICE_MEET: u32 = 2;
const LATTICE_STABLE_BYTES: u32 = 1;
const LATTICE_DIAGNOSTIC: u32 = 2;

#[link(wasm_import_module = "vinary_tree_host")]
extern "C" {
    #[link_name = "host_lattice_binary"]
    fn call_host_lattice_binary(
        receiver: u32,
        other: u32,
        operation: u32,
        out_handle: *mut u32,
        out_flags: *mut u64,
    ) -> u32;
    #[link_name = "host_lattice_equal"]
    fn call_host_lattice_equal(receiver: u32, other: u32, out_equal: *mut u8) -> u32;
    #[link_name = "host_lattice_bytes"]
    fn call_host_lattice_bytes(
        handle: u32,
        operation: u32,
        out_bytes: *mut u8,
        capacity: usize,
        out_written: *mut usize,
        out_required: *mut usize,
    ) -> u32;
    #[link_name = "host_lattice_many"]
    fn call_host_lattice_many(
        receiver: u32,
        others: *const u32,
        count: usize,
        operation: u32,
        out_handle: *mut u32,
        out_flags: *mut u64,
    ) -> u32;
}

struct HostLatticeContext {
    retains: Cell<usize>,
    host_handle: u32,
    table: VtLatticeVTable,
}

struct HostOwnedLatticeResource(VtResource);

// WASI preview 1 runs this fallback as a single-threaded reactor. These
// markers only permit storage in the process-global handle table; no lattice
// callback can execute concurrently on another thread.
unsafe impl Send for HostOwnedLatticeResource {}
unsafe impl Sync for HostOwnedLatticeResource {}

impl HostOwnedLatticeResource {
    fn new(host_handle: u32, domain_id: VtInterfaceId, flags: u64) -> Result<Self, &'static str> {
        lattice_resource(host_handle, domain_id, flags).map(Self)
    }

    fn as_raw(&self) -> VtResource {
        self.0
    }
}

impl Drop for HostOwnedLatticeResource {
    fn drop(&mut self) {
        unsafe { host_lattice_release(self.0.context) }
    }
}

fn lattice_resource(
    host_handle: u32,
    domain_id: VtInterfaceId,
    flags: u64,
) -> Result<VtResource, &'static str> {
    if host_handle == 0 || host_handle == FAILURE {
        return Err("invalid host lattice handle");
    }
    let allowed = lattice_flags::THREAD_BOUND | lattice_flags::STABLE_BYTES | lattice_flags::BATCH;
    if flags & !allowed != 0 || flags & lattice_flags::THREAD_BOUND == 0 {
        return Err("invalid WASI host lattice flags");
    }
    let context = Box::new(HostLatticeContext {
        retains: Cell::new(1),
        host_handle,
        table: VtLatticeVTable {
            struct_size: std::mem::size_of::<VtLatticeVTable>(),
            interface_version: VT_LATTICE_INTERFACE_VERSION,
            reserved: 0,
            flags,
            domain_id,
            join: Some(host_lattice_join),
            meet: Some(host_lattice_meet),
            equal: Some(host_lattice_equal),
            stable_bytes: (flags & lattice_flags::STABLE_BYTES != 0)
                .then_some(host_lattice_stable_bytes),
            diagnostic: Some(host_lattice_diagnostic),
            join_many: (flags & lattice_flags::BATCH != 0).then_some(host_lattice_join_many),
            meet_many: (flags & lattice_flags::BATCH != 0).then_some(host_lattice_meet_many),
        },
    });
    Ok(VtResource {
        context: Box::into_raw(context).cast(),
        vtable: &HOST_LATTICE_RESOURCE_VTABLE,
    })
}

unsafe extern "C" fn host_lattice_retain(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let context = &*context.cast::<HostLatticeContext>();
    if let Some(next) = context.retains.get().checked_add(1) {
        context.retains.set(next);
    }
}

unsafe extern "C" fn host_lattice_release(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let context = context.cast::<HostLatticeContext>();
    let retains = (*context).retains.get();
    if retains == 0 {
        return;
    }
    if retains == 1 {
        let context = Box::from_raw(context);
        host_provider_release(context.host_handle);
    } else {
        (*context).retains.set(retains - 1);
    }
}

unsafe extern "C" fn host_lattice_query_interface(
    context: *mut c_void,
    interface_id: *const VtInterfaceId,
    minimum_version: u32,
    out_vtable: *mut *const c_void,
) -> u32 {
    if context.is_null() || interface_id.is_null() || out_vtable.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    out_vtable.write(std::ptr::null());
    if (*interface_id).bytes != VT_LATTICE_INTERFACE_ID.bytes
        || minimum_version > VT_LATTICE_INTERFACE_VERSION
    {
        return VtStatus::Unsupported.to_raw();
    }
    let context = &*context.cast::<HostLatticeContext>();
    out_vtable.write((&context.table as *const VtLatticeVTable).cast());
    VtStatus::Ok.to_raw()
}

static HOST_LATTICE_RESOURCE_VTABLE: VtResourceVTable = VtResourceVTable {
    struct_size: std::mem::size_of::<VtResourceVTable>(),
    abi_version: VT_ABI_VERSION,
    reserved: 0,
    retain: Some(host_lattice_retain),
    release: Some(host_lattice_release),
    query_interface: Some(host_lattice_query_interface),
};

unsafe fn host_operand(
    resource: *const VtResource,
    domain_id: VtInterfaceId,
) -> Result<u32, VtStatus> {
    if resource.is_null() || (*resource).context.is_null() || (*resource).vtable.is_null() {
        return Err(VtStatus::NullPointer);
    }
    if !std::ptr::eq((*resource).vtable, &HOST_LATTICE_RESOURCE_VTABLE) {
        return Err(VtStatus::Unsupported);
    }
    let context = &*(*resource).context.cast::<HostLatticeContext>();
    if context.table.domain_id.bytes != domain_id.bytes {
        return Err(VtStatus::InvalidArgument);
    }
    Ok(context.host_handle)
}

unsafe fn host_result(
    domain_id: VtInterfaceId,
    out_value: *mut VtResource,
    invoke: impl FnOnce(*mut u32, *mut u64) -> u32,
) -> u32 {
    if out_value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let mut host_handle = 0;
    let mut flags = 0;
    let status = invoke(&mut host_handle, &mut flags);
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) {
        if host_handle != 0 && host_handle != FAILURE {
            host_provider_release(host_handle);
        }
        return status;
    }
    match lattice_resource(host_handle, domain_id, flags) {
        Ok(resource) => {
            out_value.write(resource);
            VtStatus::Ok.to_raw()
        }
        Err(_) => {
            if host_handle != 0 && host_handle != FAILURE {
                host_provider_release(host_handle);
            }
            VtStatus::ProviderError.to_raw()
        }
    }
}

unsafe fn host_lattice_binary_operation(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
    operation: u32,
) -> u32 {
    if context.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostLatticeContext>();
    let other = match host_operand(other, context.table.domain_id) {
        Ok(handle) => handle,
        Err(status) => return status.to_raw(),
    };
    host_result(
        context.table.domain_id,
        out_value,
        |out_handle, out_flags| {
            call_host_lattice_binary(context.host_handle, other, operation, out_handle, out_flags)
        },
    )
}

unsafe extern "C" fn host_lattice_join(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
) -> u32 {
    host_lattice_binary_operation(context, other, out_value, LATTICE_JOIN)
}

unsafe extern "C" fn host_lattice_meet(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
) -> u32 {
    host_lattice_binary_operation(context, other, out_value, LATTICE_MEET)
}

unsafe extern "C" fn host_lattice_equal(
    context: *mut c_void,
    other: *const VtResource,
    out_equal: *mut u8,
) -> u32 {
    if context.is_null() || out_equal.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostLatticeContext>();
    let other = match host_operand(other, context.table.domain_id) {
        Ok(handle) => handle,
        Err(status) => return status.to_raw(),
    };
    call_host_lattice_equal(context.host_handle, other, out_equal)
}

unsafe fn host_lattice_bytes(
    context: *mut c_void,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
    operation: u32,
) -> u32 {
    if context.is_null()
        || out_written.is_null()
        || out_required.is_null()
        || (capacity != 0 && out_bytes.is_null())
    {
        return VtStatus::NullPointer.to_raw();
    }
    call_host_lattice_bytes(
        (*context.cast::<HostLatticeContext>()).host_handle,
        operation,
        out_bytes,
        capacity,
        out_written,
        out_required,
    )
}

unsafe extern "C" fn host_lattice_stable_bytes(
    context: *mut c_void,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    host_lattice_bytes(
        context,
        out_bytes,
        capacity,
        out_written,
        out_required,
        LATTICE_STABLE_BYTES,
    )
}

unsafe extern "C" fn host_lattice_diagnostic(
    context: *mut c_void,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    host_lattice_bytes(
        context,
        out_bytes,
        capacity,
        out_written,
        out_required,
        LATTICE_DIAGNOSTIC,
    )
}

unsafe fn host_lattice_fold(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
    operation: u32,
) -> u32 {
    if context.is_null() || (count != 0 && others.is_null()) {
        return VtStatus::NullPointer.to_raw();
    }
    if count > VT_RECOMMENDED_LATTICE_BATCH {
        return VtStatus::LimitExceeded.to_raw();
    }
    let context = &*context.cast::<HostLatticeContext>();
    let resources = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(others, count)
    };
    let mut handles = Vec::with_capacity(resources.len());
    for resource in resources {
        match host_operand(resource, context.table.domain_id) {
            Ok(handle) => handles.push(handle),
            Err(status) => return status.to_raw(),
        }
    }
    host_result(
        context.table.domain_id,
        out_value,
        |out_handle, out_flags| {
            call_host_lattice_many(
                context.host_handle,
                handles.as_ptr(),
                handles.len(),
                operation,
                out_handle,
                out_flags,
            )
        },
    )
}

unsafe extern "C" fn host_lattice_join_many(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
) -> u32 {
    host_lattice_fold(context, others, count, out_value, LATTICE_JOIN)
}

unsafe extern "C" fn host_lattice_meet_many(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
) -> u32 {
    host_lattice_fold(context, others, count, out_value, LATTICE_MEET)
}

/// One closeable guest handle around a same-thread dynamic lattice value.
pub(super) struct WasiLattice {
    value: DynamicLatticeValue,
    encoded: Vec<u8>,
}

// The fallback is single-threaded, but `Mutex<Registry>` requires stored
// values to be `Send`. The dynamic value never crosses a reactor thread.
unsafe impl Send for WasiLattice {}

fn capture_lattice(handle: u32) -> Result<DynamicLatticeValue, String> {
    let registry = locked_registry();
    match registry.handles.get(&handle) {
        Some(Handle::Lattice(lattice)) => Ok(lattice.value.clone()),
        _ => Err("invalid lattice handle".into()),
    }
}

fn capture_lattices(handles: &[u32]) -> Result<Vec<DynamicLatticeValue>, String> {
    let registry = locked_registry();
    handles
        .iter()
        .map(|handle| match registry.handles.get(handle) {
            Some(Handle::Lattice(lattice)) => Ok(lattice.value.clone()),
            _ => Err("invalid lattice handle".into()),
        })
        .collect()
}

unsafe fn handle_words(pointer: u32, count: u32) -> Result<Vec<u32>, &'static str> {
    if count != 0 && pointer == 0 {
        return Err("lattice handle pointer is null");
    }
    let byte_length = count
        .checked_mul(4)
        .ok_or("lattice handle byte length overflow")?;
    Ok(bytes(pointer, byte_length)
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
        .collect())
}

fn insert_lattice(value: DynamicLatticeValue) -> u32 {
    locked_registry().insert(Handle::Lattice(WasiLattice {
        value,
        encoded: Vec::new(),
    }))
}

/// Adopt one JavaScript provider-table retain as a dynamic lattice value.
#[no_mangle]
pub unsafe extern "C" fn vt_host_lattice_new(
    host_handle: u32,
    domain_pointer: u32,
    domain_length: u32,
    flags: u64,
) -> u32 {
    let result = (|| {
        if domain_length != 16 || domain_pointer == 0 {
            return Err("lattice domain must contain exactly 16 bytes".to_string());
        }
        let domain = bytes(domain_pointer, domain_length);
        if domain.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
            return Err("lattice domain must contain printable ASCII".to_string());
        }
        let mut domain_id = VtInterfaceId { bytes: [0; 16] };
        domain_id.bytes.copy_from_slice(domain);
        let resource =
            HostOwnedLatticeResource::new(host_handle, domain_id, flags).map_err(str::to_owned)?;
        let value = DynamicLatticeValue::borrow_raw(resource.as_raw())
            .map_err(|error| error.to_string())?;
        Ok(value)
    })();
    match result {
        Ok(value) => insert_lattice(value),
        Err(error) => locked_registry().fail(error),
    }
}

fn binary_lattice(left: u32, right: u32, join: bool) -> u32 {
    let result = (|| {
        let left = capture_lattice(left)?;
        let right = capture_lattice(right)?;
        if join {
            left.join(&right)
        } else {
            left.meet(&right)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => insert_lattice(value),
        Err(error) => locked_registry().fail(error),
    }
}

/// Return the least upper bound of two same-domain guest handles.
#[no_mangle]
pub extern "C" fn vt_lattice_join(left: u32, right: u32) -> u32 {
    binary_lattice(left, right, true)
}

/// Return the greatest lower bound of two same-domain guest handles.
#[no_mangle]
pub extern "C" fn vt_lattice_meet(left: u32, right: u32) -> u32 {
    binary_lattice(left, right, false)
}

/// Return exact semantic equality for two same-domain guest handles.
#[no_mangle]
pub extern "C" fn vt_lattice_equal(left: u32, right: u32) -> u32 {
    let result = (|| {
        let left = capture_lattice(left)?;
        let right = capture_lattice(right)?;
        left.equal(&right).map_err(|error| error.to_string())
    })();
    match result {
        Ok(equal) => u32::from(equal),
        Err(error) => locked_registry().fail(error),
    }
}

unsafe fn fold_lattice(receiver: u32, pointer: u32, count: u32, join: bool) -> u32 {
    if count as usize > VT_RECOMMENDED_LATTICE_BATCH {
        return locked_registry().fail("lattice fold accepts at most 256 values");
    }
    let handles = match handle_words(pointer, count) {
        Ok(handles) => handles,
        Err(error) => return locked_registry().fail(error),
    };
    let result = (|| {
        let receiver = capture_lattice(receiver)?;
        let others = capture_lattices(&handles)?;
        if join {
            receiver.join_many(&others)
        } else {
            receiver.meet_many(&others)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => insert_lattice(value),
        Err(error) => locked_registry().fail(error),
    }
}

/// Fold joins over a bounded array of guest handles.
#[no_mangle]
pub unsafe extern "C" fn vt_lattice_join_many(receiver: u32, pointer: u32, count: u32) -> u32 {
    fold_lattice(receiver, pointer, count, true)
}

/// Fold meets over a bounded array of guest handles.
#[no_mangle]
pub unsafe extern "C" fn vt_lattice_meet_many(receiver: u32, pointer: u32, count: u32) -> u32 {
    fold_lattice(receiver, pointer, count, false)
}

/// Probe the lattice laws over one to sixteen representative guest values.
#[no_mangle]
pub unsafe extern "C" fn vt_lattice_validate_laws(pointer: u32, count: u32) -> u32 {
    if count == 0 || count as usize > MAXIMUM_LAW_SAMPLES {
        return locked_registry().fail("lattice law validation accepts one through sixteen values");
    }
    let result = handle_words(pointer, count)
        .map_err(str::to_owned)
        .and_then(|handles| capture_lattices(&handles))
        .and_then(|values| {
            DynamicLatticeValue::validate_laws(&values).map_err(|error| error.to_string())
        });
    match result {
        Ok(()) => 0,
        Err(error) => locked_registry().fail(error),
    }
}

fn encode_lattice(handle: u32, diagnostic: bool) -> u32 {
    let result = capture_lattice(handle).and_then(|value| {
        if diagnostic {
            value
                .diagnostic()
                .map(String::into_bytes)
                .map_err(|error| error.to_string())
        } else {
            value.stable_bytes().map_err(|error| error.to_string())
        }
    });
    let mut registry = locked_registry();
    match result {
        Ok(encoded) if encoded.len() <= MAXIMUM_PROVIDER_BYTES => {
            match registry.handles.get_mut(&handle) {
                Some(Handle::Lattice(lattice)) => {
                    lattice.encoded = encoded;
                    lattice.encoded.len() as u32
                }
                _ => registry.fail("lattice was closed during its provider callback"),
            }
        }
        Ok(_) => registry.fail("lattice provider bytes exceed the defensive limit"),
        Err(error) => registry.fail(error),
    }
}

/// Materialize canonical provider bytes into the guest handle's bounded buffer.
#[no_mangle]
pub extern "C" fn vt_lattice_stable_bytes(handle: u32) -> u32 {
    encode_lattice(handle, false)
}

/// Materialize the provider diagnostic into the guest handle's bounded buffer.
#[no_mangle]
pub extern "C" fn vt_lattice_diagnostic(handle: u32) -> u32 {
    encode_lattice(handle, true)
}

/// Return the current per-handle lattice byte-buffer pointer.
#[no_mangle]
pub extern "C" fn vt_lattice_bytes_pointer(handle: u32) -> u32 {
    let mut registry = locked_registry();
    match registry.handles.get(&handle) {
        Some(Handle::Lattice(lattice)) => lattice.encoded.as_ptr() as u32,
        _ => registry.fail("invalid lattice handle"),
    }
}
