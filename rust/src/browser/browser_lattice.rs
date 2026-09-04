//! Browser host-lattice trampoline and closeable dynamic values.

use super::*;
use lling_llang::dynamic_lattice::DynamicLatticeValue;
use std::cell::RefCell;
use vinary_tree_interop::{
    lattice_flags, VtLatticeVTable, VT_LATTICE_INTERFACE_ID, VT_LATTICE_INTERFACE_VERSION,
    VT_RECOMMENDED_LATTICE_BATCH,
};

const MAXIMUM_PROVIDER_BYTES: usize = 16 * 1024 * 1024;
const MAXIMUM_LATTICE_HANDLES: usize = u16::MAX as usize;
const MAXIMUM_LAW_SAMPLES: usize = 16;

type BrowserLatticeProviderContext = BrowserProviderContext<VtLatticeVTable>;

fn domain_id(value: &str) -> Result<VtInterfaceId, JsValue> {
    let bytes = value.as_bytes();
    if bytes.len() != 16 || bytes.iter().any(|byte| !(0x20..=0x7e).contains(byte)) {
        return Err(error(
            "lattice domainId must contain exactly 16 printable ASCII bytes",
        ));
    }
    let mut domain = VtInterfaceId { bytes: [0; 16] };
    domain.bytes.copy_from_slice(bytes);
    Ok(domain)
}

fn domain_name(value: VtInterfaceId) -> Result<String, JsValue> {
    String::from_utf8(value.bytes.to_vec())
        .map_err(|_| error("lattice provider returned a non-ASCII domain identifier"))
}

fn optional_method(provider: &JsValue, name: &str) -> Result<bool, ()> {
    let value = Reflect::get(provider, &JsValue::from_str(name)).map_err(|_| ())?;
    if value.is_undefined() {
        Ok(false)
    } else if value.is_function() {
        Ok(true)
    } else {
        Err(())
    }
}

fn lattice_provider_flags(provider: &JsValue) -> Result<u64, ()> {
    if !provider.is_object() || provider.is_null() || Array::is_array(provider) {
        return Err(());
    }
    for method in ["join", "meet", "equal", "diagnostic"] {
        if !Reflect::get(provider, &JsValue::from_str(method))
            .map_err(|_| ())?
            .is_function()
        {
            return Err(());
        }
    }
    let stable = optional_method(provider, "stableBytes")?;
    let join_many = optional_method(provider, "joinMany")?;
    let meet_many = optional_method(provider, "meetMany")?;
    if join_many != meet_many {
        return Err(());
    }
    let mut flags = lattice_flags::THREAD_BOUND;
    if stable {
        flags |= lattice_flags::STABLE_BYTES;
    }
    if join_many {
        flags |= lattice_flags::BATCH;
    }
    Ok(flags)
}

fn lattice_resource(provider: JsValue, domain: VtInterfaceId) -> Result<VtResource, ()> {
    let flags = lattice_provider_flags(&provider)?;
    let context = Box::new(BrowserLatticeProviderContext {
        retains: Cell::new(1),
        active: Cell::new(false),
        provider,
        table: VtLatticeVTable {
            struct_size: std::mem::size_of::<VtLatticeVTable>(),
            interface_version: VT_LATTICE_INTERFACE_VERSION,
            reserved: 0,
            flags,
            domain_id: domain,
            join: Some(browser_lattice_join),
            meet: Some(browser_lattice_meet),
            equal: Some(browser_lattice_equal),
            stable_bytes: (flags & lattice_flags::STABLE_BYTES != 0)
                .then_some(browser_lattice_stable_bytes),
            diagnostic: Some(browser_lattice_diagnostic),
            join_many: (flags & lattice_flags::BATCH != 0).then_some(browser_lattice_join_many),
            meet_many: (flags & lattice_flags::BATCH != 0).then_some(browser_lattice_meet_many),
        },
    });
    Ok(VtResource {
        context: Box::into_raw(context).cast(),
        vtable: &BROWSER_LATTICE_RESOURCE_VTABLE,
    })
}

unsafe extern "C" fn browser_lattice_retain(context: *mut c_void) {
    let _ = try_retain_browser_provider(context.cast::<BrowserLatticeProviderContext>());
}

unsafe extern "C" fn browser_lattice_release(context: *mut c_void) {
    browser_provider_release(context.cast::<BrowserLatticeProviderContext>());
}

unsafe extern "C" fn browser_lattice_query_interface(
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
    let context = &*context.cast::<BrowserLatticeProviderContext>();
    out_vtable.write((&context.table as *const VtLatticeVTable).cast());
    VtStatus::Ok.to_raw()
}

static BROWSER_LATTICE_RESOURCE_VTABLE: VtResourceVTable = VtResourceVTable {
    struct_size: std::mem::size_of::<VtResourceVTable>(),
    abi_version: VT_ABI_VERSION,
    reserved: 0,
    retain: Some(browser_lattice_retain),
    release: Some(browser_lattice_release),
    query_interface: Some(browser_lattice_query_interface),
};

fn lattice_table(resource: VtResource) -> Result<&'static VtLatticeVTable, ()> {
    if resource.context.is_null() || resource.vtable.is_null() {
        return Err(());
    }
    let query = unsafe { (*resource.vtable).query_interface }.ok_or(())?;
    let mut table = std::ptr::null();
    let status = unsafe {
        query(
            resource.context,
            &VT_LATTICE_INTERFACE_ID,
            VT_LATTICE_INTERFACE_VERSION,
            &mut table,
        )
    };
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) || table.is_null() {
        return Err(());
    }
    Ok(unsafe { &*table.cast::<VtLatticeVTable>() })
}

fn copy_foreign_stable_bytes(
    resource: VtResource,
    table: &VtLatticeVTable,
) -> Result<Option<Vec<u8>>, ()> {
    if table.flags & lattice_flags::STABLE_BYTES == 0 {
        return Ok(None);
    }
    let callback = table.stable_bytes.ok_or(())?;
    let mut written = 0;
    let mut required = 0;
    let status = unsafe {
        callback(
            resource.context,
            std::ptr::null_mut(),
            0,
            &mut written,
            &mut required,
        )
    };
    if VtStatus::from_raw(status) != Some(VtStatus::Ok)
        || written != 0
        || required > MAXIMUM_PROVIDER_BYTES
    {
        return Err(());
    }
    let mut bytes = vec![0; required];
    let output = if required == 0 {
        std::ptr::null_mut()
    } else {
        bytes.as_mut_ptr()
    };
    let status = unsafe {
        callback(
            resource.context,
            output,
            bytes.len(),
            &mut written,
            &mut required,
        )
    };
    if VtStatus::from_raw(status) != Some(VtStatus::Ok)
        || written != bytes.len()
        || required != bytes.len()
    {
        return Err(());
    }
    Ok(Some(bytes))
}

fn lattice_operand(
    receiver: &BrowserLatticeProviderContext,
    resource: VtResource,
) -> Result<JsValue, ()> {
    let table = lattice_table(resource)?;
    if table.domain_id.bytes != receiver.table.domain_id.bytes {
        return Err(());
    }
    let operand = Object::new();
    property(
        &operand,
        "domainId",
        &JsValue::from_str(&String::from_utf8(table.domain_id.bytes.to_vec()).map_err(|_| ())?),
    )
    .map_err(|_| ())?;
    if std::ptr::eq(resource.vtable, &BROWSER_LATTICE_RESOURCE_VTABLE) {
        let other = unsafe { &*resource.context.cast::<BrowserLatticeProviderContext>() };
        property(&operand, "localValue", &other.provider).map_err(|_| ())?;
        property(&operand, "stableBytes", &JsValue::NULL).map_err(|_| ())?;
    } else {
        property(&operand, "localValue", &JsValue::NULL).map_err(|_| ())?;
        let stable = match copy_foreign_stable_bytes(resource, table)? {
            Some(bytes) => Uint8Array::from(bytes.as_slice()).into(),
            None => JsValue::NULL,
        };
        property(&operand, "stableBytes", &stable).map_err(|_| ())?;
    }
    Ok(operand.into())
}

unsafe fn browser_lattice_binary(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
    method: &str,
) -> u32 {
    if other.is_null() || out_value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtLatticeVTable, _>(context, |provider| {
        let operand = lattice_operand(provider, *other)?;
        let result = call_provider(provider, method, &[operand])?;
        lattice_resource(result, provider.table.domain_id)
    }) {
        Ok(resource) => {
            out_value.write(resource);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_lattice_join(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
) -> u32 {
    browser_lattice_binary(context, other, out_value, "join")
}

unsafe extern "C" fn browser_lattice_meet(
    context: *mut c_void,
    other: *const VtResource,
    out_value: *mut VtResource,
) -> u32 {
    browser_lattice_binary(context, other, out_value, "meet")
}

unsafe extern "C" fn browser_lattice_equal(
    context: *mut c_void,
    other: *const VtResource,
    out_equal: *mut u8,
) -> u32 {
    if other.is_null() || out_equal.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtLatticeVTable, _>(context, |provider| {
        let operand = lattice_operand(provider, *other)?;
        exact_bool(&call_provider(provider, "equal", &[operand])?)
    }) {
        Ok(equal) => {
            out_equal.write(u8::from(equal));
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe fn browser_lattice_bytes(
    context: *mut c_void,
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
    match with_browser_provider::<VtLatticeVTable, _>(context, |provider| {
        let value = call_provider(provider, method, &[])?;
        let bytes = if diagnostic {
            value.as_string().ok_or(())?.into_bytes()
        } else {
            value.dyn_into::<Uint8Array>().map_err(|_| ())?.to_vec()
        };
        (bytes.len() <= MAXIMUM_PROVIDER_BYTES)
            .then_some(bytes)
            .ok_or(())
    }) {
        Ok(bytes) => {
            let count = capacity.min(bytes.len());
            if count != 0 {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_bytes, count);
            }
            out_written.write(count);
            out_required.write(bytes.len());
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_lattice_stable_bytes(
    context: *mut c_void,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    browser_lattice_bytes(
        context,
        out_bytes,
        capacity,
        out_written,
        out_required,
        "stableBytes",
        false,
    )
}

unsafe extern "C" fn browser_lattice_diagnostic(
    context: *mut c_void,
    out_bytes: *mut u8,
    capacity: usize,
    out_written: *mut usize,
    out_required: *mut usize,
) -> u32 {
    browser_lattice_bytes(
        context,
        out_bytes,
        capacity,
        out_written,
        out_required,
        "diagnostic",
        true,
    )
}

unsafe fn browser_lattice_fold(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
    method: &str,
) -> u32 {
    if (count != 0 && others.is_null()) || out_value.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    if count > VT_RECOMMENDED_LATTICE_BATCH {
        return VtStatus::LimitExceeded.to_raw();
    }
    let resources = if count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(others, count)
    };
    match with_browser_provider::<VtLatticeVTable, _>(context, |provider| {
        let values = Array::new();
        for resource in resources {
            values.push(&lattice_operand(provider, *resource)?);
        }
        let result = call_provider(provider, method, &[values.into()])?;
        lattice_resource(result, provider.table.domain_id)
    }) {
        Ok(resource) => {
            out_value.write(resource);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_lattice_join_many(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
) -> u32 {
    browser_lattice_fold(context, others, count, out_value, "joinMany")
}

unsafe extern "C" fn browser_lattice_meet_many(
    context: *mut c_void,
    others: *const VtResource,
    count: usize,
    out_value: *mut VtResource,
) -> u32 {
    browser_lattice_fold(context, others, count, out_value, "meetMany")
}

struct OwnedBrowserLatticeResource(VtResource);

impl OwnedBrowserLatticeResource {
    fn new(provider: JsValue, domain: VtInterfaceId) -> Result<Self, ()> {
        lattice_resource(provider, domain).map(Self)
    }
}

impl Drop for OwnedBrowserLatticeResource {
    fn drop(&mut self) {
        unsafe { browser_lattice_release(self.0.context) }
    }
}

#[derive(Default)]
struct LatticeRegistry {
    slots: Vec<LatticeSlot>,
}

#[derive(Default)]
struct LatticeSlot {
    generation: u16,
    value: Option<DynamicLatticeValue>,
}

impl LatticeRegistry {
    fn insert(&mut self, value: DynamicLatticeValue) -> Result<u32, JsValue> {
        let index = self
            .slots
            .iter()
            .position(|slot| slot.value.is_none())
            .unwrap_or(self.slots.len());
        if index >= MAXIMUM_LATTICE_HANDLES {
            return Err(error("browser lattice handle table is full"));
        }
        if index == self.slots.len() {
            self.slots.push(LatticeSlot {
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

    fn get(&self, handle: u32) -> Option<DynamicLatticeValue> {
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
    static LATTICE_REGISTRY: RefCell<LatticeRegistry> = RefCell::new(LatticeRegistry::default());
}

fn register_lattice(value: DynamicLatticeValue) -> Result<u32, JsValue> {
    LATTICE_REGISTRY.with(|registry| registry.borrow_mut().insert(value))
}

fn registered_lattices(handles: &[u32]) -> Result<Vec<DynamicLatticeValue>, JsValue> {
    LATTICE_REGISTRY.with(|registry| {
        let registry = registry.borrow();
        handles
            .iter()
            .map(|handle| {
                registry
                    .get(*handle)
                    .ok_or_else(|| error("stale or foreign browser lattice handle"))
            })
            .collect()
    })
}

fn unregister_lattice(handle: u32) {
    LATTICE_REGISTRY.with(|registry| registry.borrow_mut().remove(handle));
}

/// Immutable host-defined lattice value consumed through lling-llang.
#[wasm_bindgen(js_name = Lattice)]
pub struct JsLattice {
    inner: Option<DynamicLatticeValue>,
    registry_handle: u32,
}

impl JsLattice {
    fn from_inner(inner: DynamicLatticeValue) -> Result<Self, JsValue> {
        let registry_handle = register_lattice(inner.clone())?;
        Ok(Self {
            inner: Some(inner),
            registry_handle,
        })
    }

    fn inner(&self) -> Result<&DynamicLatticeValue, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("lattice value is closed"))
    }

    fn release(&mut self) {
        if self.inner.take().is_some() {
            unregister_lattice(self.registry_handle);
            self.registry_handle = 0;
        }
    }
}

impl Drop for JsLattice {
    fn drop(&mut self) {
        self.release();
    }
}

#[wasm_bindgen(js_class = Lattice)]
impl JsLattice {
    /// Stable provider-defined semantic domain.
    #[wasm_bindgen(getter, js_name = domainId)]
    pub fn domain_id(&self) -> Result<String, JsValue> {
        domain_name(self.inner()?.domain_id())
    }

    /// Return the least upper bound with a same-domain value.
    pub fn join(&self, other: &JsLattice) -> Result<JsLattice, JsValue> {
        JsLattice::from_inner(self.inner()?.join(other.inner()?).map_err(error)?)
    }

    /// Return the greatest lower bound with a same-domain value.
    pub fn meet(&self, other: &JsLattice) -> Result<JsLattice, JsValue> {
        JsLattice::from_inner(self.inner()?.meet(other.inner()?).map_err(error)?)
    }

    /// Ask the provider for exact semantic equality.
    pub fn equal(&self, other: &JsLattice) -> Result<bool, JsValue> {
        self.inner()?.equal(other.inner()?).map_err(error)
    }

    /// Copy the optional canonical encoding.
    #[wasm_bindgen(js_name = stableBytes)]
    pub fn stable_bytes(&self) -> Result<Uint8Array, JsValue> {
        self.inner()?
            .stable_bytes()
            .map(|bytes| Uint8Array::from(bytes.as_slice()))
            .map_err(error)
    }

    /// Return the provider's bounded human-readable diagnostic.
    pub fn diagnostic(&self) -> Result<String, JsValue> {
        self.inner()?.diagnostic().map_err(error)
    }

    /// Internal generational handle used by the facade for bounded arrays.
    #[wasm_bindgen(js_name = registryHandle)]
    pub fn registry_handle(&self) -> Result<u32, JsValue> {
        self.inner()?;
        Ok(self.registry_handle)
    }

    /// Fold joins over validated generational handles.
    #[wasm_bindgen(js_name = joinManyHandles)]
    pub fn join_many_handles(&self, handles: Box<[u32]>) -> Result<JsLattice, JsValue> {
        if handles.len() > VT_RECOMMENDED_LATTICE_BATCH {
            return Err(error("lattice fold accepts at most 256 values"));
        }
        let others = registered_lattices(&handles)?;
        JsLattice::from_inner(self.inner()?.join_many(&others).map_err(error)?)
    }

    /// Fold meets over validated generational handles.
    #[wasm_bindgen(js_name = meetManyHandles)]
    pub fn meet_many_handles(&self, handles: Box<[u32]>) -> Result<JsLattice, JsValue> {
        if handles.len() > VT_RECOMMENDED_LATTICE_BATCH {
            return Err(error("lattice fold accepts at most 256 values"));
        }
        let others = registered_lattices(&handles)?;
        JsLattice::from_inner(self.inner()?.meet_many(&others).map_err(error)?)
    }

    /// Release this value; independently retained results remain valid.
    pub fn close(&mut self) {
        self.release();
    }
}

/// Root one immutable JavaScript lattice provider inside this WebAssembly instance.
#[wasm_bindgen(js_name = createHostLattice)]
pub fn create_host_lattice(provider: JsValue, domain: &str) -> Result<JsLattice, JsValue> {
    let domain = domain_id(domain)?;
    let resource = OwnedBrowserLatticeResource::new(provider, domain)
        .map_err(|()| error("invalid lattice provider contract"))?;
    let value = unsafe { DynamicLatticeValue::borrow_raw(resource.0) }.map_err(error)?;
    JsLattice::from_inner(value)
}

/// Probe the lattice laws over bounded same-domain browser values.
#[wasm_bindgen(js_name = validateLatticeLawHandles)]
pub fn validate_lattice_law_handles(handles: Box<[u32]>) -> Result<(), JsValue> {
    if handles.is_empty() || handles.len() > MAXIMUM_LAW_SAMPLES {
        return Err(error(
            "lattice law validation accepts one through sixteen values",
        ));
    }
    let values = registered_lattices(&handles)?;
    DynamicLatticeValue::validate_laws(&values).map_err(error)
}
