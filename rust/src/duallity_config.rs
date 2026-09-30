//! Ownership-safe decoding of the host-independent JavaScript configuration.
//!
//! The wire contains no pointers. This module validates its extents, owns all
//! text and arrays through the constructor call, then delegates semantic
//! validation and snapshot capture to duallity's revision-3 C ABI.

use duallity::ffi::{
    self, DuallityCacheStatisticsV1, DuallityGeneralizedLimitsV1, DuallityOperationV1,
    DuallityRecordHeaderV1, DuallityRestrictionV1, DuallityStatus, DuallityWfst,
    DuallityWfstOptionsV1,
};
use std::mem::size_of;
use std::ptr;
use std::slice;
use vinary_tree_interop::VtResource;

const MAGIC: u32 = 0x3143_4644;
const MAX_BYTES: usize = 2_000_000;

fn header<T>() -> DuallityRecordHeaderV1 {
    DuallityRecordHeaderV1 {
        struct_size: size_of::<T>() as u32,
        record_version: 1,
        reserved: 0,
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("configuration offset overflow")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("truncated duallity configuration")?;
        self.offset = end;
        Ok(value)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("eight bytes"),
        ))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(
            self.take(8)?.try_into().expect("eight bytes"),
        ))
    }

    fn text(&mut self) -> Result<Box<[u8]>, String> {
        let count = self.u32()? as usize;
        if count > 1_048_576 {
            return Err("duallity text length exceeds 1 MiB".into());
        }
        let value = self.take(count)?;
        std::str::from_utf8(value).map_err(|_| "duallity text is not UTF-8")?;
        Ok(value.to_vec().into_boxed_slice())
    }
}

struct OwnedOperation {
    _name: Box<[u8]>,
    _pairs: Vec<(Box<[u8]>, Box<[u8]>)>,
    _restrictions: Vec<DuallityRestrictionV1>,
}

pub(crate) struct Config {
    options: DuallityWfstOptionsV1,
    limits: Option<Box<DuallityGeneralizedLimitsV1>>,
    operations: Vec<DuallityOperationV1>,
    _owned_operations: Vec<OwnedOperation>,
}

impl Config {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_BYTES {
            return Err("duallity configuration exceeds 2 MiB".into());
        }
        let mut reader = Reader { bytes, offset: 0 };
        if reader.u32()? != MAGIC || reader.u32()? != 1 {
            return Err("unknown duallity configuration wire format".into());
        }
        let kind = reader.u32()?;
        let algorithm = reader.u32()?;
        let maximum_distance = reader.u64()?;
        let cache_policy = reader.u32()?;
        let cache_capacity = reader.u64()?;
        let has_limits = reader.u32()?;
        let operation_count = reader.u32()? as usize;
        if has_limits > 1 || operation_count > 4096 {
            return Err("invalid duallity limits selector or operation count".into());
        }
        let limits = if has_limits == 1 {
            let mut values = [0u64; 8];
            for value in &mut values {
                *value = reader.u64()?;
            }
            Some(Box::new(DuallityGeneralizedLimitsV1 {
                header: header::<DuallityGeneralizedLimitsV1>(),
                max_query_bytes: values[0],
                max_query_scalars: values[1],
                max_operation_source_scalars: values[2],
                max_operation_query_scalars: values[3],
                max_retained_dictionary_nodes: values[4],
                max_retained_wfst_states: values[5],
                max_paths_per_expansion: values[6],
                max_work_units_per_expansion: values[7],
                reserved: [0; 2],
            }))
        } else {
            None
        };
        let mut owned_operations = Vec::with_capacity(operation_count);
        let mut operations = Vec::with_capacity(operation_count);
        let mut total_pairs = 0usize;
        let mut total_text = 0usize;
        for _ in 0..operation_count {
            let consume_x = reader.u64()?;
            let consume_y = reader.u64()?;
            let weight = reader.f64()?;
            let applicability = reader.u32()?;
            let name = reader.text()?;
            let pair_count = reader.u32()? as usize;
            total_pairs = total_pairs
                .checked_add(pair_count)
                .ok_or("restriction count overflow")?;
            if total_pairs > 4096 {
                return Err("restriction count exceeds 4096".into());
            }
            total_text = total_text
                .checked_add(name.len())
                .ok_or("text length overflow")?;
            let mut pairs = Vec::with_capacity(pair_count);
            let mut restrictions = Vec::with_capacity(pair_count);
            for _ in 0..pair_count {
                let source = reader.text()?;
                let target = reader.text()?;
                total_text = total_text
                    .checked_add(source.len())
                    .and_then(|value| value.checked_add(target.len()))
                    .ok_or("text length overflow")?;
                let record = DuallityRestrictionV1 {
                    header: header::<DuallityRestrictionV1>(),
                    source_data: source.as_ptr(),
                    source_len: source.len() as u64,
                    target_data: target.as_ptr(),
                    target_len: target.len() as u64,
                    reserved: [0; 2],
                };
                pairs.push((source, target));
                restrictions.push(record);
            }
            if total_text > 1_048_576 {
                return Err("custom operation text exceeds 1 MiB".into());
            }
            operations.push(DuallityOperationV1 {
                header: header::<DuallityOperationV1>(),
                consume_x,
                consume_y,
                weight,
                applicability,
                reserved_zero: 0,
                name_data: name.as_ptr(),
                name_len: name.len() as u64,
                restrictions: if restrictions.is_empty() {
                    ptr::null()
                } else {
                    restrictions.as_ptr()
                },
                restriction_count: pair_count as u64,
                restriction_stride: if pair_count == 0 {
                    0
                } else {
                    size_of::<DuallityRestrictionV1>() as u64
                },
                reserved: [0; 2],
            });
            owned_operations.push(OwnedOperation {
                _name: name,
                _pairs: pairs,
                _restrictions: restrictions,
            });
        }
        if reader.offset != bytes.len() {
            return Err("duallity configuration has trailing bytes".into());
        }
        let mut config = Self {
            options: DuallityWfstOptionsV1 {
                header: header::<DuallityWfstOptionsV1>(),
                kind,
                algorithm,
                maximum_distance,
                cache_policy,
                reserved_zero: 0,
                cache_capacity,
                limits: ptr::null(),
                operations: ptr::null(),
                operation_count: operation_count as u64,
                operation_stride: if operation_count == 0 {
                    0
                } else {
                    size_of::<DuallityOperationV1>() as u64
                },
                reserved: [0; 2],
            },
            limits,
            operations,
            _owned_operations: owned_operations,
        };
        config.options.limits = config.limits.as_ref().map_or(ptr::null(), |value| &**value);
        config.options.operations = if config.operations.is_empty() {
            ptr::null()
        } else {
            config.operations.as_ptr()
        };
        Ok(config)
    }

    pub(crate) fn as_ptr(&self) -> *const DuallityWfstOptionsV1 {
        &self.options
    }
}

/// One project handle plus one independently retained scalar-WFST resource.
pub(crate) struct OwnedDuallityWfst {
    handle: *mut DuallityWfst,
    resource: VtResource,
}

// duallity's underlying provider/cache and immutable options are Send+Sync.
// WASI stores owners behind its process-wide registry mutex.
unsafe impl Send for OwnedDuallityWfst {}

impl OwnedDuallityWfst {
    pub(crate) fn new(dictionary: VtResource, query: &str, encoded: &[u8]) -> Result<Self, String> {
        if ffi::duallity_abi_version() != 1 || ffi::duallity_api_revision() < 3 {
            return Err("duallity configured ABI revision 3 is unavailable".into());
        }
        let config = Config::parse(encoded)?;
        let mut handle = ptr::null_mut();
        let status = unsafe {
            ffi::duallity_wfst_new_configured_ref(
                &dictionary,
                query.as_ptr(),
                query.len(),
                config.as_ptr(),
                &mut handle,
            )
        };
        require(status)?;
        let mut resource = VtResource::NULL;
        let status = unsafe { ffi::duallity_wfst_resource(handle, &mut resource) };
        if let Err(message) = require(status) {
            unsafe { ffi::duallity_wfst_free(handle) };
            return Err(message);
        }
        Ok(Self { handle, resource })
    }

    pub(crate) fn as_raw(&self) -> VtResource {
        self.resource
    }

    pub(crate) fn options(&self) -> Result<DuallityWfstOptionsV1, String> {
        let mut output = DuallityWfstOptionsV1 {
            header: header::<DuallityWfstOptionsV1>(),
            kind: 0,
            algorithm: 0,
            maximum_distance: 0,
            cache_policy: 0,
            reserved_zero: 0,
            cache_capacity: 0,
            limits: ptr::null(),
            operations: ptr::null(),
            operation_count: 0,
            operation_stride: 0,
            reserved: [0; 2],
        };
        require(unsafe { ffi::duallity_wfst_options_get(self.handle, &mut output) })?;
        Ok(output)
    }

    /// Re-encode native readback into the same pointer-free host transport.
    pub(crate) fn encoded_options(&self) -> Result<Vec<u8>, String> {
        let options = self.options()?;
        let mut output = Vec::new();
        put_u32(&mut output, MAGIC);
        put_u32(&mut output, 1);
        put_u32(&mut output, options.kind);
        put_u32(&mut output, options.algorithm);
        put_u64(&mut output, options.maximum_distance);
        put_u32(&mut output, options.cache_policy);
        put_u64(&mut output, options.cache_capacity);
        put_u32(&mut output, u32::from(!options.limits.is_null()));
        let count =
            usize::try_from(options.operation_count).map_err(|_| "operation count overflow")?;
        if count > 4096 || (count > 0 && options.operations.is_null()) {
            return Err("invalid native operation readback".into());
        }
        put_u32(&mut output, count as u32);
        if !options.limits.is_null() {
            let limits = unsafe { &*options.limits };
            for value in [
                limits.max_query_bytes,
                limits.max_query_scalars,
                limits.max_operation_source_scalars,
                limits.max_operation_query_scalars,
                limits.max_retained_dictionary_nodes,
                limits.max_retained_wfst_states,
                limits.max_paths_per_expansion,
                limits.max_work_units_per_expansion,
            ] {
                put_u64(&mut output, value);
            }
        }
        for index in 0..count {
            let operation = unsafe { &*options.operations.add(index) };
            put_u64(&mut output, operation.consume_x);
            put_u64(&mut output, operation.consume_y);
            output.extend_from_slice(&operation.weight.to_le_bytes());
            put_u32(&mut output, operation.applicability);
            put_text(&mut output, operation.name_data, operation.name_len)?;
            let pair_count = usize::try_from(operation.restriction_count)
                .map_err(|_| "restriction count overflow")?;
            if pair_count > 4096 || (pair_count > 0 && operation.restrictions.is_null()) {
                return Err("invalid native restriction readback".into());
            }
            put_u32(&mut output, pair_count as u32);
            for pair_index in 0..pair_count {
                let pair = unsafe { &*operation.restrictions.add(pair_index) };
                put_text(&mut output, pair.source_data, pair.source_len)?;
                put_text(&mut output, pair.target_data, pair.target_len)?;
            }
        }
        Ok(output)
    }

    pub(crate) fn statistics(&self) -> Result<DuallityCacheStatisticsV1, String> {
        let mut output = DuallityCacheStatisticsV1 {
            header: header::<DuallityCacheStatisticsV1>(),
            hits: 0,
            misses: 0,
            faults: 0,
            uncacheable_results: 0,
            insertions: 0,
            evictions: 0,
            raced_publications: 0,
            clears: 0,
            resident_states: 0,
            recency_records: 0,
            reserved: [0; 2],
        };
        require(unsafe { ffi::duallity_wfst_cache_statistics(self.handle, &mut output) })?;
        Ok(output)
    }

    pub(crate) fn encoded_statistics(&self) -> Result<Vec<u8>, String> {
        let statistics = self.statistics()?;
        let mut output = Vec::with_capacity(80);
        for value in [
            statistics.hits,
            statistics.misses,
            statistics.faults,
            statistics.uncacheable_results,
            statistics.insertions,
            statistics.evictions,
            statistics.raced_publications,
            statistics.clears,
            statistics.resident_states,
            statistics.recency_records,
        ] {
            put_u64(&mut output, value);
        }
        Ok(output)
    }

    pub(crate) fn clear_cache(&self) -> Result<(), String> {
        require(unsafe { ffi::duallity_wfst_cache_clear(self.handle) })
    }

    pub(crate) fn set_cache_policy(&self, policy: u32, capacity: u64) -> Result<(), String> {
        require(unsafe { ffi::duallity_wfst_cache_set_policy(self.handle, policy, capacity) })
    }
}

fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn put_text(output: &mut Vec<u8>, pointer: *const u8, length: u64) -> Result<(), String> {
    let length = usize::try_from(length).map_err(|_| "native text length overflow")?;
    if length > 1_048_576 || (length > 0 && pointer.is_null()) {
        return Err("invalid native text readback".into());
    }
    put_u32(output, length as u32);
    if length > 0 {
        output.extend_from_slice(unsafe { slice::from_raw_parts(pointer, length) });
    }
    Ok(())
}

impl Drop for OwnedDuallityWfst {
    fn drop(&mut self) {
        ffi::duallity_resource_release(self.resource);
        unsafe { ffi::duallity_wfst_free(self.handle) };
    }
}

fn require(status: DuallityStatus) -> Result<(), String> {
    if status == DuallityStatus::Ok {
        return Ok(());
    }
    let message = unsafe { std::ffi::CStr::from_ptr(ffi::duallity_last_error_message()) };
    Err(format!(
        "duallity {status:?}: {}",
        message.to_string_lossy()
    ))
}
