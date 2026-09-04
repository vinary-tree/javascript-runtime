//! Browser host-semiring trampoline and closeable dynamic weights.

use super::*;
use lling_llang::dynamic_semiring::{DynamicSemiringContext, DynamicSemiringWeight, NaturalOrder};
use std::cell::RefCell;
use std::rc::Rc;
use vinary_tree_interop::{
    semiring_flags, semiring_order, semiring_properties, VtSemiringDivisionVTable,
    VtSemiringNumericVTable, VtSemiringPropertiesVTable, VtSemiringStarVTable, VtSemiringVTable,
    VtSemiringValue, VT_RECOMMENDED_SEMIRING_BATCH, VT_SEMIRING_DIVISION_INTERFACE_ID,
    VT_SEMIRING_DIVISION_INTERFACE_VERSION, VT_SEMIRING_INTERFACE_ID,
    VT_SEMIRING_INTERFACE_VERSION, VT_SEMIRING_NUMERIC_INTERFACE_ID,
    VT_SEMIRING_NUMERIC_INTERFACE_VERSION, VT_SEMIRING_PROPERTIES_INTERFACE_ID,
    VT_SEMIRING_PROPERTIES_INTERFACE_VERSION, VT_SEMIRING_STAR_INTERFACE_ID,
    VT_SEMIRING_STAR_INTERFACE_VERSION,
};

const MAXIMUM_PROVIDER_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_SEMIRING_VALUES: usize = u16::MAX as usize;
const MAXIMUM_SEMIRING_HANDLES: usize = u16::MAX as usize;
const MAXIMUM_LAW_SAMPLES: usize = 16;

#[derive(Default)]
struct ProviderValueArena {
    slots: Vec<ProviderValueSlot>,
    free: Vec<u32>,
}

struct ProviderValueSlot {
    generation: u32,
    value: Option<JsValue>,
}

struct BrowserSemiringProviderContext {
    retains: Cell<usize>,
    active: Cell<bool>,
    provider: JsValue,
    cookie: u64,
    values: RefCell<ProviderValueArena>,
    semiring: VtSemiringVTable,
    division: Option<VtSemiringDivisionVTable>,
    star: Option<VtSemiringStarVTable>,
    numeric: Option<VtSemiringNumericVTable>,
    properties: VtSemiringPropertiesVTable,
    closure_bound: Option<usize>,
}

thread_local! {
    static NEXT_SEMIRING_COOKIE: Cell<u64> = const { Cell::new(1) };
}

fn next_cookie() -> u64 {
    NEXT_SEMIRING_COOKIE.with(|next| {
        let value = next.get().max(1);
        next.set(value.wrapping_add(1).max(1));
        value ^ 0x7365_6d69_7269_6e67
    })
}

unsafe fn retain_semiring_provider(
    context: *mut BrowserSemiringProviderContext,
) -> Result<(), VtStatus> {
    if context.is_null() {
        return Err(VtStatus::NullPointer);
    }
    let retains = (*context).retains.get();
    (*context)
        .retains
        .set(retains.checked_add(1).ok_or(VtStatus::LimitExceeded)?);
    Ok(())
}

unsafe fn release_semiring_provider(context: *mut BrowserSemiringProviderContext) {
    if context.is_null() {
        return;
    }
    let retains = (*context).retains.get();
    if retains == 0 {
        return;
    }
    if retains == 1 {
        drop(Box::from_raw(context));
    } else {
        (*context).retains.set(retains - 1);
    }
}

struct SemiringCallLease(*mut BrowserSemiringProviderContext);

impl Drop for SemiringCallLease {
    fn drop(&mut self) {
        unsafe {
            (*self.0).active.set(false);
            release_semiring_provider(self.0);
        }
    }
}

unsafe fn with_semiring_provider<T>(
    context: *mut c_void,
    operation: impl FnOnce(&BrowserSemiringProviderContext) -> Result<T, ()>,
) -> Result<T, VtStatus> {
    let context = context.cast::<BrowserSemiringProviderContext>();
    retain_semiring_provider(context)?;
    if (*context).active.replace(true) {
        release_semiring_provider(context);
        return Err(VtStatus::ProviderError);
    }
    let lease = SemiringCallLease(context);
    let result = operation(&*context).map_err(|()| VtStatus::ProviderError);
    drop(lease);
    result
}

fn token_value(
    context: &BrowserSemiringProviderContext,
    token: &VtSemiringValue,
) -> Result<JsValue, ()> {
    if token.word1 != context.cookie {
        return Err(());
    }
    let low = token.word0 as u32;
    let generation = (token.word0 >> 32) as u32;
    let index = usize::try_from(low.checked_sub(1).ok_or(())?).map_err(|_| ())?;
    let values = context.values.borrow();
    let slot = values.slots.get(index).ok_or(())?;
    if generation == 0 || slot.generation != generation {
        return Err(());
    }
    slot.value.clone().ok_or(())
}

fn store_value(
    context: &BrowserSemiringProviderContext,
    value: JsValue,
) -> Result<VtSemiringValue, ()> {
    let mut values = context.values.borrow_mut();
    let index = if let Some(index) = values.free.pop() {
        index
    } else {
        if values.slots.len() >= MAXIMUM_SEMIRING_VALUES {
            return Err(());
        }
        let index = u32::try_from(values.slots.len()).map_err(|_| ())?;
        values.slots.push(ProviderValueSlot {
            generation: 1,
            value: None,
        });
        index
    };
    let slot = &mut values.slots[index as usize];
    slot.value = Some(value);
    Ok(VtSemiringValue {
        word0: (u64::from(slot.generation) << 32) | u64::from(index + 1),
        word1: context.cookie,
    })
}

fn release_tokens(
    context: &BrowserSemiringProviderContext,
    tokens: &mut [VtSemiringValue],
) -> Result<(), ()> {
    let mut values = context.values.borrow_mut();
    let mut indices = Vec::with_capacity(tokens.len());
    for token in tokens.iter() {
        if token.word1 != context.cookie {
            return Err(());
        }
        let low = token.word0 as u32;
        let generation = (token.word0 >> 32) as u32;
        let index = usize::try_from(low.checked_sub(1).ok_or(())?).map_err(|_| ())?;
        let slot = values.slots.get(index).ok_or(())?;
        if generation == 0 || slot.generation != generation || slot.value.is_none() {
            return Err(());
        }
        indices.push(index);
    }
    for (token, index) in tokens.iter_mut().zip(indices) {
        let slot = &mut values.slots[index];
        slot.value = None;
        slot.generation = slot.generation.wrapping_add(1).max(1);
        values.free.push(index as u32);
        *token = VtSemiringValue::default();
    }
    Ok(())
}

unsafe extern "C" fn semiring_retain(context: *mut c_void) {
    let _ = retain_semiring_provider(context.cast());
}

unsafe extern "C" fn semiring_release(context: *mut c_void) {
    release_semiring_provider(context.cast());
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
    let context = &*context.cast::<BrowserSemiringProviderContext>();
    let id = *interface_id;
    let table: *const c_void =
        if id == VT_SEMIRING_INTERFACE_ID && minimum_version <= VT_SEMIRING_INTERFACE_VERSION {
            (&context.semiring as *const VtSemiringVTable).cast()
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
    if table.is_null() {
        VtStatus::Unsupported.to_raw()
    } else {
        out_vtable.write(table);
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

unsafe fn semiring_constructor(
    context: *mut c_void,
    output: *mut VtSemiringValue,
    method: &str,
) -> u32 {
    if output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let value = call_provider_value(&provider.provider, method, &[])?;
        store_value(provider, value)
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

fn call_provider_value(
    provider: &JsValue,
    method: &str,
    arguments: &[JsValue],
) -> Result<JsValue, ()> {
    let function = Reflect::get(provider, &JsValue::from_str(method))
        .map_err(|_| ())?
        .dyn_into::<Function>()
        .map_err(|_| ())?;
    match arguments {
        [] => function.call0(provider),
        [first] => function.call1(provider, first),
        [first, second] => function.call2(provider, first, second),
        [first, second, third] => function.call3(provider, first, second, third),
        _ => return Err(()),
    }
    .map_err(|_| ())
}

unsafe extern "C" fn semiring_zero(context: *mut c_void, output: *mut VtSemiringValue) -> u32 {
    semiring_constructor(context, output, "zero")
}

unsafe extern "C" fn semiring_one(context: *mut c_void, output: *mut VtSemiringValue) -> u32 {
    semiring_constructor(context, output, "one")
}

unsafe extern "C" fn semiring_clone(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    if value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        store_value(provider, token_value(provider, &*value)?)
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_release_values(
    context: *mut c_void,
    values: *mut VtSemiringValue,
    count: usize,
) -> u32 {
    if count != 0 && values.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let values = if count == 0 {
        &mut [][..]
    } else {
        std::slice::from_raw_parts_mut(values, count)
    };
    match with_semiring_provider(context, |provider| release_tokens(provider, values)) {
        Ok(()) => VtStatus::Ok.to_raw(),
        Err(status) => status.to_raw(),
    }
}

unsafe fn semiring_binary(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
    method: &str,
) -> u32 {
    if left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let arguments = [
            token_value(provider, &*left)?,
            token_value(provider, &*right)?,
        ];
        let value = call_provider_value(&provider.provider, method, &arguments)?;
        store_value(provider, value)
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_plus(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_binary(context, left, right, output, "plus")
}

unsafe extern "C" fn semiring_times(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_binary(context, left, right, output, "times")
}

unsafe fn semiring_compare(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    epsilon: Option<f64>,
    output: *mut u8,
) -> u32 {
    if left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let mut arguments = vec![
            token_value(provider, &*left)?,
            token_value(provider, &*right)?,
        ];
        let method = if let Some(epsilon) = epsilon {
            arguments.push(JsValue::from_f64(epsilon));
            "approximatelyEqual"
        } else {
            "equal"
        };
        exact_bool(&call_provider_value(
            &provider.provider,
            method,
            &arguments,
        )?)
    }) {
        Ok(equal) => {
            output.write(u8::from(equal));
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_equal(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut u8,
) -> u32 {
    semiring_compare(context, left, right, None, output)
}

unsafe extern "C" fn semiring_approximately_equal(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    epsilon: f64,
    output: *mut u8,
) -> u32 {
    semiring_compare(context, left, right, Some(epsilon), output)
}

unsafe extern "C" fn semiring_natural_order(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut i32,
) -> u32 {
    if left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let arguments = [
            token_value(provider, &*left)?,
            token_value(provider, &*right)?,
        ];
        match call_provider_value(&provider.provider, "naturalOrder", &arguments)?
            .as_string()
            .as_deref()
        {
            Some("better") => Ok(semiring_order::BETTER),
            Some("equal") => Ok(semiring_order::EQUAL),
            Some("worse") => Ok(semiring_order::WORSE),
            Some("incomparable") => Ok(semiring_order::INCOMPARABLE),
            _ => Err(()),
        }
    }) {
        Ok(order) => {
            output.write(order);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe fn semiring_bytes(
    context: *mut c_void,
    value: *const VtSemiringValue,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
    method: &str,
    diagnostic: bool,
) -> u32 {
    if out_written.is_null() || out_required.is_null() || (capacity != 0 && out_bytes.is_null()) {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let argument = (!value.is_null())
            .then(|| token_value(provider, &*value))
            .transpose()?;
        let arguments = argument.into_iter().collect::<Vec<_>>();
        let result = call_provider_value(&provider.provider, method, &arguments)?;
        let bytes = if diagnostic {
            result.as_string().ok_or(())?.into_bytes()
        } else {
            result.dyn_into::<Uint8Array>().map_err(|_| ())?.to_vec()
        };
        (bytes.len() <= MAXIMUM_PROVIDER_BYTES)
            .then_some(bytes)
            .ok_or(())
    }) {
        Ok(bytes) => {
            let written = capacity.min(bytes.len());
            if written != 0 {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_bytes, written);
            }
            out_written.write(written);
            out_required.write(bytes.len());
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_stable_bytes(
    context: *mut c_void,
    value: *const VtSemiringValue,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    if value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    semiring_bytes(
        context,
        value,
        out_bytes,
        capacity,
        out_written,
        out_required,
        "stableBytes",
        false,
    )
}

unsafe extern "C" fn semiring_diagnostic(
    context: *mut c_void,
    value: *const VtSemiringValue,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    semiring_bytes(
        context,
        value,
        out_bytes,
        capacity,
        out_written,
        out_required,
        "diagnostic",
        true,
    )
}

unsafe fn semiring_many(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
    method: &str,
) -> u32 {
    if (count != 0 && values.is_null()) || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    if count > VT_RECOMMENDED_SEMIRING_BATCH {
        return VtStatus::LimitExceeded.to_raw();
    }
    let values = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(values, count)
    };
    match with_semiring_provider(context, |provider| {
        let arguments = Array::new();
        for value in values {
            arguments.push(&token_value(provider, value)?);
        }
        let result = call_provider_value(&provider.provider, method, &[arguments.into()])?;
        store_value(provider, result)
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_plus_many(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_many(context, values, count, output, "plusMany")
}

unsafe extern "C" fn semiring_times_many(
    context: *mut c_void,
    values: *const VtSemiringValue,
    count: usize,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_many(context, values, count, output, "timesMany")
}

unsafe fn semiring_optional_binary(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
    method: &str,
) -> u32 {
    if left.is_null() || right.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let arguments = [
            token_value(provider, &*left)?,
            token_value(provider, &*right)?,
        ];
        let result = call_provider_value(&provider.provider, method, &arguments)?;
        if result.is_null() {
            Ok(None)
        } else {
            store_value(provider, result).map(Some)
        }
    }) {
        Ok(Some(value)) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Ok(None) => VtStatus::End.to_raw(),
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_divide(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_optional_binary(context, left, right, output, "divide")
}

unsafe extern "C" fn semiring_left_divide(
    context: *mut c_void,
    left: *const VtSemiringValue,
    right: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    semiring_optional_binary(context, left, right, output, "leftDivide")
}

unsafe extern "C" fn semiring_star(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut VtSemiringValue,
) -> u32 {
    if value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let argument = token_value(provider, &*value)?;
        let result = call_provider_value(&provider.provider, "star", &[argument])?;
        if result.is_null() {
            Ok(None)
        } else {
            store_value(provider, result).map(Some)
        }
    }) {
        Ok(Some(value)) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Ok(None) => VtStatus::End.to_raw(),
        Err(status) => status.to_raw(),
    }
}

unsafe fn semiring_numeric(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
    method: &str,
) -> u32 {
    if value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let argument = token_value(provider, &*value)?;
        exact_number(&call_provider_value(
            &provider.provider,
            method,
            &[argument],
        )?)
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_numerical_value(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
) -> u32 {
    semiring_numeric(context, value, output, "numericalValue")
}

unsafe extern "C" fn semiring_to_probability(
    context: *mut c_void,
    value: *const VtSemiringValue,
    output: *mut f64,
) -> u32 {
    semiring_numeric(context, value, output, "toProbability")
}

unsafe extern "C" fn semiring_quantize(
    context: *mut c_void,
    value: *const VtSemiringValue,
    epsilon: f64,
    output: *mut i64,
) -> u32 {
    if value.is_null() || output.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_semiring_provider(context, |provider| {
        let arguments = [token_value(provider, &*value)?, JsValue::from_f64(epsilon)];
        let result = call_provider_value(&provider.provider, "quantize", &arguments)?;
        let bigint = BigInt::new(&result).map_err(|_| ())?;
        i64::try_from(bigint).map_err(|_| ())
    }) {
        Ok(value) => {
            output.write(value);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn semiring_closure_bound(
    context: *mut c_void,
    output: *mut usize,
    known: *mut u8,
) -> u32 {
    if context.is_null() || output.is_null() || known.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    let context = &*context.cast::<BrowserSemiringProviderContext>();
    output.write(context.closure_bound.unwrap_or_default());
    known.write(u8::from(context.closure_bound.is_some()));
    VtStatus::Ok.to_raw()
}

fn semiring_capabilities(provider: &JsValue) -> Result<(bool, bool, bool, bool, bool), ()> {
    if !provider.is_object() || provider.is_null() || Array::is_array(provider) {
        return Err(());
    }
    for method in [
        "zero",
        "one",
        "plus",
        "times",
        "equal",
        "approximatelyEqual",
        "naturalOrder",
        "diagnostic",
    ] {
        if !Reflect::get(provider, &JsValue::from_str(method))
            .map_err(|_| ())?
            .is_function()
        {
            return Err(());
        }
    }
    let optional = |name: &str| -> Result<bool, ()> {
        let value = Reflect::get(provider, &JsValue::from_str(name)).map_err(|_| ())?;
        if value.is_undefined() {
            Ok(false)
        } else if value.is_function() {
            Ok(true)
        } else {
            Err(())
        }
    };
    let stable = optional("stableBytes")?;
    let plus_many = optional("plusMany")?;
    if plus_many != optional("timesMany")? {
        return Err(());
    }
    let division = optional("divide")?;
    if division != optional("leftDivide")? {
        return Err(());
    }
    let star = optional("star")?;
    let numeric = optional("numericalValue")?;
    if numeric != optional("quantize")? || numeric != optional("toProbability")? {
        return Err(());
    }
    Ok((stable, plus_many, division, star, numeric))
}

fn semiring_resource(
    provider: JsValue,
    domain_id: VtInterfaceId,
    properties: u64,
    closure_bound: Option<usize>,
) -> Result<VtResource, ()> {
    let (stable, batch, division, star, numeric) = semiring_capabilities(&provider)?;
    if properties & semiring_properties::HASHABLE != 0 && !stable {
        return Err(());
    }
    let mut flags = semiring_flags::THREAD_BOUND;
    if stable {
        flags |= semiring_flags::STABLE_BYTES;
    }
    if batch {
        flags |= semiring_flags::BATCH;
    }
    let context = Box::new(BrowserSemiringProviderContext {
        retains: Cell::new(1),
        active: Cell::new(false),
        provider,
        cookie: next_cookie(),
        values: RefCell::new(ProviderValueArena::default()),
        semiring: VtSemiringVTable {
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
            star: Some(semiring_star),
        }),
        numeric: numeric.then_some(VtSemiringNumericVTable {
            struct_size: std::mem::size_of::<VtSemiringNumericVTable>(),
            interface_version: VT_SEMIRING_NUMERIC_INTERFACE_VERSION,
            reserved: 0,
            numerical_value: Some(semiring_numerical_value),
            quantize: Some(semiring_quantize),
            to_probability: Some(semiring_to_probability),
        }),
        properties: VtSemiringPropertiesVTable {
            struct_size: std::mem::size_of::<VtSemiringPropertiesVTable>(),
            interface_version: VT_SEMIRING_PROPERTIES_INTERFACE_VERSION,
            reserved: 0,
            properties,
            closure_bound: Some(semiring_closure_bound),
        },
        closure_bound,
    });
    Ok(VtResource {
        context: Box::into_raw(context).cast(),
        vtable: &SEMIRING_RESOURCE_VTABLE,
    })
}

struct OwnedBrowserSemiringResource(VtResource);

impl Drop for OwnedBrowserSemiringResource {
    fn drop(&mut self) {
        unsafe { semiring_release(self.0.context) }
    }
}

#[derive(Default)]
struct SemiringWeightRegistry {
    slots: Vec<SemiringWeightSlot>,
}

#[derive(Default)]
struct SemiringWeightSlot {
    generation: u16,
    value: Option<Rc<DynamicSemiringWeight>>,
}

impl SemiringWeightRegistry {
    fn insert(&mut self, value: Rc<DynamicSemiringWeight>) -> Result<u32, JsValue> {
        let index = self
            .slots
            .iter()
            .position(|slot| slot.value.is_none())
            .unwrap_or(self.slots.len());
        if index >= MAXIMUM_SEMIRING_HANDLES {
            return Err(error("browser semiring weight table is full"));
        }
        if index == self.slots.len() {
            self.slots.push(SemiringWeightSlot {
                generation: 1,
                value: None,
            });
        }
        let slot = &mut self.slots[index];
        if slot.generation == 0 {
            slot.generation = 1;
        }
        slot.value = Some(value);
        Ok((u32::from(slot.generation) << 16) | (index as u32 + 1))
    }

    fn get(&self, handle: u32) -> Option<Rc<DynamicSemiringWeight>> {
        let index = usize::try_from(handle & 0xffff).ok()?.checked_sub(1)?;
        let generation = u16::try_from(handle >> 16).ok()?;
        let slot = self.slots.get(index)?;
        (generation != 0 && slot.generation == generation)
            .then(|| slot.value.clone())
            .flatten()
    }

    fn remove(&mut self, handle: u32) {
        let Some(index) = usize::try_from(handle & 0xffff)
            .ok()
            .and_then(|value| value.checked_sub(1))
        else {
            return;
        };
        let Ok(generation) = u16::try_from(handle >> 16) else {
            return;
        };
        let Some(slot) = self.slots.get_mut(index) else {
            return;
        };
        if generation == 0 || slot.generation != generation {
            return;
        }
        slot.value = None;
        slot.generation = slot.generation.wrapping_add(1).max(1);
    }
}

thread_local! {
    static SEMIRING_WEIGHT_REGISTRY: RefCell<SemiringWeightRegistry> =
        RefCell::new(SemiringWeightRegistry::default());
}

fn register_weight(value: Rc<DynamicSemiringWeight>) -> Result<u32, JsValue> {
    SEMIRING_WEIGHT_REGISTRY.with(|registry| registry.borrow_mut().insert(value))
}

fn registered_weights(handles: &[u32]) -> Result<Vec<Rc<DynamicSemiringWeight>>, JsValue> {
    SEMIRING_WEIGHT_REGISTRY.with(|registry| {
        let registry = registry.borrow();
        handles
            .iter()
            .map(|handle| {
                registry
                    .get(*handle)
                    .ok_or_else(|| error("stale or foreign browser semiring weight handle"))
            })
            .collect()
    })
}

fn unregister_weight(handle: u32) {
    SEMIRING_WEIGHT_REGISTRY.with(|registry| registry.borrow_mut().remove(handle));
}

fn semiring_domain_id(value: &str) -> Result<VtInterfaceId, JsValue> {
    let bytes = value.as_bytes();
    if bytes.len() != 16 || bytes.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
        return Err(error(
            "semiring domainId must contain exactly 16 printable ASCII bytes",
        ));
    }
    let mut domain = VtInterfaceId { bytes: [0; 16] };
    domain.bytes.copy_from_slice(bytes);
    Ok(domain)
}

fn semiring_domain_name(value: VtInterfaceId) -> Result<String, JsValue> {
    String::from_utf8(value.bytes.to_vec())
        .map_err(|_| error("semiring provider returned a non-ASCII domain identifier"))
}

/// One independently owned host-semiring weight.
#[wasm_bindgen(js_name = SemiringWeight)]
pub struct JsSemiringWeight {
    context: DynamicSemiringContext,
    value: Option<Rc<DynamicSemiringWeight>>,
    registry_handle: u32,
}

impl JsSemiringWeight {
    fn from_inner(
        context: DynamicSemiringContext,
        value: DynamicSemiringWeight,
    ) -> Result<Self, JsValue> {
        let value = Rc::new(value);
        let registry_handle = register_weight(Rc::clone(&value))?;
        Ok(Self {
            context,
            value: Some(value),
            registry_handle,
        })
    }

    fn value(&self) -> Result<&DynamicSemiringWeight, JsValue> {
        self.value
            .as_deref()
            .ok_or_else(|| error("semiring weight is closed"))
    }

    fn release(&mut self) {
        if self.value.take().is_some() {
            unregister_weight(self.registry_handle);
            self.registry_handle = 0;
        }
    }
}

impl Drop for JsSemiringWeight {
    fn drop(&mut self) {
        self.release();
    }
}

#[wasm_bindgen(js_class = SemiringWeight)]
impl JsSemiringWeight {
    /// Stable provider-defined semantic domain.
    #[wasm_bindgen(getter, js_name = domainId)]
    pub fn domain_id(&self) -> Result<String, JsValue> {
        semiring_domain_name(self.context.domain_id())
    }

    /// Duplicate this owned weight.
    #[wasm_bindgen(js_name = clone)]
    pub fn clone_weight(&self) -> Result<JsSemiringWeight, JsValue> {
        JsSemiringWeight::from_inner(
            self.context.clone(),
            self.value()?.try_clone().map_err(error)?,
        )
    }

    /// Copy the optional canonical encoding.
    #[wasm_bindgen(js_name = stableBytes)]
    pub fn stable_bytes(&self) -> Result<Uint8Array, JsValue> {
        self.context
            .stable_bytes(self.value()?)
            .map(|bytes| Uint8Array::from(bytes.as_slice()))
            .map_err(error)
    }

    /// Return the provider's bounded diagnostic for this weight.
    pub fn diagnostic(&self) -> Result<String, JsValue> {
        self.context.diagnostic(Some(self.value()?)).map_err(error)
    }

    /// Internal generational handle used for bounded arrays.
    #[wasm_bindgen(js_name = registryHandle)]
    pub fn registry_handle(&self) -> Result<u32, JsValue> {
        self.value()?;
        Ok(self.registry_handle)
    }

    /// Release this weight. Idempotent.
    pub fn close(&mut self) {
        self.release();
    }
}

/// One retained host-defined semiring operation context.
#[wasm_bindgen(js_name = Semiring)]
pub struct JsSemiring {
    inner: Option<DynamicSemiringContext>,
}

impl JsSemiring {
    fn inner(&self) -> Result<&DynamicSemiringContext, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("semiring context is closed"))
    }

    fn weight(&self, value: DynamicSemiringWeight) -> Result<JsSemiringWeight, JsValue> {
        JsSemiringWeight::from_inner(self.inner()?.clone(), value)
    }

    fn registered(&self, handles: &[u32]) -> Result<Vec<DynamicSemiringWeight>, JsValue> {
        let values = registered_weights(handles)?;
        values
            .iter()
            .map(|value| value.try_clone().map_err(error))
            .collect()
    }
}

#[wasm_bindgen(js_class = Semiring)]
impl JsSemiring {
    /// Stable provider-defined semantic domain.
    #[wasm_bindgen(getter, js_name = domainId)]
    pub fn domain_id(&self) -> Result<String, JsValue> {
        semiring_domain_name(self.inner()?.domain_id())
    }

    pub fn zero(&self) -> Result<JsSemiringWeight, JsValue> {
        self.weight(self.inner()?.zero().map_err(error)?)
    }

    pub fn one(&self) -> Result<JsSemiringWeight, JsValue> {
        self.weight(self.inner()?.one().map_err(error)?)
    }

    pub fn plus(
        &self,
        left: &JsSemiringWeight,
        right: &JsSemiringWeight,
    ) -> Result<JsSemiringWeight, JsValue> {
        self.weight(
            self.inner()?
                .plus(left.value()?, right.value()?)
                .map_err(error)?,
        )
    }

    pub fn times(
        &self,
        left: &JsSemiringWeight,
        right: &JsSemiringWeight,
    ) -> Result<JsSemiringWeight, JsValue> {
        self.weight(
            self.inner()?
                .times(left.value()?, right.value()?)
                .map_err(error)?,
        )
    }

    pub fn equal(
        &self,
        left: &JsSemiringWeight,
        right: &JsSemiringWeight,
    ) -> Result<bool, JsValue> {
        self.inner()?
            .equal(left.value()?, right.value()?)
            .map_err(error)
    }

    #[wasm_bindgen(js_name = approximatelyEqual)]
    pub fn approximately_equal(
        &self,
        left: &JsSemiringWeight,
        right: &JsSemiringWeight,
        epsilon: f64,
    ) -> Result<bool, JsValue> {
        self.inner()?
            .approx_equal(left.value()?, right.value()?, epsilon)
            .map_err(error)
    }

    #[wasm_bindgen(js_name = naturalOrder)]
    pub fn natural_order(
        &self,
        left: &JsSemiringWeight,
        right: &JsSemiringWeight,
    ) -> Result<String, JsValue> {
        self.inner()?
            .natural_order(left.value()?, right.value()?)
            .map(|order| match order {
                NaturalOrder::Better => "better".to_owned(),
                NaturalOrder::Equal => "equal".to_owned(),
                NaturalOrder::Worse => "worse".to_owned(),
                NaturalOrder::Incomparable => "incomparable".to_owned(),
            })
            .map_err(error)
    }

    #[wasm_bindgen(js_name = stableBytes)]
    pub fn stable_bytes(&self, value: &JsSemiringWeight) -> Result<Uint8Array, JsValue> {
        self.inner()?
            .stable_bytes(value.value()?)
            .map(|bytes| Uint8Array::from(bytes.as_slice()))
            .map_err(error)
    }

    pub fn diagnostic(&self) -> Result<String, JsValue> {
        self.inner()?.diagnostic(None).map_err(error)
    }

    #[wasm_bindgen(js_name = diagnosticWeight)]
    pub fn diagnostic_weight(&self, value: &JsSemiringWeight) -> Result<String, JsValue> {
        self.inner()?
            .diagnostic(Some(value.value()?))
            .map_err(error)
    }

    #[wasm_bindgen(js_name = plusManyHandles)]
    pub fn plus_many_handles(&self, handles: Box<[u32]>) -> Result<JsSemiringWeight, JsValue> {
        if handles.len() > VT_RECOMMENDED_SEMIRING_BATCH {
            return Err(error("semiring fold accepts at most 256 values"));
        }
        let values = self.registered(&handles)?;
        self.weight(self.inner()?.plus_many(&values).map_err(error)?)
    }

    #[wasm_bindgen(js_name = timesManyHandles)]
    pub fn times_many_handles(&self, handles: Box<[u32]>) -> Result<JsSemiringWeight, JsValue> {
        if handles.len() > VT_RECOMMENDED_SEMIRING_BATCH {
            return Err(error("semiring fold accepts at most 256 values"));
        }
        let values = self.registered(&handles)?;
        self.weight(self.inner()?.times_many(&values).map_err(error)?)
    }

    pub fn divide(
        &self,
        dividend: &JsSemiringWeight,
        divisor: &JsSemiringWeight,
    ) -> Result<Option<JsSemiringWeight>, JsValue> {
        self.inner()?
            .divide(dividend.value()?, divisor.value()?)
            .map_err(error)?
            .map(|value| self.weight(value))
            .transpose()
    }

    #[wasm_bindgen(js_name = leftDivide)]
    pub fn left_divide(
        &self,
        value: &JsSemiringWeight,
        divisor: &JsSemiringWeight,
    ) -> Result<Option<JsSemiringWeight>, JsValue> {
        self.inner()?
            .left_divide(value.value()?, divisor.value()?)
            .map_err(error)?
            .map(|value| self.weight(value))
            .transpose()
    }

    pub fn star(&self, value: &JsSemiringWeight) -> Result<Option<JsSemiringWeight>, JsValue> {
        self.inner()?
            .star(value.value()?)
            .map_err(error)?
            .map(|value| self.weight(value))
            .transpose()
    }

    #[wasm_bindgen(js_name = numericalValue)]
    pub fn numerical_value(&self, value: &JsSemiringWeight) -> Result<f64, JsValue> {
        self.inner()?.numerical_value(value.value()?).map_err(error)
    }

    pub fn quantize(&self, value: &JsSemiringWeight, epsilon: f64) -> Result<JsValue, JsValue> {
        self.inner()?
            .quantize(value.value()?, epsilon)
            .map(|value| BigInt::from(value).into())
            .map_err(error)
    }

    #[wasm_bindgen(js_name = toProbability)]
    pub fn to_probability(&self, value: &JsSemiringWeight) -> Result<f64, JsValue> {
        self.inner()?.to_probability(value.value()?).map_err(error)
    }

    #[wasm_bindgen(js_name = closureBound)]
    pub fn closure_bound(&self) -> Result<JsValue, JsValue> {
        self.inner()?
            .closure_bound()
            .map(|bound| bound.map_or(JsValue::NULL, |value| BigInt::from(value as u64).into()))
            .map_err(error)
    }

    #[wasm_bindgen(js_name = validateLawHandles)]
    pub fn validate_law_handles(&self, handles: Box<[u32]>, epsilon: f64) -> Result<(), JsValue> {
        if handles.is_empty() || handles.len() > MAXIMUM_LAW_SAMPLES {
            return Err(error(
                "semiring law validation accepts one through sixteen values",
            ));
        }
        let values = self.registered(&handles)?;
        self.inner()?
            .validate_declared_laws(&values, epsilon)
            .map_err(error)
    }

    /// Release the operation context; existing weights retain independent ownership.
    pub fn close(&mut self) {
        self.inner = None;
    }
}

/// Root one JavaScript semiring provider inside this WebAssembly instance.
#[wasm_bindgen(js_name = createHostSemiring)]
pub fn create_host_semiring(
    provider: JsValue,
    domain: &str,
    property_bits: JsValue,
    closure_bound: JsValue,
) -> Result<JsSemiring, JsValue> {
    let property_bits = exact_u64(&property_bits)
        .map_err(|()| error("semiring property bits must be an unsigned 64-bit BigInt"))?;
    let known_properties = semiring_properties::HASHABLE
        | semiring_properties::IDEMPOTENT_PLUS
        | semiring_properties::K_CLOSED
        | semiring_properties::ZERO_SUM_FREE
        | semiring_properties::COMMUTATIVE_TIMES
        | semiring_properties::TOTALLY_ORDERED
        | semiring_properties::NONNEGATIVE;
    if property_bits & !known_properties != 0 {
        return Err(error("unknown semiring property bit"));
    }
    let closure_bound = if closure_bound.is_null() || closure_bound.is_undefined() {
        None
    } else {
        Some(
            exact_usize(&closure_bound)
                .map_err(|()| error("closureBound must be an unsigned pointer-sized BigInt"))?,
        )
    };
    if closure_bound.is_some() && property_bits & semiring_properties::K_CLOSED == 0 {
        return Err(error("closureBound requires the k-closed property"));
    }
    let resource = OwnedBrowserSemiringResource(
        semiring_resource(
            provider,
            semiring_domain_id(domain)?,
            property_bits,
            closure_bound,
        )
        .map_err(|()| error("invalid semiring provider contract"))?,
    );
    let inner = unsafe { DynamicSemiringContext::borrow_raw(resource.0) }.map_err(error)?;
    Ok(JsSemiring { inner: Some(inner) })
}
