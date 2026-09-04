//! WASI preview-1 transport for JavaScript-defined semiring contexts.
//!
//! Guest tokens contain bounded generational handles owned by the JavaScript
//! provider table. The Rust registry is never held across a host callback.

use super::*;
use lling_llang::dynamic_semiring::{DynamicSemiringContext, DynamicSemiringWeight};
use std::sync::Arc;
use vinary_tree_interop::{
    semiring_flags, VtSemiringDivisionVTable, VtSemiringNumericVTable, VtSemiringPropertiesVTable,
    VtSemiringStarVTable, VtSemiringVTable, VtSemiringValue, VT_RECOMMENDED_SEMIRING_BATCH,
    VT_SEMIRING_DIVISION_INTERFACE_ID, VT_SEMIRING_DIVISION_INTERFACE_VERSION,
    VT_SEMIRING_INTERFACE_ID, VT_SEMIRING_INTERFACE_VERSION, VT_SEMIRING_NUMERIC_INTERFACE_ID,
    VT_SEMIRING_NUMERIC_INTERFACE_VERSION, VT_SEMIRING_PROPERTIES_INTERFACE_ID,
    VT_SEMIRING_PROPERTIES_INTERFACE_VERSION, VT_SEMIRING_STAR_INTERFACE_ID,
    VT_SEMIRING_STAR_INTERFACE_VERSION,
};

const MAXIMUM_PROVIDER_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_LAW_SAMPLES: usize = 16;
const CAPABILITY_DIVISION: u32 = 1;
const CAPABILITY_STAR: u32 = 2;
const CAPABILITY_NUMERIC: u32 = 4;
const OP_ZERO: u32 = 1;
const OP_ONE: u32 = 2;
const OP_PLUS: u32 = 1;
const OP_TIMES: u32 = 2;
const OP_EQUAL: u32 = 1;
const OP_APPROX_EQUAL: u32 = 2;
const OP_STABLE_BYTES: u32 = 1;
const OP_DIAGNOSTIC: u32 = 2;
const OP_DIVIDE: u32 = 1;
const OP_LEFT_DIVIDE: u32 = 2;
const OP_NUMERICAL_VALUE: u32 = 1;
const OP_TO_PROBABILITY: u32 = 2;

#[link(wasm_import_module = "vinary_tree_host")]
extern "C" {
    fn host_semiring_construct(context: u32, operation: u32, out_value: *mut u32) -> u32;
    fn host_semiring_clone(context: u32, value: u32, out_value: *mut u32) -> u32;
    fn host_semiring_value_release(context: u32, value: u32) -> u32;
    fn host_semiring_binary(
        context: u32,
        left: u32,
        right: u32,
        operation: u32,
        out_value: *mut u32,
    ) -> u32;
    fn host_semiring_compare(
        context: u32,
        left: u32,
        right: u32,
        operation: u32,
        epsilon: f64,
        out_equal: *mut u8,
    ) -> u32;
    fn host_semiring_order(context: u32, left: u32, right: u32, out_order: *mut i32) -> u32;
    fn host_semiring_bytes(
        context: u32,
        value: u32,
        operation: u32,
        out_bytes: *mut u8,
        capacity: usize,
        out_written: *mut usize,
        out_required: *mut usize,
    ) -> u32;
    fn host_semiring_many(
        context: u32,
        values: *const u32,
        count: usize,
        operation: u32,
        out_value: *mut u32,
    ) -> u32;
    fn host_semiring_optional(
        context: u32,
        left: u32,
        right: u32,
        operation: u32,
        out_value: *mut u32,
        out_defined: *mut u8,
    ) -> u32;
    fn host_semiring_star(
        context: u32,
        value: u32,
        out_value: *mut u32,
        out_defined: *mut u8,
    ) -> u32;
    fn host_semiring_numeric(context: u32, value: u32, operation: u32, out_value: *mut f64) -> u32;
    fn host_semiring_quantize(context: u32, value: u32, epsilon: f64, out_value: *mut i64) -> u32;
    fn host_semiring_closure_bound(context: u32, out_bound: *mut usize, out_known: *mut u8) -> u32;
}

struct HostSemiringContext {
    retains: Cell<usize>,
    host_handle: u32,
    table: VtSemiringVTable,
    division: Option<VtSemiringDivisionVTable>,
    star: Option<VtSemiringStarVTable>,
    numeric: Option<VtSemiringNumericVTable>,
    properties: VtSemiringPropertiesVTable,
}

struct HostOwnedSemiringResource(VtResource);

unsafe impl Send for HostOwnedSemiringResource {}
unsafe impl Sync for HostOwnedSemiringResource {}

impl Drop for HostOwnedSemiringResource {
    fn drop(&mut self) {
        unsafe { semiring_release(self.0.context) }
    }
}

fn token_handle(context: &HostSemiringContext, value: &VtSemiringValue) -> Result<u32, VtStatus> {
    if value.word1 != u64::from(context.host_handle)
        || value.word0 == 0
        || value.word0 > u64::from(u32::MAX - 1)
    {
        return Err(VtStatus::InvalidArgument);
    }
    Ok(value.word0 as u32)
}

unsafe fn write_host_token(
    context: &HostSemiringContext,
    output: *mut VtSemiringValue,
    invoke: impl FnOnce(*mut u32) -> u32,
) -> u32 {
    if output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let mut handle = 0;
    let status = invoke(&mut handle);
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) {
        if handle != 0 && handle != FAILURE {
            host_provider_release(handle);
        }
        return status;
    }
    if handle == 0 || handle == FAILURE {
        return VtStatus::ProviderError.to_raw();
    }
    output.write(VtSemiringValue {
        word0: u64::from(handle),
        word1: u64::from(context.host_handle),
    });
    VtStatus::Ok.to_raw()
}

unsafe extern "C" fn semiring_retain(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let context = &*context.cast::<HostSemiringContext>();
    if let Some(next) = context.retains.get().checked_add(1) {
        context.retains.set(next);
    }
}

unsafe extern "C" fn semiring_release(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    let context = context.cast::<HostSemiringContext>();
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

unsafe extern "C" fn semiring_query_interface(
    context: *mut c_void,
    interface_id: *const VtInterfaceId,
    minimum_version: u32,
    out_vtable: *mut *const c_void,
) -> u32 {
    if context.is_null() || interface_id.is_null() || out_vtable.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    out_vtable.write(std::ptr::null());
    let context = &*context.cast::<HostSemiringContext>();
    let id = *interface_id;
    let selected: *const c_void =
        if id == VT_SEMIRING_INTERFACE_ID && minimum_version <= VT_SEMIRING_INTERFACE_VERSION {
            (&context.table as *const VtSemiringVTable).cast()
        } else if id == VT_SEMIRING_DIVISION_INTERFACE_ID
            && minimum_version <= VT_SEMIRING_DIVISION_INTERFACE_VERSION
        {
            context.division.as_ref().map_or(std::ptr::null(), |table| {
                (table as *const VtSemiringDivisionVTable).cast()
            })
        } else if id == VT_SEMIRING_STAR_INTERFACE_ID
            && minimum_version <= VT_SEMIRING_STAR_INTERFACE_VERSION
        {
            context.star.as_ref().map_or(std::ptr::null(), |table| {
                (table as *const VtSemiringStarVTable).cast()
            })
        } else if id == VT_SEMIRING_NUMERIC_INTERFACE_ID
            && minimum_version <= VT_SEMIRING_NUMERIC_INTERFACE_VERSION
        {
            context.numeric.as_ref().map_or(std::ptr::null(), |table| {
                (table as *const VtSemiringNumericVTable).cast()
            })
        } else if id == VT_SEMIRING_PROPERTIES_INTERFACE_ID
            && minimum_version <= VT_SEMIRING_PROPERTIES_INTERFACE_VERSION
        {
            (&context.properties as *const VtSemiringPropertiesVTable).cast()
        } else {
            std::ptr::null()
        };
    if selected.is_null() {
        VtStatus::Unsupported.to_raw()
    } else {
        out_vtable.write(selected);
        VtStatus::Ok.to_raw()
    }
}

static SEMIRING_RESOURCE_VTABLE: VtResourceVTable = VtResourceVTable {
    struct_size: std::mem::size_of::<VtResourceVTable>(),
    abi_version: VT_ABI_VERSION,
    reserved: 0,
    retain: Some(semiring_retain),
    release: Some(semiring_release),
    query_interface: Some(semiring_query_interface),
};

unsafe fn semiring_construct(
    context: *mut c_void,
    output: *mut VtSemiringValue,
    operation: u32,
) -> u32 {
    if context.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    write_host_token(context, output, |out| {
        host_semiring_construct(context.host_handle, operation, out)
    })
}

unsafe extern "C" fn semiring_zero(context: *mut c_void, output: *mut VtSemiringValue) -> u32 {
    semiring_construct(context, output, OP_ZERO)
}

unsafe extern "C" fn semiring_one(context: *mut c_void, output: *mut VtSemiringValue) -> u32 {
    semiring_construct(context, output, OP_ONE)
}

unsafe extern "C" fn semiring_clone(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    if context.is_null() || value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let value = match token_handle(context, &*value) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    write_host_token(context, output, |out| {
        host_semiring_clone(context.host_handle, value, out)
    })
}

unsafe extern "C" fn semiring_release_values(
    context: *mut c_void,
    values: *mut VtSemiringValue,
    count: usize,
) -> u32 {
    if context.is_null() || (count != 0 && values.is_null()) {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let values = if count == 0 {
        &mut [][..]
    } else {
        std::slice::from_raw_parts_mut(values, count)
    };
    let handles = match values
        .iter()
        .map(|value| token_handle(context, value))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(handles) => handles,
        Err(status) => return status.to_raw(),
    };
    for (value, handle) in values.iter_mut().zip(handles) {
        let status = host_semiring_value_release(context.host_handle, handle);
        if VtStatus::from_raw(status) != Some(VtStatus::Ok) {
            return status;
        }
        *value = VtSemiringValue::default();
    }
    VtStatus::Ok.to_raw()
}

unsafe fn semiring_binary_operation(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
    operation: u32,
) -> u32 {
    if context.is_null() || left.is_null() || right.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let left = match token_handle(context, &*left) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let right = match token_handle(context, &*right) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    write_host_token(context, output, |out| {
        host_semiring_binary(context.host_handle, left, right, operation, out)
    })
}

unsafe extern "C" fn semiring_plus(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_binary_operation(context, left, right, output, OP_PLUS)
}

unsafe extern "C" fn semiring_times(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_binary_operation(context, left, right, output, OP_TIMES)
}

unsafe fn semiring_compare_operation(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    epsilon: f64,
    output: *mut u8,
    operation: u32,
) -> u32 {
    if context.is_null() || left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let left = match token_handle(context, &*left) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let right = match token_handle(context, &*right) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    host_semiring_compare(context.host_handle, left, right, operation, epsilon, output)
}

unsafe extern "C" fn semiring_equal(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut u8,
) -> u32 {
    semiring_compare_operation(context, left, right, 0.0, output, OP_EQUAL)
}

unsafe extern "C" fn semiring_approximately_equal(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    epsilon: f64,
    output: *mut u8,
) -> u32 {
    semiring_compare_operation(context, left, right, epsilon, output, OP_APPROX_EQUAL)
}

unsafe extern "C" fn semiring_natural_order(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut i32,
) -> u32 {
    if context.is_null() || left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let left = match token_handle(context, &*left) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let right = match token_handle(context, &*right) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    host_semiring_order(context.host_handle, left, right, output)
}

unsafe fn semiring_bytes(
    context: *mut c_void,
    value: *const VtSemiringValue,
    operation: u32,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
    required: *mut usize,
) -> u32 {
    if context.is_null()
        || written.is_null()
        || required.is_null()
        || (capacity != 0 && output.is_null())
    {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let value = if value.is_null() {
        0
    } else {
        match token_handle(context, &*value) {
            Ok(value) => value,
            Err(status) => return status.to_raw(),
        }
    };
    host_semiring_bytes(
        context.host_handle,
        value,
        operation,
        output,
        capacity,
        written,
        required,
    )
}

unsafe extern "C" fn semiring_stable_bytes(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
    required: *mut usize,
) -> u32 {
    if value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    semiring_bytes(
        context,
        value,
        OP_STABLE_BYTES,
        output,
        capacity,
        written,
        required,
    )
}

unsafe extern "C" fn semiring_diagnostic(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
    required: *mut usize,
) -> u32 {
    semiring_bytes(
        context,
        value,
        OP_DIAGNOSTIC,
        output,
        capacity,
        written,
        required,
    )
}

unsafe fn semiring_many_operation(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
    operation: u32,
) -> u32 {
    if context.is_null() || (count != 0 && values.is_null()) {
        return VtStatus::NullPointer.to_raw();
    }
    if count > VT_RECOMMENDED_SEMIRING_BATCH {
        return VtStatus::LimitExceeded.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let values = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(values, count)
    };
    let handles = match values
        .iter()
        .map(|value| token_handle(context, value))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(handles) => handles,
        Err(status) => return status.to_raw(),
    };
    write_host_token(context, output, |out| {
        host_semiring_many(
            context.host_handle,
            handles.as_ptr(),
            handles.len(),
            operation,
            out,
        )
    })
}

unsafe extern "C" fn semiring_plus_many(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_many_operation(context, values, count, output, OP_PLUS)
}

unsafe extern "C" fn semiring_times_many(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_many_operation(context, values, count, output, OP_TIMES)
}

unsafe fn semiring_optional_operation(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
    operation: u32,
) -> u32 {
    if context.is_null() || left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let left = match token_handle(context, &*left) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let right = match token_handle(context, &*right) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let mut handle = 0;
    let mut defined = u8::MAX;
    let status = host_semiring_optional(
        context.host_handle,
        left,
        right,
        operation,
        &mut handle,
        &mut defined,
    );
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) {
        if handle != 0 && handle != FAILURE {
            host_provider_release(handle);
        }
        return status;
    }
    match defined {
        0 if handle == 0 => VtStatus::End.to_raw(),
        1 if handle != 0 && handle != FAILURE => {
            output.write(VtSemiringValue {
                word0: u64::from(handle),
                word1: u64::from(context.host_handle),
            });
            VtStatus::Ok.to_raw()
        }
        _ => {
            if handle != 0 && handle != FAILURE {
                host_provider_release(handle);
            }
            VtStatus::ProviderError.to_raw()
        }
    }
}

unsafe extern "C" fn semiring_divide(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_optional_operation(context, left, right, output, OP_DIVIDE)
}

unsafe extern "C" fn semiring_left_divide(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_optional_operation(context, left, right, output, OP_LEFT_DIVIDE)
}

unsafe extern "C" fn semiring_star_operation(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    if context.is_null() || value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let value = match token_handle(context, &*value) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    let mut handle = 0;
    let mut defined = u8::MAX;
    let status = host_semiring_star(context.host_handle, value, &mut handle, &mut defined);
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) {
        if handle != 0 && handle != FAILURE {
            host_provider_release(handle);
        }
        return status;
    }
    match defined {
        0 if handle == 0 => VtStatus::End.to_raw(),
        1 if handle != 0 && handle != FAILURE => {
            output.write(VtSemiringValue {
                word0: u64::from(handle),
                word1: u64::from(context.host_handle),
            });
            VtStatus::Ok.to_raw()
        }
        _ => {
            if handle != 0 && handle != FAILURE {
                host_provider_release(handle);
            }
            VtStatus::ProviderError.to_raw()
        }
    }
}

unsafe fn semiring_numeric_operation(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
    operation: u32,
) -> u32 {
    if context.is_null() || value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let value = match token_handle(context, &*value) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    host_semiring_numeric(context.host_handle, value, operation, output)
}

unsafe extern "C" fn semiring_numerical_value(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
) -> u32 {
    semiring_numeric_operation(context, value, output, OP_NUMERICAL_VALUE)
}

unsafe extern "C" fn semiring_to_probability(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
) -> u32 {
    semiring_numeric_operation(context, value, output, OP_TO_PROBABILITY)
}

unsafe extern "C" fn semiring_quantize_operation(
    context: *mut c_void,
    value: *const VtSemiringValue,
    epsilon: f64,
    output: *mut i64,
) -> u32 {
    if context.is_null() || value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<HostSemiringContext>();
    let value = match token_handle(context, &*value) {
        Ok(value) => value,
        Err(status) => return status.to_raw(),
    };
    host_semiring_quantize(context.host_handle, value, epsilon, output)
}

unsafe extern "C" fn semiring_closure_bound_operation(
    context: *mut c_void,
    output: *mut usize,
    known: *mut u8,
) -> u32 {
    if context.is_null() || output.is_null() || known.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    host_semiring_closure_bound(
        (*context.cast::<HostSemiringContext>()).host_handle,
        output,
        known,
    )
}

fn semiring_resource(
    host_handle: u32,
    domain_id: VtInterfaceId,
    flags: u64,
    capabilities: u32,
    properties: u64,
) -> Result<VtResource, &'static str> {
    if host_handle == 0 || host_handle == FAILURE {
        return Err("invalid host semiring handle");
    }
    let allowed_flags =
        semiring_flags::THREAD_BOUND | semiring_flags::STABLE_BYTES | semiring_flags::BATCH;
    if flags & !allowed_flags != 0 || flags & semiring_flags::THREAD_BOUND == 0 {
        return Err("invalid WASI host semiring flags");
    }
    if capabilities & !(CAPABILITY_DIVISION | CAPABILITY_STAR | CAPABILITY_NUMERIC) != 0 {
        return Err("invalid WASI host semiring capabilities");
    }
    let division = capabilities & CAPABILITY_DIVISION != 0;
    let star = capabilities & CAPABILITY_STAR != 0;
    let numeric = capabilities & CAPABILITY_NUMERIC != 0;
    let batch = flags & semiring_flags::BATCH != 0;
    let stable = flags & semiring_flags::STABLE_BYTES != 0;
    let context = Box::new(HostSemiringContext {
        retains: Cell::new(1),
        host_handle,
        table: VtSemiringVTable {
            struct_size: std::mem::size_of::<VtSemiringVTable>(),
            interface_version: VT_SEMIRING_INTERFACE_VERSION,
            reserved: 0,
            flags,
            domain_id,
            zero: Some(semiring_zero),
            one: Some(semiring_one),
            clone_value: Some(semiring_clone),
            release_values: Some(semiring_release_values),
            plus: Some(semiring_plus),
            times: Some(semiring_times),
            equal: Some(semiring_equal),
            approx_equal: Some(semiring_approximately_equal),
            natural_order: Some(semiring_natural_order),
            stable_bytes: stable.then_some(semiring_stable_bytes),
            diagnostic: Some(semiring_diagnostic),
            plus_many: batch.then_some(semiring_plus_many),
            times_many: batch.then_some(semiring_times_many),
        },
        division: division.then_some(VtSemiringDivisionVTable {
            struct_size: std::mem::size_of::<VtSemiringDivisionVTable>(),
            interface_version: VT_SEMIRING_DIVISION_INTERFACE_VERSION,
            reserved: 0,
            divide: Some(semiring_divide),
            left_divide: Some(semiring_left_divide),
        }),
        star: star.then_some(VtSemiringStarVTable {
            struct_size: std::mem::size_of::<VtSemiringStarVTable>(),
            interface_version: VT_SEMIRING_STAR_INTERFACE_VERSION,
            reserved: 0,
            star: Some(semiring_star_operation),
        }),
        numeric: numeric.then_some(VtSemiringNumericVTable {
            struct_size: std::mem::size_of::<VtSemiringNumericVTable>(),
            interface_version: VT_SEMIRING_NUMERIC_INTERFACE_VERSION,
            reserved: 0,
            numerical_value: Some(semiring_numerical_value),
            quantize: Some(semiring_quantize_operation),
            to_probability: Some(semiring_to_probability),
        }),
        properties: VtSemiringPropertiesVTable {
            struct_size: std::mem::size_of::<VtSemiringPropertiesVTable>(),
            interface_version: VT_SEMIRING_PROPERTIES_INTERFACE_VERSION,
            reserved: 0,
            properties,
            closure_bound: Some(semiring_closure_bound_operation),
        },
    });
    Ok(VtResource {
        context: Box::into_raw(context).cast(),
        vtable: &SEMIRING_RESOURCE_VTABLE,
    })
}

/// One closeable WASI guest handle around a dynamic semiring context.
pub(super) struct WasiSemiring {
    value: DynamicSemiringContext,
    encoded: Vec<u8>,
}

/// One closeable WASI guest handle around an independently owned weight.
pub(super) struct WasiSemiringWeight {
    value: Arc<DynamicSemiringWeight>,
    encoded: Vec<u8>,
}

// WASI preview 1 executes this reactor on one thread. These markers only
// permit values to live in the process-global handle registry.
unsafe impl Send for WasiSemiring {}
unsafe impl Send for WasiSemiringWeight {}

fn capture_semiring(handle: u32) -> Result<DynamicSemiringContext, String> {
    let registry = locked_registry();
    match registry.handles.get(&handle) {
        Some(Handle::Semiring(semiring)) => Ok(semiring.value.clone()),
        _ => Err("invalid semiring context handle".into()),
    }
}

fn capture_weight(handle: u32) -> Result<Arc<DynamicSemiringWeight>, String> {
    let registry = locked_registry();
    match registry.handles.get(&handle) {
        Some(Handle::SemiringWeight(weight)) => Ok(Arc::clone(&weight.value)),
        _ => Err("invalid semiring weight handle".into()),
    }
}

fn capture_weights(handles: &[u32]) -> Result<Vec<Arc<DynamicSemiringWeight>>, String> {
    let registry = locked_registry();
    handles
        .iter()
        .map(|handle| match registry.handles.get(handle) {
            Some(Handle::SemiringWeight(weight)) => Ok(Arc::clone(&weight.value)),
            _ => Err("invalid semiring weight handle".into()),
        })
        .collect()
}

fn insert_semiring(value: DynamicSemiringContext) -> u32 {
    locked_registry().insert(Handle::Semiring(WasiSemiring {
        value,
        encoded: Vec::new(),
    }))
}

fn insert_weight(value: DynamicSemiringWeight) -> u32 {
    locked_registry().insert(Handle::SemiringWeight(WasiSemiringWeight {
        value: Arc::new(value),
        encoded: Vec::new(),
    }))
}

unsafe fn semiring_handle_words(pointer: u32, count: u32) -> Result<Vec<u32>, &'static str> {
    if count != 0 && pointer == 0 {
        return Err("semiring weight handle pointer is null");
    }
    let byte_length = count
        .checked_mul(4)
        .ok_or("semiring weight handle byte length overflow")?;
    Ok(bytes(pointer, byte_length)
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
        .collect())
}

/// Adopt one JavaScript provider-table retain as a dynamic semiring context.
#[no_mangle]
pub unsafe extern "C" fn vt_host_semiring_new(
    host_handle: u32,
    domain_pointer: u32,
    domain_length: u32,
    flags: u64,
    capabilities: u32,
    properties: u64,
) -> u32 {
    let result = (|| {
        if domain_length != 16 || domain_pointer == 0 {
            return Err("semiring domain must contain exactly 16 bytes".to_owned());
        }
        let domain = bytes(domain_pointer, domain_length);
        if domain.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
            return Err("semiring domain must contain printable ASCII".to_owned());
        }
        let mut domain_id = VtInterfaceId { bytes: [0; 16] };
        domain_id.bytes.copy_from_slice(domain);
        let resource = HostOwnedSemiringResource(
            semiring_resource(host_handle, domain_id, flags, capabilities, properties)
                .map_err(str::to_owned)?,
        );
        DynamicSemiringContext::borrow_raw(resource.0).map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => insert_semiring(value),
        Err(error) => locked_registry().fail(error),
    }
}

fn construct_weight(handle: u32, one: bool) -> u32 {
    let result = capture_semiring(handle).and_then(|semiring| {
        if one { semiring.one() } else { semiring.zero() }.map_err(|error| error.to_string())
    });
    match result {
        Ok(value) => insert_weight(value),
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_zero(handle: u32) -> u32 {
    construct_weight(handle, false)
}

#[no_mangle]
pub extern "C" fn vt_semiring_one(handle: u32) -> u32 {
    construct_weight(handle, true)
}

#[no_mangle]
pub extern "C" fn vt_semiring_weight_clone(handle: u32) -> u32 {
    let result = capture_weight(handle)
        .and_then(|weight| weight.try_clone().map_err(|error| error.to_string()));
    match result {
        Ok(value) => insert_weight(value),
        Err(error) => locked_registry().fail(error),
    }
}

fn binary_weight(context: u32, left: u32, right: u32, plus: bool) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let left = capture_weight(left)?;
        let right = capture_weight(right)?;
        if plus {
            context.plus(&left, &right)
        } else {
            context.times(&left, &right)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => insert_weight(value),
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_plus(context: u32, left: u32, right: u32) -> u32 {
    binary_weight(context, left, right, true)
}

#[no_mangle]
pub extern "C" fn vt_semiring_times(context: u32, left: u32, right: u32) -> u32 {
    binary_weight(context, left, right, false)
}

fn compare_weight(context: u32, left: u32, right: u32, epsilon: Option<f64>) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let left = capture_weight(left)?;
        let right = capture_weight(right)?;
        if let Some(epsilon) = epsilon {
            context.approx_equal(&left, &right, epsilon)
        } else {
            context.equal(&left, &right)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => u32::from(value),
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_equal(context: u32, left: u32, right: u32) -> u32 {
    compare_weight(context, left, right, None)
}

#[no_mangle]
pub extern "C" fn vt_semiring_approximately_equal(
    context: u32,
    left: u32,
    right: u32,
    epsilon: f64,
) -> u32 {
    compare_weight(context, left, right, Some(epsilon))
}

#[no_mangle]
pub extern "C" fn vt_semiring_natural_order(context: u32, left: u32, right: u32) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let left = capture_weight(left)?;
        let right = capture_weight(right)?;
        context
            .natural_order(&left, &right)
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(lling_llang::dynamic_semiring::NaturalOrder::Better) => 0,
        Ok(lling_llang::dynamic_semiring::NaturalOrder::Equal) => 1,
        Ok(lling_llang::dynamic_semiring::NaturalOrder::Worse) => 2,
        Ok(lling_llang::dynamic_semiring::NaturalOrder::Incomparable) => 3,
        Err(error) => locked_registry().fail(error),
    }
}

unsafe fn fold_weight(context: u32, pointer: u32, count: u32, plus: bool) -> u32 {
    if count as usize > VT_RECOMMENDED_SEMIRING_BATCH {
        return locked_registry().fail("semiring fold accepts at most 256 values");
    }
    let handles = match semiring_handle_words(pointer, count) {
        Ok(handles) => handles,
        Err(error) => return locked_registry().fail(error),
    };
    let result = (|| {
        let context = capture_semiring(context)?;
        let weights = capture_weights(&handles)?;
        let owned = weights
            .iter()
            .map(|weight| weight.try_clone().map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if plus {
            context.plus_many(&owned)
        } else {
            context.times_many(&owned)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => insert_weight(value),
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_plus_many(context: u32, pointer: u32, count: u32) -> u32 {
    fold_weight(context, pointer, count, true)
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_times_many(context: u32, pointer: u32, count: u32) -> u32 {
    fold_weight(context, pointer, count, false)
}

fn optional_binary_weight(context: u32, left: u32, right: u32, divide: bool) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let left = capture_weight(left)?;
        let right = capture_weight(right)?;
        if divide {
            context.divide(&left, &right)
        } else {
            context.left_divide(&left, &right)
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(Some(value)) => insert_weight(value),
        Ok(None) => 0,
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_divide(context: u32, left: u32, right: u32) -> u32 {
    optional_binary_weight(context, left, right, true)
}

#[no_mangle]
pub extern "C" fn vt_semiring_left_divide(context: u32, left: u32, right: u32) -> u32 {
    optional_binary_weight(context, left, right, false)
}

#[no_mangle]
pub extern "C" fn vt_semiring_star(context: u32, weight: u32) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let weight = capture_weight(weight)?;
        context.star(&weight).map_err(|error| error.to_string())
    })();
    match result {
        Ok(Some(value)) => insert_weight(value),
        Ok(None) => 0,
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_numeric(
    context: u32,
    weight: u32,
    operation: u32,
    output: u32,
) -> u32 {
    if output == 0 {
        return locked_registry().fail("semiring numeric output is null");
    }
    let result = (|| {
        let context = capture_semiring(context)?;
        let weight = capture_weight(weight)?;
        match operation {
            OP_NUMERICAL_VALUE => context.numerical_value(&weight),
            OP_TO_PROBABILITY => context.to_probability(&weight),
            _ => return Err("unknown semiring numeric operation".into()),
        }
        .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => {
            (output as *mut f64).write(value);
            0
        }
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_quantize(
    context: u32,
    weight: u32,
    epsilon: f64,
    output: u32,
) -> u32 {
    if output == 0 {
        return locked_registry().fail("semiring quantization output is null");
    }
    let result = (|| {
        let context = capture_semiring(context)?;
        let weight = capture_weight(weight)?;
        context
            .quantize(&weight, epsilon)
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => {
            (output as *mut i64).write(value);
            0
        }
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_closure_bound(context: u32, output: u32) -> u32 {
    if output == 0 {
        return locked_registry().fail("semiring closure-bound output is null");
    }
    let result = capture_semiring(context)
        .and_then(|context| context.closure_bound().map_err(|error| error.to_string()));
    match result {
        Ok(value) => {
            let output = output as *mut u8;
            (output.cast::<u64>()).write(value.unwrap_or_default() as u64);
            output.add(8).write(u8::from(value.is_some()));
            0
        }
        Err(error) => locked_registry().fail(error),
    }
}

#[no_mangle]
pub unsafe extern "C" fn vt_semiring_validate_laws(
    context: u32,
    pointer: u32,
    count: u32,
    epsilon: f64,
) -> u32 {
    if count == 0 || count as usize > MAXIMUM_LAW_SAMPLES {
        return locked_registry()
            .fail("semiring law validation accepts one through sixteen values");
    }
    let result = semiring_handle_words(pointer, count)
        .map_err(str::to_owned)
        .and_then(|handles| capture_weights(&handles))
        .and_then(|weights| {
            weights
                .iter()
                .map(|weight| weight.try_clone().map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()
        })
        .and_then(|weights| {
            capture_semiring(context)?
                .validate_declared_laws(&weights, epsilon)
                .map_err(|error| error.to_string())
        });
    match result {
        Ok(()) => 0,
        Err(error) => locked_registry().fail(error),
    }
}

fn encode_weight(context: u32, weight: u32, diagnostic: bool) -> u32 {
    let result = (|| {
        let context = capture_semiring(context)?;
        let weight = capture_weight(weight)?;
        if diagnostic {
            context
                .diagnostic(Some(&weight))
                .map(String::into_bytes)
                .map_err(|error| error.to_string())
        } else {
            context
                .stable_bytes(&weight)
                .map_err(|error| error.to_string())
        }
    })();
    let mut registry = locked_registry();
    match result {
        Ok(encoded) if encoded.len() <= MAXIMUM_PROVIDER_BYTES => {
            match registry.handles.get_mut(&weight) {
                Some(Handle::SemiringWeight(weight)) => {
                    weight.encoded = encoded;
                    weight.encoded.len() as u32
                }
                _ => registry.fail("semiring weight closed during provider callback"),
            }
        }
        Ok(_) => registry.fail("semiring provider bytes exceed the defensive limit"),
        Err(error) => registry.fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_stable_bytes(context: u32, weight: u32) -> u32 {
    encode_weight(context, weight, false)
}

#[no_mangle]
pub extern "C" fn vt_semiring_weight_diagnostic(context: u32, weight: u32) -> u32 {
    encode_weight(context, weight, true)
}

#[no_mangle]
pub extern "C" fn vt_semiring_weight_bytes_pointer(weight: u32) -> u32 {
    let mut registry = locked_registry();
    match registry.handles.get(&weight) {
        Some(Handle::SemiringWeight(weight)) => weight.encoded.as_ptr() as u32,
        _ => registry.fail("invalid semiring weight handle"),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_diagnostic(context: u32) -> u32 {
    let result = capture_semiring(context).and_then(|value| {
        value
            .diagnostic(None)
            .map(String::into_bytes)
            .map_err(|error| error.to_string())
    });
    let mut registry = locked_registry();
    match result {
        Ok(encoded) if encoded.len() <= MAXIMUM_PROVIDER_BYTES => {
            match registry.handles.get_mut(&context) {
                Some(Handle::Semiring(semiring)) => {
                    semiring.encoded = encoded;
                    semiring.encoded.len() as u32
                }
                _ => registry.fail("semiring context closed during provider callback"),
            }
        }
        Ok(_) => registry.fail("semiring diagnostic exceeds the defensive limit"),
        Err(error) => registry.fail(error),
    }
}

#[no_mangle]
pub extern "C" fn vt_semiring_context_bytes_pointer(context: u32) -> u32 {
    let mut registry = locked_registry();
    match registry.handles.get(&context) {
        Some(Handle::Semiring(semiring)) => semiring.encoded.as_ptr() as u32,
        _ => registry.fail("invalid semiring context handle"),
    }
}
