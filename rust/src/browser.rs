//! Browser/static-WebAssembly exports.

mod browser_lattice;

use js_sys::{Array, BigInt, BigUint64Array, Function, JsString, Object, Reflect, Uint8Array};
use libdictenstein::bindings::{
    dictionary_algebra, BindingAlgebraOperation, BindingEntries, BindingEntry, BindingTerm,
    BindingUnitDomain, BindingValueMerge, DoubleArrayTrieBinding, DynamicDawgBinding,
    OwnedDictionaryResource, ScdawgBinding,
};
use liblevenshtein::bindings::{
    Match, MatchBatch, MatchTerm, PhoneticPattern, PhoneticRuleSet, QueryCursor, QueryOrder,
    ResourceQueryCache, ResourceTransducer,
};
use liblevenshtein::distance::{
    damerau_levenshtein_distance, damerau_levenshtein_distance_bounded, standard_distance,
    standard_distance_bounded, transposition_distance, transposition_distance_bounded,
};
use liblevenshtein::transducer::{Algorithm, QueryCacheLimits};
use lling_llang::bindings::OwnedWfstResource;
use lling_llang::prelude::{MutableWfst, TropicalWeight, VectorWfst, Wfst};
use std::cell::Cell;
use std::convert::TryFrom;
use std::ffi::c_void;
use vinary_tree_interop::{
    wfst_flags, VtInterfaceId, VtResource, VtResourceVTable, VtStatus, VtUnitDomain,
    VtWeightDomain, VtWfstArc, VtWfstVTable, VT_ABI_VERSION, VT_WFST_INTERFACE_ID,
    VT_WFST_INTERFACE_VERSION,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

fn error(value: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&value.to_string()).into()
}

fn property(object: &Object, name: &str, value: &JsValue) -> Result<(), JsValue> {
    if Reflect::set(object, &JsValue::from_str(name), value)? {
        Ok(())
    } else {
        Err(error(format!("failed to define result property {name}")))
    }
}

/// Decode a raw interop status, mapping anything but `Ok` to a `JsError`.
///
/// Interop callbacks return raw `u32` statuses on the Rust side; anything
/// outside the published range is untrusted provider output and must be
/// rejected rather than read into [`VtStatus`].
fn require_ok(raw: u32, operation: &str) -> Result<(), JsValue> {
    match VtStatus::from_raw(raw) {
        Some(VtStatus::Ok) => Ok(()),
        Some(status) => Err(error(format!("{operation} failed: {status:?}"))),
        None => Err(error(format!(
            "{operation} returned an out-of-range status {raw}"
        ))),
    }
}

fn domain(value: &str) -> Result<BindingUnitDomain, JsValue> {
    match value {
        "byte" => Ok(BindingUnitDomain::Byte),
        "unicode" => Ok(BindingUnitDomain::UnicodeScalar),
        "u64" => Ok(BindingUnitDomain::U64),
        _ => Err(error(format!("unknown unit domain {value}"))),
    }
}

fn algebra_operation(value: &str) -> Result<BindingAlgebraOperation, JsValue> {
    match value {
        "union" => Ok(BindingAlgebraOperation::Union),
        "intersection" => Ok(BindingAlgebraOperation::Intersection),
        "difference" => Ok(BindingAlgebraOperation::Difference),
        "symmetric-difference" => Ok(BindingAlgebraOperation::SymmetricDifference),
        _ => Err(error(format!(
            "unknown dictionary algebra operation {value}"
        ))),
    }
}

fn value_merge(value: &str) -> Result<BindingValueMerge, JsValue> {
    match value {
        "first" => Ok(BindingValueMerge::First),
        "last" => Ok(BindingValueMerge::Last),
        "lattice-join" => Ok(BindingValueMerge::LatticeJoin),
        "lattice-meet" => Ok(BindingValueMerge::LatticeMeet),
        _ => Err(error(format!(
            "unknown dictionary value-merge policy {value}"
        ))),
    }
}

fn algorithm(value: &str) -> Result<Algorithm, JsValue> {
    match value {
        "standard" => Ok(Algorithm::Standard),
        "transposition" => Ok(Algorithm::Transposition),
        "merge-and-split" => Ok(Algorithm::MergeAndSplit),
        "damerau-levenshtein" => Ok(Algorithm::DamerauLevenshtein),
        _ => Err(error(format!("unknown algorithm {value}"))),
    }
}

fn duallity_kind(value: &str) -> Result<duallity::bindings::WfstKind, JsValue> {
    use duallity::bindings::WfstKind;
    match value {
        "levenshtein" => Ok(WfstKind::Levenshtein),
        "universal-standard" => Ok(WfstKind::UniversalStandard),
        "universal-transposition" => Ok(WfstKind::UniversalTransposition),
        "universal-merge-and-split" => Ok(WfstKind::UniversalMergeAndSplit),
        "generalized-standard" => Ok(WfstKind::GeneralizedStandard),
        "generalized-transposition" => Ok(WfstKind::GeneralizedTransposition),
        "generalized-merge-and-split" => Ok(WfstKind::GeneralizedMergeAndSplit),
        "generalized-phonetic" => Ok(WfstKind::GeneralizedPhonetic),
        "fzf" => Ok(WfstKind::Fzf),
        _ => Err(error(format!("unknown duallity WFST kind {value}"))),
    }
}

fn order(value: &str) -> Result<QueryOrder, JsValue> {
    match value {
        "traversal" => Ok(QueryOrder::Traversal),
        "distance-then-term" => Ok(QueryOrder::DistanceThenTerm),
        _ => Err(error(format!("unknown query order {value}"))),
    }
}

fn optional_u64(value: JsValue) -> Result<Option<u64>, JsValue> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let bigint =
        BigInt::new(&value).map_err(|_| error("value must be coercible to a JavaScript BigInt"))?;
    u64::try_from(bigint)
        .map(Some)
        .map_err(|_| error("value must be an unsigned 64-bit integer"))
}

fn lookup(found: bool, value: Option<u64>) -> Result<JsValue, JsValue> {
    let object = Object::new();
    property(&object, "found", &JsValue::from_bool(found))?;
    property(
        &object,
        "value",
        &value.map_or(JsValue::NULL, |value| BigInt::from(value).into()),
    )?;
    Ok(object.into())
}

fn dictionary_entry_pair(entry: BindingEntry) -> Array {
    let pair = Array::new();
    let key: JsValue = match entry.term {
        BindingTerm::Bytes(bytes) => Uint8Array::from(bytes.as_slice()).into(),
        BindingTerm::Unicode(text) => JsValue::from_str(&text),
        BindingTerm::U64(tokens) => {
            let output = BigUint64Array::new_with_length(tokens.len() as u32);
            output.copy_from(&tokens);
            output.into()
        }
    };
    pair.push(&key);
    pair.push(
        &entry
            .value
            .map_or(JsValue::NULL, |value| BigInt::from(value).into()),
    );
    pair
}

enum DictionaryBackend {
    Dynamic(DynamicDawgBinding),
    Dat(DoubleArrayTrieBinding),
    Scdawg(ScdawgBinding),
}

impl DictionaryBackend {
    fn resource(&self) -> OwnedDictionaryResource {
        match self {
            Self::Dynamic(value) => value.resource(),
            Self::Dat(value) => value.resource(),
            Self::Scdawg(value) => value.resource(),
        }
    }

    fn domain(&self) -> BindingUnitDomain {
        match self {
            Self::Dynamic(value) => value.domain(),
            Self::Dat(value) => value.domain(),
            Self::Scdawg(value) => value.domain(),
        }
    }
}

/// One browser-WASM dictionary handle. Concrete ownership remains in the
/// libdictenstein namespace even though all namespaces share this instance.
#[wasm_bindgen(js_name = Dictionary)]
pub struct JsDictionary {
    backend: Option<DictionaryBackend>,
}

/// Bounded browser-WASM traversal over one immutable dictionary revision.
#[wasm_bindgen(js_name = DictionaryEntryCursor)]
pub struct JsDictionaryEntryCursor {
    entries: Option<BindingEntries>,
    size: usize,
}

#[wasm_bindgen(js_class = DictionaryEntryCursor)]
impl JsDictionaryEntryCursor {
    /// Exact captured entry count.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> usize {
        self.size
    }

    /// Copy at most `maximum` entries into one host-owned JavaScript batch.
    #[wasm_bindgen(js_name = nextBatch)]
    pub fn next_batch(&mut self, maximum: usize) -> Result<Array, JsValue> {
        if maximum == 0 {
            return Err(error("batch size must be positive"));
        }
        let output = Array::new();
        if self.entries.is_none() {
            return Ok(output);
        }
        for _ in 0..maximum {
            let next = self.entries.as_mut().and_then(Iterator::next);
            match next {
                Some(Ok(entry)) => output.push(&dictionary_entry_pair(entry)),
                Some(Err(status)) => {
                    self.entries = None;
                    return Err(error(format!(
                        "dictionary entry traversal failed: {status:?}"
                    )));
                }
                None => {
                    self.entries = None;
                    break;
                }
            };
        }
        Ok(output)
    }

    /// Release the captured revision. Idempotent.
    pub fn close(&mut self) {
        self.entries = None;
    }
}

#[wasm_bindgen(js_class = Dictionary)]
impl JsDictionary {
    /// Construct a DynamicDAWG.
    #[wasm_bindgen(js_name = dynamicDawg)]
    pub fn dynamic_dawg(unit_domain: &str) -> Result<JsDictionary, JsValue> {
        Ok(Self {
            backend: Some(DictionaryBackend::Dynamic(DynamicDawgBinding::new(domain(
                unit_domain,
            )?))),
        })
    }

    /// Build an immutable DAT from `{term, value}` entries.
    #[wasm_bindgen(js_name = doubleArrayTrie)]
    pub fn double_array_trie(entries: &Array, unit_domain: &str) -> Result<JsDictionary, JsValue> {
        let selected = domain(unit_domain)?;
        if selected == BindingUnitDomain::U64 {
            return Err(error("DoubleArrayTrie supports byte or Unicode terms"));
        }
        let parsed = parse_entries(entries)?;
        let value = match selected {
            BindingUnitDomain::Byte => DoubleArrayTrieBinding::from_byte_terms(parsed),
            BindingUnitDomain::UnicodeScalar => DoubleArrayTrieBinding::from_unicode_terms(parsed),
            BindingUnitDomain::U64 => {
                return Err(error("DoubleArrayTrie supports byte or Unicode terms"))
            }
        };
        Ok(Self {
            backend: Some(DictionaryBackend::Dat(value)),
        })
    }

    /// Construct an incremental SCDAWG.
    pub fn scdawg(unit_domain: &str) -> Result<JsDictionary, JsValue> {
        let value = match domain(unit_domain)? {
            BindingUnitDomain::Byte => ScdawgBinding::new_byte(),
            BindingUnitDomain::UnicodeScalar => ScdawgBinding::new_unicode(),
            BindingUnitDomain::U64 => return Err(error("SCDAWG does not support u64 terms")),
        };
        Ok(Self {
            backend: Some(DictionaryBackend::Scdawg(value)),
        })
    }

    /// Return the transition domain.
    #[wasm_bindgen(getter, js_name = unitDomain)]
    pub fn unit_domain(&self) -> Result<String, JsValue> {
        Ok(match self.backend()?.domain() {
            BindingUnitDomain::Byte => "byte",
            BindingUnitDomain::UnicodeScalar => "unicode",
            BindingUnitDomain::U64 => "u64",
        }
        .into())
    }

    /// Number of visible complete terms.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> Result<usize, JsValue> {
        Ok(match self.backend()? {
            DictionaryBackend::Dynamic(value) => value.len(),
            DictionaryBackend::Dat(value) => value.len(),
            DictionaryBackend::Scdawg(value) => value.len(),
        })
    }

    /// Insert or update a text term.
    pub fn put(&self, term: &str, value: JsValue) -> Result<bool, JsValue> {
        let value = optional_u64(value)?;
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => dictionary
                .insert_text(term.as_bytes(), value)
                .map_err(error),
            DictionaryBackend::Scdawg(dictionary) => Ok(dictionary.insert(term, value)),
            DictionaryBackend::Dat(_) => Err(error("DoubleArrayTrie is immutable")),
        }
    }

    /// Insert or update an arbitrary byte term.
    #[wasm_bindgen(js_name = putBytes)]
    pub fn put_bytes(&self, term: &Uint8Array, value: JsValue) -> Result<bool, JsValue> {
        let mut bytes = vec![0; term.length() as usize];
        term.copy_to(&mut bytes);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => dictionary
                .insert_text(&bytes, optional_u64(value)?)
                .map_err(error),
            _ => Err(error("this backend does not accept arbitrary byte terms")),
        }
    }

    /// Insert or update a u64-token term.
    #[wasm_bindgen(js_name = putU64)]
    pub fn put_u64(&self, term: &BigUint64Array, value: JsValue) -> Result<bool, JsValue> {
        let mut tokens = vec![0; term.length() as usize];
        term.copy_to(&mut tokens);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => dictionary
                .insert_u64(&tokens, optional_u64(value)?)
                .map_err(error),
            _ => Err(error("this backend does not accept u64 terms")),
        }
    }

    /// Remove a text term.
    pub fn remove(&self, term: &str) -> Result<bool, JsValue> {
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.remove_text(term.as_bytes()).map_err(error)
            }
            _ => Err(error("remove is unsupported by this backend")),
        }
    }

    /// Remove an arbitrary byte term.
    #[wasm_bindgen(js_name = removeBytes)]
    pub fn remove_bytes(&self, term: &Uint8Array) -> Result<bool, JsValue> {
        let mut bytes = vec![0; term.length() as usize];
        term.copy_to(&mut bytes);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => dictionary.remove_text(&bytes).map_err(error),
            _ => Err(error("this backend does not accept arbitrary byte terms")),
        }
    }

    /// Remove a u64-token term.
    #[wasm_bindgen(js_name = removeU64)]
    pub fn remove_u64(&self, term: &BigUint64Array) -> Result<bool, JsValue> {
        let mut tokens = vec![0; term.length() as usize];
        term.copy_to(&mut tokens);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => dictionary.remove_u64(&tokens).map_err(error),
            _ => Err(error("this backend does not accept u64 terms")),
        }
    }

    /// Test exact text membership.
    pub fn has(&self, term: &str) -> Result<bool, JsValue> {
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.contains_text(term.as_bytes()).map_err(error)
            }
            DictionaryBackend::Dat(dictionary) => Ok(dictionary.contains(term)),
            DictionaryBackend::Scdawg(dictionary) => Ok(dictionary.contains(term)),
        }
    }

    /// Test exact arbitrary-byte membership.
    #[wasm_bindgen(js_name = hasBytes)]
    pub fn has_bytes(&self, term: &Uint8Array) -> Result<bool, JsValue> {
        let mut bytes = vec![0; term.length() as usize];
        term.copy_to(&mut bytes);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.contains_text(&bytes).map_err(error)
            }
            _ => Err(error("this backend does not accept arbitrary byte terms")),
        }
    }

    /// Test exact u64-token membership.
    #[wasm_bindgen(js_name = hasU64)]
    pub fn has_u64(&self, term: &BigUint64Array) -> Result<bool, JsValue> {
        let mut tokens = vec![0; term.length() as usize];
        term.copy_to(&mut tokens);
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.contains_u64(&tokens).map_err(error)
            }
            _ => Err(error("this backend does not accept u64 terms")),
        }
    }

    /// Three-state text lookup.
    pub fn get(&self, term: &str) -> Result<JsValue, JsValue> {
        let value = match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.value_text(term.as_bytes()).map_err(error)?
            }
            DictionaryBackend::Dat(dictionary) => dictionary.value(term),
            DictionaryBackend::Scdawg(dictionary) => dictionary.value(term),
        };
        match value {
            None => lookup(false, None),
            Some(value) => lookup(true, value),
        }
    }

    /// Three-state arbitrary-byte lookup.
    #[wasm_bindgen(js_name = getBytes)]
    pub fn get_bytes(&self, term: &Uint8Array) -> Result<JsValue, JsValue> {
        let mut bytes = vec![0; term.length() as usize];
        term.copy_to(&mut bytes);
        let value = match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.value_text(&bytes).map_err(error)?
            }
            _ => return Err(error("this backend does not accept arbitrary byte terms")),
        };
        match value {
            None => lookup(false, None),
            Some(value) => lookup(true, value),
        }
    }

    /// Three-state u64-token lookup.
    #[wasm_bindgen(js_name = getU64)]
    pub fn get_u64(&self, term: &BigUint64Array) -> Result<JsValue, JsValue> {
        let mut tokens = vec![0; term.length() as usize];
        term.copy_to(&mut tokens);
        let value = match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.value_u64(&tokens).map_err(error)?
            }
            _ => return Err(error("this backend does not accept u64 terms")),
        };
        match value {
            None => lookup(false, None),
            Some(value) => lookup(true, value),
        }
    }

    /// Materialize one immutable revision as lexicographic `[key, value]`
    /// pairs. The JavaScript protocol layer builds ordinary collection views
    /// over this host-owned array, so early loop exit retains no native cursor.
    #[wasm_bindgen(js_name = snapshotEntries)]
    pub fn snapshot_entries(&self) -> Result<Array, JsValue> {
        let entries = Array::new();
        for entry in self.backend()?.resource().entries() {
            let entry = entry.map_err(|status| {
                error(format!("dictionary entry traversal failed: {status:?}"))
            })?;
            entries.push(&dictionary_entry_pair(entry));
        }
        Ok(entries)
    }

    /// Open a bounded cursor over one immutable revision. The JavaScript
    /// protocol adapter supplies iteration and explicit resource management.
    #[wasm_bindgen(js_name = openEntryStream)]
    pub fn open_entry_stream(&self) -> Result<JsDictionaryEntryCursor, JsValue> {
        let entries = self.backend()?.resource().entries();
        let size = entries.size_hint().1.unwrap_or(0);
        Ok(JsDictionaryEntryCursor {
            entries: Some(entries),
            size,
        })
    }

    /// Materialize a snapshot-consistent exact-key set operation.
    pub fn algebra(
        &self,
        right: &JsDictionary,
        operation: &str,
        value_merge_policy: &str,
    ) -> Result<JsDictionary, JsValue> {
        let result = dictionary_algebra(
            &self.backend()?.resource(),
            &right.backend()?.resource(),
            algebra_operation(operation)?,
            value_merge(value_merge_policy)?,
        )
        .map_err(error)?;
        Ok(Self {
            backend: Some(DictionaryBackend::Dynamic(result)),
        })
    }

    /// Clear a DynamicDAWG.
    pub fn clear(&self) -> Result<(), JsValue> {
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => {
                dictionary.clear();
                Ok(())
            }
            _ => Err(error("clear is unsupported by this backend")),
        }
    }

    /// Compact a DynamicDAWG.
    pub fn compact(&self) -> Result<usize, JsValue> {
        match self.backend()? {
            DictionaryBackend::Dynamic(dictionary) => Ok(dictionary.compact()),
            _ => Err(error("compact is unsupported by this backend")),
        }
    }

    /// Test an SCDAWG substring.
    #[wasm_bindgen(js_name = containsSubstring)]
    pub fn contains_substring(&self, term: &str) -> Result<bool, JsValue> {
        match self.backend()? {
            DictionaryBackend::Scdawg(dictionary) => Ok(dictionary.contains_substring(term)),
            _ => Err(error("substring search requires SCDAWG")),
        }
    }

    /// Count SCDAWG substring occurrences.
    #[wasm_bindgen(js_name = substringFrequency)]
    pub fn substring_frequency(&self, term: &str) -> Result<usize, JsValue> {
        match self.backend()? {
            DictionaryBackend::Scdawg(dictionary) => Ok(dictionary.frequency(term)),
            _ => Err(error("substring search requires SCDAWG")),
        }
    }

    /// Close this JavaScript facade. Retained transducers remain valid.
    pub fn close(&mut self) {
        self.backend = None;
    }
}

unsafe fn wfst_table(resource: VtResource) -> Result<*const VtWfstVTable, JsValue> {
    if resource.is_null() {
        return Err(error("WFST resource is null"));
    }
    let base = &*resource.vtable;
    if base.struct_size < std::mem::size_of::<VtResourceVTable>()
        || base.abi_version != VT_ABI_VERSION
        || base.reserved != 0
        || base.retain.is_none()
        || base.release.is_none()
    {
        return Err(error("resource has an incompatible base ABI"));
    }
    let mut interface: *const c_void = std::ptr::null();
    let query = base
        .query_interface
        .ok_or_else(|| error("resource has no query_interface"))?;
    let status = query(
        resource.context,
        &VT_WFST_INTERFACE_ID,
        VT_WFST_INTERFACE_VERSION,
        &mut interface,
    );
    if VtStatus::from_raw(status) != Some(VtStatus::Ok) || interface.is_null() {
        return Err(error("resource has no compatible scalar WFST interface"));
    }
    let table = interface.cast::<VtWfstVTable>();
    let table_ref = &*table;
    if table_ref.struct_size < std::mem::size_of::<VtWfstVTable>()
        || table_ref.interface_version < VT_WFST_INTERFACE_VERSION
        || table_ref.reserved != 0
        || table_ref.snapshot.is_none()
        || table_ref.start.is_none()
        || table_ref.state_info.is_none()
        || table_ref.state_arcs.is_none()
    {
        return Err(error("resource has an incompatible scalar WFST interface"));
    }
    Ok(table)
}

fn weight_domain_name(value: VtWeightDomain) -> &'static str {
    match value {
        VtWeightDomain::TropicalF64 => "tropical-f64",
        VtWeightDomain::LogF64 => "log-f64",
        VtWeightDomain::ProbabilityF64 => "probability-f64",
        VtWeightDomain::ArcticF64 => "arctic-f64",
        VtWeightDomain::SignedTropicalF64 => "signed-tropical-f64",
        VtWeightDomain::CountF64 => "count-f64",
        VtWeightDomain::BooleanF64 => "boolean-f64",
    }
}

fn unit_domain_name(value: VtUnitDomain) -> &'static str {
    match value {
        VtUnitDomain::Byte => "byte",
        VtUnitDomain::UnicodeScalar => "unicode",
        VtUnitDomain::U64 => "u64",
    }
}

fn provider_unit_domain(value: &str) -> Result<VtUnitDomain, JsValue> {
    match value {
        "byte" => Ok(VtUnitDomain::Byte),
        "unicode" => Ok(VtUnitDomain::UnicodeScalar),
        "u64" => Ok(VtUnitDomain::U64),
        _ => Err(error(format!("unknown unit domain {value}"))),
    }
}

fn provider_weight_domain(value: &str) -> Result<VtWeightDomain, JsValue> {
    match value {
        "tropical-f64" => Ok(VtWeightDomain::TropicalF64),
        "log-f64" => Ok(VtWeightDomain::LogF64),
        "probability-f64" => Ok(VtWeightDomain::ProbabilityF64),
        "arctic-f64" => Ok(VtWeightDomain::ArcticF64),
        "signed-tropical-f64" => Ok(VtWeightDomain::SignedTropicalF64),
        "count-f64" => Ok(VtWeightDomain::CountF64),
        "boolean-f64" => Ok(VtWeightDomain::BooleanF64),
        _ => Err(error(format!("unknown weight domain {value}"))),
    }
}

struct BrowserProviderContext<Table> {
    retains: Cell<usize>,
    active: Cell<bool>,
    provider: JsValue,
    table: Table,
}

type BrowserWfstProviderContext = BrowserProviderContext<VtWfstVTable>;

struct ProviderCallLease<Table>(*mut BrowserProviderContext<Table>);

impl<Table> Drop for ProviderCallLease<Table> {
    fn drop(&mut self) {
        unsafe {
            let context = &*self.0;
            context.active.set(false);
            browser_provider_release(self.0);
        }
    }
}

unsafe fn try_retain_browser_provider<Table>(
    context: *mut BrowserProviderContext<Table>,
) -> Result<(), VtStatus> {
    if context.is_null() {
        return Err(VtStatus::NullPointer);
    }
    let retains = (*context).retains.get();
    let next = retains.checked_add(1).ok_or(VtStatus::LimitExceeded)?;
    (*context).retains.set(next);
    Ok(())
}

unsafe fn with_browser_provider<Table, T>(
    context: *mut c_void,
    operation: impl FnOnce(&BrowserProviderContext<Table>) -> Result<T, ()>,
) -> Result<T, VtStatus> {
    let context = context.cast::<BrowserProviderContext<Table>>();
    try_retain_browser_provider(context)?;
    if (*context).active.replace(true) {
        browser_provider_release(context);
        return Err(VtStatus::ProviderError);
    }
    let lease = ProviderCallLease(context);
    let result = operation(&*context).map_err(|()| VtStatus::ProviderError);
    drop(lease);
    result
}

fn provider_method<Table>(
    context: &BrowserProviderContext<Table>,
    name: &str,
) -> Result<Function, ()> {
    Reflect::get(&context.provider, &JsValue::from_str(name))
        .map_err(|_| ())?
        .dyn_into::<Function>()
        .map_err(|_| ())
}

fn call_provider<Table>(
    context: &BrowserProviderContext<Table>,
    name: &str,
    arguments: &[JsValue],
) -> Result<JsValue, ()> {
    let method = provider_method(context, name)?;
    match arguments {
        [] => method.call0(&context.provider),
        [first] => method.call1(&context.provider, first),
        [first, second] => method.call2(&context.provider, first, second),
        [first, second, third] => method.call3(&context.provider, first, second, third),
        _ => return Err(()),
    }
    .map_err(|_| ())
}

fn exact_u64(value: &JsValue) -> Result<u64, ()> {
    if !value.is_bigint() {
        return Err(());
    }
    let value = BigInt::new(value).map_err(|_| ())?;
    u64::try_from(value).map_err(|_| ())
}

fn exact_usize(value: &JsValue) -> Result<usize, ()> {
    usize::try_from(exact_u64(value)?).map_err(|_| ())
}

fn exact_bool(value: &JsValue) -> Result<bool, ()> {
    value.as_bool().ok_or(())
}

fn exact_number(value: &JsValue) -> Result<f64, ()> {
    let value = value.as_f64().ok_or(())?;
    if value.is_nan() {
        Err(())
    } else {
        Ok(value)
    }
}

fn reflected(value: &JsValue, name: &str) -> Result<JsValue, ()> {
    Reflect::get(value, &JsValue::from_str(name)).map_err(|_| ())
}

fn provider_label(value: &JsValue, domain: VtUnitDomain) -> Result<(u64, u8), ()> {
    if value.is_null() {
        return Ok((0, 0));
    }
    let label = match domain {
        VtUnitDomain::Byte => {
            let number = value.as_f64().ok_or(())?;
            if !number.is_finite() || number.fract() != 0.0 || !(0.0..=255.0).contains(&number) {
                return Err(());
            }
            number as u64
        }
        VtUnitDomain::UnicodeScalar => {
            let string = value.dyn_ref::<JsString>().ok_or(())?;
            u64::from(u32::from(string.as_char().ok_or(())?))
        }
        VtUnitDomain::U64 => exact_u64(value)?,
    };
    Ok((label, 1))
}

fn provider_arc(value: &JsValue, domain: VtUnitDomain) -> Result<VtWfstArc, ()> {
    if !value.is_object() || value.is_null() || Array::is_array(value) {
        return Err(());
    }
    let (input_label, has_input) = provider_label(&reflected(value, "input")?, domain)?;
    let (output_label, has_output) = provider_label(&reflected(value, "output")?, domain)?;
    Ok(VtWfstArc {
        input_label,
        output_label,
        target_state: exact_u64(&reflected(value, "target")?)?,
        weight: exact_number(&reflected(value, "weight")?)?,
        has_input,
        has_output,
        reserved: [0; 6],
    })
}

fn provider_arc_array(value: &JsValue, domain: VtUnitDomain) -> Result<Vec<VtWfstArc>, ()> {
    if !Array::is_array(value) {
        return Err(());
    }
    Array::from(value)
        .iter()
        .map(|arc| provider_arc(&arc, domain))
        .collect()
}

unsafe extern "C" fn browser_wfst_retain(context: *mut c_void) {
    let _ = try_retain_browser_provider(context.cast::<BrowserWfstProviderContext>());
}

unsafe extern "C" fn browser_wfst_release(context: *mut c_void) {
    browser_provider_release(context.cast::<BrowserWfstProviderContext>());
}

unsafe fn browser_provider_release<Table>(context: *mut BrowserProviderContext<Table>) {
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

unsafe extern "C" fn browser_wfst_query_interface(
    context: *mut c_void,
    interface_id: *const VtInterfaceId,
    minimum_version: u32,
    out_vtable: *mut *const c_void,
) -> u32 {
    if context.is_null() || interface_id.is_null() || out_vtable.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    if (*interface_id).bytes != VT_WFST_INTERFACE_ID.bytes
        || minimum_version > VT_WFST_INTERFACE_VERSION
    {
        return VtStatus::Unsupported.to_raw();
    }
    let context = &*context.cast::<BrowserWfstProviderContext>();
    out_vtable.write((&context.table as *const VtWfstVTable).cast());
    VtStatus::Ok.to_raw()
}

unsafe extern "C" fn browser_wfst_snapshot(
    context: *mut c_void,
    out_snapshot: *mut VtResource,
) -> u32 {
    if out_snapshot.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    if let Err(status) = try_retain_browser_provider(context.cast::<BrowserWfstProviderContext>()) {
        return status.to_raw();
    }
    out_snapshot.write(VtResource {
        context,
        vtable: &BROWSER_WFST_RESOURCE_VTABLE,
    });
    VtStatus::Ok.to_raw()
}

unsafe extern "C" fn browser_wfst_start(context: *mut c_void, out_state: *mut u64) -> u32 {
    if out_state.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtWfstVTable, _>(context, |provider| {
        exact_u64(&call_provider(provider, "startState", &[])?)
    }) {
        Ok(state) => {
            out_state.write(state);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_wfst_num_states(
    context: *mut c_void,
    out_count: *mut usize,
    out_known: *mut u8,
) -> u32 {
    if out_count.is_null() || out_known.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtWfstVTable, _>(context, |provider| {
        let value = call_provider(provider, "stateCount", &[])?;
        if value.is_null() {
            Ok(None)
        } else {
            exact_usize(&value).map(Some)
        }
    }) {
        Ok(count) => {
            out_count.write(count.unwrap_or_default());
            out_known.write(u8::from(count.is_some()));
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_wfst_state_info(
    context: *mut c_void,
    state: u64,
    out_valid: *mut u8,
    out_is_final: *mut u8,
    out_final_weight: *mut f64,
) -> u32 {
    if out_valid.is_null() || out_is_final.is_null() || out_final_weight.is_null() {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtWfstVTable, _>(context, |provider| {
        let value = call_provider(provider, "stateInfo", &[BigInt::from(state).into()])?;
        if !value.is_object() || value.is_null() || Array::is_array(&value) {
            return Err(());
        }
        let valid = exact_bool(&reflected(&value, "valid")?)?;
        let is_final = exact_bool(&reflected(&value, "final")?)?;
        if !valid && is_final {
            return Err(());
        }
        let final_weight = exact_number(&reflected(&value, "finalWeight")?)?;
        Ok((valid, is_final, final_weight))
    }) {
        Ok((valid, is_final, final_weight)) => {
            out_valid.write(u8::from(valid));
            out_is_final.write(u8::from(is_final));
            out_final_weight.write(final_weight);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

unsafe extern "C" fn browser_wfst_state_arcs(
    context: *mut c_void,
    state: u64,
    start: usize,
    out_arcs: *mut VtWfstArc,
    capacity: usize,
    out_written: *mut usize,
    out_total: *mut usize,
) -> u32 {
    if out_written.is_null() || out_total.is_null() || (capacity != 0 && out_arcs.is_null()) {
        return VtStatus::NullPointer.to_raw();
    }
    match with_browser_provider::<VtWfstVTable, _>(context, |provider| {
        let paged = Reflect::get(&provider.provider, &JsValue::from_str("stateArcsPage"))
            .map_err(|_| ())?;
        let (arcs, total) = if paged.is_undefined() {
            let all = provider_arc_array(
                &call_provider(provider, "stateArcs", &[BigInt::from(state).into()])?,
                provider.table.unit_domain,
            )?;
            let total = all.len();
            let arcs = all.into_iter().skip(start).take(capacity).collect();
            (arcs, total)
        } else {
            if !paged.is_function() {
                return Err(());
            }
            let value = call_provider(
                provider,
                "stateArcsPage",
                &[
                    BigInt::from(state).into(),
                    BigInt::from(start as u64).into(),
                    JsValue::from_f64(capacity as f64),
                ],
            )?;
            if !value.is_object() || value.is_null() || Array::is_array(&value) {
                return Err(());
            }
            let arcs = provider_arc_array(&reflected(&value, "arcs")?, provider.table.unit_domain)?;
            let total = exact_usize(&reflected(&value, "total")?)?;
            (arcs, total)
        };
        if start > total
            || arcs.len() > capacity
            || start
                .checked_add(arcs.len())
                .filter(|end| *end <= total)
                .is_none()
            || (capacity != 0 && arcs.is_empty() && start < total)
        {
            return Err(());
        }
        Ok((arcs, total))
    }) {
        Ok((arcs, total)) => {
            for (index, arc) in arcs.iter().enumerate() {
                out_arcs.add(index).write(*arc);
            }
            out_written.write(arcs.len());
            out_total.write(total);
            VtStatus::Ok.to_raw()
        }
        Err(status) => status.to_raw(),
    }
}

static BROWSER_WFST_RESOURCE_VTABLE: VtResourceVTable = VtResourceVTable {
    struct_size: std::mem::size_of::<VtResourceVTable>(),
    abi_version: VT_ABI_VERSION,
    reserved: 0,
    retain: Some(browser_wfst_retain),
    release: Some(browser_wfst_release),
    query_interface: Some(browser_wfst_query_interface),
};

struct BrowserOwnedWfstResource(VtResource);

impl BrowserOwnedWfstResource {
    fn new(
        provider: JsValue,
        unit_domain: VtUnitDomain,
        weight_domain: VtWeightDomain,
        flags: u64,
    ) -> Self {
        let context = Box::new(BrowserWfstProviderContext {
            retains: Cell::new(1),
            active: Cell::new(false),
            provider,
            table: VtWfstVTable {
                struct_size: std::mem::size_of::<VtWfstVTable>(),
                interface_version: VT_WFST_INTERFACE_VERSION,
                unit_domain,
                weight_domain,
                reserved: 0,
                flags,
                snapshot: Some(browser_wfst_snapshot),
                start: Some(browser_wfst_start),
                num_states: Some(browser_wfst_num_states),
                state_info: Some(browser_wfst_state_info),
                state_arcs: Some(browser_wfst_state_arcs),
            },
        });
        Self(VtResource {
            context: Box::into_raw(context).cast(),
            vtable: &BROWSER_WFST_RESOURCE_VTABLE,
        })
    }

    fn as_raw(&self) -> VtResource {
        self.0
    }
}

impl Drop for BrowserOwnedWfstResource {
    fn drop(&mut self) {
        unsafe { browser_wfst_release(self.0.context) }
    }
}

enum WfstBackend {
    Engine(OwnedWfstResource),
    Browser(BrowserOwnedWfstResource),
}

impl WfstBackend {
    fn as_raw(&self) -> VtResource {
        match self {
            Self::Engine(resource) => resource.as_raw(),
            Self::Browser(resource) => resource.as_raw(),
        }
    }
}

/// Immutable scalar WFST shared by the lling-llang and duallity namespaces.
#[wasm_bindgen(js_name = Wfst)]
pub struct JsWfst {
    inner: Option<WfstBackend>,
}

#[wasm_bindgen(js_class = Wfst)]
impl JsWfst {
    /// Return the input/output label representation.
    #[wasm_bindgen(getter, js_name = unitDomain)]
    pub fn unit_domain(&self) -> Result<String, JsValue> {
        let resource = self.inner()?.as_raw();
        let table = unsafe { &*wfst_table(resource)? };
        Ok(unit_domain_name(table.unit_domain).into())
    }

    /// Return the scalar semiring name.
    #[wasm_bindgen(getter, js_name = weightDomain)]
    pub fn weight_domain(&self) -> Result<String, JsValue> {
        let resource = self.inner()?.as_raw();
        let table = unsafe { &*wfst_table(resource)? };
        Ok(weight_domain_name(table.weight_domain).into())
    }

    /// Return the initial state as a JavaScript BigInt.
    pub fn start(&self) -> Result<u64, JsValue> {
        let resource = self.inner()?.as_raw();
        let table = unsafe { &*wfst_table(resource)? };
        let start = table
            .start
            .ok_or_else(|| error("WFST vtable has no start"))?;
        let mut state = 0;
        require_ok(unsafe { start(resource.context, &mut state) }, "WFST start")?;
        Ok(state)
    }

    /// Expand one state into `{valid, final, finalWeight, arcs}`.
    pub fn state(&self, state: u64) -> Result<JsValue, JsValue> {
        let resource = self.inner()?.as_raw();
        let table = unsafe { &*wfst_table(resource)? };
        let state_info = table
            .state_info
            .ok_or_else(|| error("WFST vtable has no state_info"))?;
        let mut valid = 0;
        let mut is_final = 0;
        let mut final_weight = 0.0;
        require_ok(
            unsafe {
                state_info(
                    resource.context,
                    state,
                    &mut valid,
                    &mut is_final,
                    &mut final_weight,
                )
            },
            "WFST state_info",
        )?;
        if valid > 1 || is_final > 1 || (valid == 0 && is_final == 1) || final_weight.is_nan() {
            return Err(error("WFST provider returned invalid state metadata"));
        }
        let mut arcs = Vec::<VtWfstArc>::new();
        if valid == 1 {
            let state_arcs = table
                .state_arcs
                .ok_or_else(|| error("WFST vtable has no state_arcs"))?;
            let mut offset = 0;
            let mut expected_total = None;
            loop {
                let mut page = vec![VtWfstArc::default(); 256];
                let mut written = 0;
                let mut total = 0;
                require_ok(
                    unsafe {
                        state_arcs(
                            resource.context,
                            state,
                            offset,
                            page.as_mut_ptr(),
                            page.len(),
                            &mut written,
                            &mut total,
                        )
                    },
                    "WFST state_arcs",
                )?;
                if written > page.len()
                    || offset
                        .checked_add(written)
                        .filter(|end| *end <= total)
                        .is_none()
                    || (written == 0 && offset < total)
                {
                    return Err(error("WFST provider returned invalid arc paging"));
                }
                if expected_total.is_some_and(|expected| expected != total) {
                    return Err(error(
                        "WFST provider changed the total arc count while paging",
                    ));
                }
                expected_total = Some(total);
                arcs.extend(page.into_iter().take(written));
                offset += written;
                if offset == total {
                    break;
                }
            }
        }
        let result = Object::new();
        property(&result, "valid", &JsValue::from_bool(valid == 1))?;
        property(&result, "final", &JsValue::from_bool(is_final == 1))?;
        property(&result, "finalWeight", &JsValue::from_f64(final_weight))?;
        let output = Array::new();
        for arc in arcs {
            let value = Object::new();
            let label = |raw: u64, present: u8| -> Result<JsValue, JsValue> {
                if present == 0 {
                    return Ok(JsValue::NULL);
                }
                if present != 1 {
                    return Err(error(
                        "WFST provider returned an invalid label-presence flag",
                    ));
                }
                match table.unit_domain {
                    VtUnitDomain::Byte => u8::try_from(raw)
                        .map(|value| JsValue::from_f64(f64::from(value)))
                        .map_err(|_| error("WFST provider returned an out-of-range byte label")),
                    VtUnitDomain::UnicodeScalar => u32::try_from(raw)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|value| value.to_string().into())
                        .ok_or_else(|| error("WFST provider returned an invalid Unicode label")),
                    VtUnitDomain::U64 => Ok(BigInt::from(raw).into()),
                }
            };
            let input = label(arc.input_label, arc.has_input)?;
            let output_label = label(arc.output_label, arc.has_output)?;
            property(&value, "input", &input)?;
            property(&value, "output", &output_label)?;
            property(&value, "target", &BigInt::from(arc.target_state).into())?;
            property(&value, "weight", &JsValue::from_f64(arc.weight))?;
            output.push(&value);
        }
        property(&result, "arcs", &output.into())?;
        Ok(result.into())
    }

    /// Release this facade. Compositions retaining it remain valid.
    pub fn close(&mut self) {
        self.inner = None;
    }
}

impl JsWfst {
    fn inner(&self) -> Result<&WfstBackend, JsValue> {
        self.inner.as_ref().ok_or_else(|| error("WFST is closed"))
    }
}

/// Mutable Unicode/tropical VectorWfst builder.
#[wasm_bindgen(js_name = WfstBuilder)]
pub struct JsWfstBuilder {
    graph: Option<VectorWfst<char, TropicalWeight>>,
}

#[wasm_bindgen(js_class = WfstBuilder)]
impl JsWfstBuilder {
    /// Construct an empty builder.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            graph: Some(VectorWfst::new()),
        }
    }

    /// Add one state and return its compact identifier.
    #[wasm_bindgen(js_name = addState)]
    pub fn add_state(&mut self) -> Result<u32, JsValue> {
        Ok(self.graph()?.add_state())
    }

    /// Set the initial state.
    #[wasm_bindgen(js_name = setStart)]
    pub fn set_start(&mut self, state: u32) -> Result<(), JsValue> {
        if !self.graph()?.try_set_start(state) {
            return Err(error("unknown start state"));
        }
        Ok(())
    }

    /// Mark a state final with its tropical cost.
    #[wasm_bindgen(js_name = setFinal)]
    pub fn set_final(&mut self, state: u32, weight: f64) -> Result<(), JsValue> {
        if weight.is_nan() {
            return Err(error("weight must not be NaN"));
        }
        let state = self
            .graph()?
            .state_mut(state)
            .ok_or_else(|| error("unknown final state"))?;
        state.is_final = true;
        state.final_weight = TropicalWeight::new(weight);
        Ok(())
    }

    /// Add an arc; null/undefined labels denote epsilon.
    #[wasm_bindgen(js_name = addArc)]
    pub fn add_arc(
        &mut self,
        from: u32,
        input: JsValue,
        output: JsValue,
        to: u32,
        weight: f64,
    ) -> Result<(), JsValue> {
        fn label(value: JsValue) -> Result<Option<char>, JsValue> {
            if value.is_null() || value.is_undefined() {
                return Ok(None);
            }
            let value = value
                .as_string()
                .ok_or_else(|| error("arc label must be one Unicode scalar or null"))?;
            let mut chars = value.chars();
            let first = chars
                .next()
                .ok_or_else(|| error("arc label must not be empty"))?;
            if chars.next().is_some() {
                return Err(error("arc label must contain one Unicode scalar"));
            }
            Ok(Some(first))
        }
        if weight.is_nan() {
            return Err(error("weight must not be NaN"));
        }
        let graph = self.graph()?;
        if !graph.is_valid_state(from) || !graph.is_valid_state(to) {
            return Err(error("unknown arc source or target"));
        }
        graph.add_arc(
            from,
            label(input)?,
            label(output)?,
            to,
            TropicalWeight::new(weight),
        );
        Ok(())
    }

    /// Freeze the graph in O(1).
    pub fn build(&mut self) -> Result<JsWfst, JsValue> {
        let graph = self
            .graph
            .take()
            .ok_or_else(|| error("builder is closed"))?;
        if graph.start() == u32::MAX {
            self.graph = Some(graph);
            return Err(error("WFST has no start state"));
        }
        Ok(JsWfst {
            inner: Some(WfstBackend::Engine(OwnedWfstResource::from_wfst(graph))),
        })
    }

    /// Release this builder.
    pub fn close(&mut self) {
        self.graph = None;
    }
}

impl Default for JsWfstBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl JsWfstBuilder {
    fn graph(&mut self) -> Result<&mut VectorWfst<char, TropicalWeight>, JsValue> {
        self.graph
            .as_mut()
            .ok_or_else(|| error("WFST builder is closed"))
    }
}

/// Lazily compose two tropical scalar WFSTs.
#[wasm_bindgen(js_name = composeWfst)]
pub fn compose_wfst(first: &JsWfst, second: &JsWfst) -> Result<JsWfst, JsValue> {
    Ok(JsWfst {
        inner: Some(WfstBackend::Engine(
            OwnedWfstResource::compose(first.inner()?.as_raw(), second.inner()?.as_raw())
                .map_err(error)?,
        )),
    })
}

/// Root an immutable JavaScript scalar-WFST provider inside this WebAssembly instance.
#[wasm_bindgen(js_name = createHostWfst)]
pub fn create_host_wfst(
    provider: JsValue,
    unit_domain: &str,
    weight_domain: &str,
    lazy: bool,
    acyclic: bool,
) -> Result<JsWfst, JsValue> {
    if !provider.is_object() || provider.is_null() || Array::is_array(&provider) {
        return Err(error("scalar WFST provider must be an object"));
    }
    for method in ["startState", "stateCount", "stateInfo", "stateArcs"] {
        let value = Reflect::get(&provider, &JsValue::from_str(method))?;
        if !value.is_function() {
            return Err(error(format!("scalar WFST provider is missing {method}()")));
        }
    }
    let optional_page = Reflect::get(&provider, &JsValue::from_str("stateArcsPage"))?;
    if !optional_page.is_undefined() && !optional_page.is_function() {
        return Err(error(
            "scalar WFST provider stateArcsPage must be a function when present",
        ));
    }
    let mut flags = wfst_flags::IMMUTABLE;
    if lazy {
        flags |= wfst_flags::LAZY;
    }
    if acyclic {
        flags |= wfst_flags::ACYCLIC;
    }
    Ok(JsWfst {
        inner: Some(WfstBackend::Browser(BrowserOwnedWfstResource::new(
            provider,
            provider_unit_domain(unit_domain)?,
            provider_weight_domain(weight_domain)?,
            flags,
        ))),
    })
}

/// Capture a dictionary revision and construct a duallity WFST.
#[wasm_bindgen(js_name = createDuallityWfst)]
pub fn create_duallity_wfst(
    dictionary: &JsDictionary,
    query: &str,
    maximum: usize,
    selected_algorithm: &str,
    selected_kind: &str,
) -> Result<JsWfst, JsValue> {
    let dictionary = dictionary.backend()?.resource();
    let resource = unsafe {
        duallity::bindings::create_wfst(
            dictionary.as_raw(),
            query,
            maximum,
            algorithm(selected_algorithm)?,
            duallity_kind(selected_kind)?,
        )
    }
    .map_err(error)?;
    Ok(JsWfst {
        inner: Some(WfstBackend::Engine(resource)),
    })
}

impl JsDictionary {
    fn backend(&self) -> Result<&DictionaryBackend, JsValue> {
        self.backend
            .as_ref()
            .ok_or_else(|| error("dictionary is closed"))
    }
}

fn parse_entries(entries: &Array) -> Result<Vec<(String, Option<u64>)>, JsValue> {
    entries
        .iter()
        .map(|entry| {
            let term = Reflect::get(&entry, &JsValue::from_str("term"))?
                .as_string()
                .ok_or_else(|| error("entry.term must be a string"))?;
            let value = Reflect::get(&entry, &JsValue::from_str("value"))?;
            Ok((term, optional_u64(value)?))
        })
        .collect()
}

/// A retained automaton configuration.
#[wasm_bindgen(js_name = Transducer)]
pub struct JsTransducer {
    inner: Option<ResourceTransducer>,
}

#[wasm_bindgen(js_class = Transducer)]
impl JsTransducer {
    /// Retain a dictionary in O(1).
    #[wasm_bindgen(constructor)]
    pub fn new(dictionary: &JsDictionary, selected: &str) -> Result<JsTransducer, JsValue> {
        let resource = dictionary.backend()?.resource();
        let inner =
            unsafe { ResourceTransducer::from_resource(resource.as_raw(), algorithm(selected)?) }
                .map_err(error)?;
        Ok(Self { inner: Some(inner) })
    }

    /// Start a Unicode query.
    #[wasm_bindgen(js_name = queryText)]
    pub fn query_text(
        &self,
        query: &str,
        maximum: usize,
        selected_order: &str,
    ) -> Result<JsQueryCursor, JsValue> {
        let cursor = self
            .inner()?
            .query_utf8(query, maximum, order(selected_order)?)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Start a raw-byte query.
    #[wasm_bindgen(js_name = queryBytes)]
    pub fn query_bytes(
        &self,
        query: &Uint8Array,
        maximum: usize,
    ) -> Result<JsQueryCursor, JsValue> {
        let mut bytes = vec![0; query.length() as usize];
        query.copy_to(&mut bytes);
        let cursor = self
            .inner()?
            .query_bytes(&bytes, maximum, QueryOrder::Traversal)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Start a u64-token query.
    #[wasm_bindgen(js_name = queryU64)]
    pub fn query_u64(
        &self,
        query: &BigUint64Array,
        maximum: usize,
    ) -> Result<JsQueryCursor, JsValue> {
        let mut tokens = vec![0; query.length() as usize];
        query.copy_to(&mut tokens);
        let cursor = self
            .inner()?
            .query_u64(&tokens, maximum, QueryOrder::Traversal)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Start a dictionary × phonetic-language product query.
    #[wasm_bindgen(js_name = queryPattern)]
    pub fn query_pattern(
        &self,
        pattern: &JsPhoneticPattern,
        maximum: u8,
    ) -> Result<JsQueryCursor, JsValue> {
        let cursor = self
            .inner()?
            .query_pattern(pattern.inner()?, maximum)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Release this facade.
    pub fn close(&mut self) {
        self.inner = None;
    }
}

/// Exclusive bounded cache of complete results from immutable revisions.
#[wasm_bindgen(js_name = QueryCache)]
pub struct JsQueryCache {
    inner: Option<ResourceQueryCache>,
}

#[wasm_bindgen(js_class = QueryCache)]
impl JsQueryCache {
    /// Retain a transducer and configure hard per-order residency bounds.
    #[wasm_bindgen(constructor)]
    pub fn new(
        transducer: &JsTransducer,
        maximum_entries: usize,
        maximum_weight: usize,
    ) -> Result<JsQueryCache, JsValue> {
        Ok(Self {
            inner: Some(ResourceQueryCache::new(
                transducer.inner()?.clone(),
                QueryCacheLimits::new(maximum_entries, maximum_weight),
            )),
        })
    }

    /// Aggregate policy counters and residency for both order shards.
    #[wasm_bindgen(getter)]
    pub fn stats(&self) -> Result<JsValue, JsValue> {
        let cache = self.inner()?;
        let traversal = cache.traversal_stats();
        let ordered = cache.ordered_stats();
        let result = Object::new();
        property(
            &result,
            "requests",
            &BigInt::from(traversal.requests().saturating_add(ordered.requests())).into(),
        )?;
        property(
            &result,
            "hits",
            &BigInt::from(traversal.hits().saturating_add(ordered.hits())).into(),
        )?;
        property(
            &result,
            "misses",
            &BigInt::from(traversal.misses().saturating_add(ordered.misses())).into(),
        )?;
        property(
            &result,
            "admissions",
            &BigInt::from(traversal.admissions().saturating_add(ordered.admissions())).into(),
        )?;
        property(
            &result,
            "rejections",
            &BigInt::from(traversal.rejections().saturating_add(ordered.rejections())).into(),
        )?;
        property(
            &result,
            "evictions",
            &BigInt::from(traversal.evictions().saturating_add(ordered.evictions())).into(),
        )?;
        property(
            &result,
            "residentEntries",
            &JsValue::from_f64(cache.len() as f64),
        )?;
        property(
            &result,
            "residentWeight",
            &JsValue::from_f64(cache.resident_weight() as f64),
        )?;
        Ok(result.into())
    }

    /// Query Unicode scalars through the bounded cache.
    #[wasm_bindgen(js_name = queryText)]
    pub fn query_text(
        &mut self,
        query: &str,
        maximum: usize,
        selected_order: &str,
    ) -> Result<JsQueryCursor, JsValue> {
        let cursor = self
            .inner_mut()?
            .query_utf8(query, maximum, order(selected_order)?)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Query exact bytes through the bounded cache.
    #[wasm_bindgen(js_name = queryBytes)]
    pub fn query_bytes(
        &mut self,
        query: &Uint8Array,
        maximum: usize,
        selected_order: &str,
    ) -> Result<JsQueryCursor, JsValue> {
        let mut bytes = vec![0; query.length() as usize];
        query.copy_to(&mut bytes);
        let cursor = self
            .inner_mut()?
            .query_bytes(&bytes, maximum, order(selected_order)?)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Query exact unsigned 64-bit tokens through the bounded cache.
    #[wasm_bindgen(js_name = queryU64)]
    pub fn query_u64(
        &mut self,
        query: &BigUint64Array,
        maximum: usize,
        selected_order: &str,
    ) -> Result<JsQueryCursor, JsValue> {
        let mut tokens = vec![0; query.length() as usize];
        query.copy_to(&mut tokens);
        let cursor = self
            .inner_mut()?
            .query_u64(&tokens, maximum, order(selected_order)?)
            .map_err(error)?;
        Ok(JsQueryCursor::new(cursor))
    }

    /// Drop resident results while retaining counters and source ownership.
    pub fn clear(&mut self) -> Result<(), JsValue> {
        self.inner_mut()?.clear();
        Ok(())
    }

    /// Reset counters while retaining residency and frequency state.
    #[wasm_bindgen(js_name = resetStats)]
    pub fn reset_stats(&mut self) -> Result<(), JsValue> {
        self.inner_mut()?.reset_stats();
        Ok(())
    }

    /// Release resident results and the retained transducer. Idempotent.
    pub fn close(&mut self) {
        self.inner = None;
    }
}

impl JsQueryCache {
    fn inner(&self) -> Result<&ResourceQueryCache, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("query cache is closed"))
    }

    fn inner_mut(&mut self) -> Result<&mut ResourceQueryCache, JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| error("query cache is closed"))
    }
}

impl JsTransducer {
    fn inner(&self) -> Result<&ResourceTransducer, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("transducer is closed"))
    }
}

/// Lazy query cursor retaining its query-start snapshot.
#[wasm_bindgen(js_name = QueryCursor)]
pub struct JsQueryCursor {
    cursor: Option<QueryCursor>,
    batch: MatchBatch,
    index: usize,
}

impl JsQueryCursor {
    fn new(cursor: QueryCursor) -> Self {
        Self {
            cursor: Some(cursor),
            batch: MatchBatch::default(),
            index: 0,
        }
    }

    fn next_match(&mut self) -> Result<Option<Match>, JsValue> {
        let Some(cursor) = self.cursor.as_mut() else {
            return Ok(None);
        };
        if self.index >= self.batch.len() {
            self.index = 0;
            let count = cursor.next_batch(&mut self.batch, 256).map_err(error)?;
            if count == 0 {
                self.cursor = None;
                return Ok(None);
            }
        }
        let Some(value) = self.batch.as_slice().get(self.index).cloned() else {
            return Err(error("query batch index out of range"));
        };
        self.index += 1;
        Ok(Some(value))
    }
}

#[wasm_bindgen(js_class = QueryCursor)]
impl JsQueryCursor {
    /// Return `{done, value}` for the JavaScript iterator protocol.
    #[wasm_bindgen(js_name = next)]
    pub fn next_js(&mut self) -> Result<JsValue, JsValue> {
        let result = Object::new();
        match self.next_match()? {
            Some(value) => {
                property(&result, "done", &JsValue::FALSE)?;
                property(&result, "value", &match_value(value)?)?;
            }
            None => property(&result, "done", &JsValue::TRUE)?,
        }
        Ok(result.into())
    }

    /// Materialize at most `maximum` remaining results for one managed boundary crossing.
    #[wasm_bindgen(js_name = nextBatch)]
    pub fn next_batch(&mut self, maximum: usize) -> Result<Array, JsValue> {
        if maximum == 0 {
            return Err(error("batch size must be positive"));
        }
        let result = Array::new();
        while result.length() < maximum as u32 {
            let Some(value) = self.next_match()? else {
                break;
            };
            result.push(&match_value(value)?);
        }
        Ok(result)
    }

    /// Close the cursor.
    pub fn close(&mut self) {
        self.cursor = None;
    }
}

fn match_value(value: Match) -> Result<JsValue, JsValue> {
    let result = Object::new();
    let term = Object::new();
    let (domain, payload): (&str, JsValue) = match value.term {
        MatchTerm::Utf8(value) => ("unicode", value.into()),
        MatchTerm::Bytes(value) => ("byte", Uint8Array::from(value.as_slice()).into()),
        MatchTerm::U64(value) => {
            let array = BigUint64Array::new_with_length(value.len() as u32);
            array.copy_from(&value);
            ("u64", array.into())
        }
    };
    property(&term, "domain", &JsValue::from_str(domain))?;
    property(&term, "value", &payload)?;
    property(&result, "term", &term.into())?;
    property(
        &result,
        "distance",
        &JsValue::from_f64(value.distance as f64),
    )?;
    property(
        &result,
        "id",
        &value.id.map_or(JsValue::NULL, |id| BigInt::from(id).into()),
    )?;
    Ok(result.into())
}

/// Reusable phonetic language automaton.
#[wasm_bindgen(js_name = PhoneticPattern)]
pub struct JsPhoneticPattern {
    inner: Option<PhoneticPattern>,
}

#[wasm_bindgen(js_class = PhoneticPattern)]
impl JsPhoneticPattern {
    /// Compile regex syntax.
    #[wasm_bindgen(js_name = compileRegex)]
    pub fn compile_regex(source: &str) -> Result<JsPhoneticPattern, JsValue> {
        Ok(Self {
            inner: Some(PhoneticPattern::from_regex(source).map_err(error)?),
        })
    }
    /// Compile LLRE syntax.
    #[wasm_bindgen(js_name = compileLlre)]
    pub fn compile_llre(source: &str) -> Result<JsPhoneticPattern, JsValue> {
        Ok(Self {
            inner: Some(PhoneticPattern::from_llre(source).map_err(error)?),
        })
    }
    /// Automaton size as `{states, transitions}`.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> Result<JsValue, JsValue> {
        let pattern = self.inner()?;
        let object = Object::new();
        property(
            &object,
            "states",
            &JsValue::from_f64(pattern.state_count() as f64),
        )?;
        property(
            &object,
            "transitions",
            &JsValue::from_f64(pattern.transition_count() as f64),
        )?;
        Ok(object.into())
    }
    /// Test complete-string acceptance.
    pub fn matches(&self, text: &str) -> Result<bool, JsValue> {
        Ok(self.inner()?.matches(text))
    }
    /// Release the pattern.
    pub fn close(&mut self) {
        self.inner = None;
    }
}
impl JsPhoneticPattern {
    fn inner(&self) -> Result<&PhoneticPattern, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("phonetic pattern is closed"))
    }
}

/// Reusable phonetic rewrite rules.
#[wasm_bindgen(js_name = PhoneticRuleSet)]
pub struct JsPhoneticRuleSet {
    inner: Option<PhoneticRuleSet>,
}

#[wasm_bindgen(js_class = PhoneticRuleSet)]
impl JsPhoneticRuleSet {
    /// Parse LLEV syntax or select a built-in name.
    pub fn compile(source: &str) -> Result<JsPhoneticRuleSet, JsValue> {
        let inner = match source {
            "english-orthography" => PhoneticRuleSet::english_orthography(),
            "english-phonetic" => PhoneticRuleSet::english_phonetic(),
            source => PhoneticRuleSet::parse(source).map_err(error)?,
        };
        Ok(Self { inner: Some(inner) })
    }
    /// Number of enabled rules.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> Result<usize, JsValue> {
        Ok(self.inner()?.len())
    }
    /// Apply rules to a fixed point.
    pub fn apply(&self, text: &str) -> Result<String, JsValue> {
        Ok(self.inner()?.apply(text))
    }
    /// Release the rules.
    pub fn close(&mut self) {
        self.inner = None;
    }
}
impl JsPhoneticRuleSet {
    fn inner(&self) -> Result<&PhoneticRuleSet, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| error("phonetic rule set is closed"))
    }
}

/// Standard Levenshtein distance.
#[wasm_bindgen(js_name = levenshteinDistance)]
pub fn levenshtein_distance(source: &str, target: &str) -> usize {
    standard_distance(source, target)
}
/// Thresholded standard distance, returning null when exceeded.
#[wasm_bindgen(js_name = levenshteinDistanceThreshold)]
pub fn levenshtein_distance_threshold(source: &str, target: &str, maximum: usize) -> Option<usize> {
    standard_distance_bounded(source, target, maximum)
}
/// Adjacent-transposition OSA distance.
#[wasm_bindgen(js_name = damerauDistance)]
pub fn damerau_distance(source: &str, target: &str) -> usize {
    transposition_distance(source, target)
}
/// Thresholded adjacent-transposition distance.
#[wasm_bindgen(js_name = damerauDistanceThreshold)]
pub fn damerau_distance_threshold(source: &str, target: &str, maximum: usize) -> Option<usize> {
    transposition_distance_bounded(source, target, maximum)
}
/// Unrestricted Damerau-Levenshtein distance.
#[wasm_bindgen(js_name = trueDamerauDistance)]
pub fn true_damerau_distance(source: &str, target: &str) -> usize {
    damerau_levenshtein_distance(source, target)
}
/// Thresholded unrestricted Damerau-Levenshtein distance.
#[wasm_bindgen(js_name = trueDamerauDistanceThreshold)]
pub fn true_damerau_distance_threshold(
    source: &str,
    target: &str,
    maximum: usize,
) -> Option<usize> {
    damerau_levenshtein_distance_bounded(source, target, maximum)
}

/// Install readable Rust panic diagnostics.
#[wasm_bindgen(start)]
pub fn initialize() {
    console_error_panic_hook::set_once();
}
