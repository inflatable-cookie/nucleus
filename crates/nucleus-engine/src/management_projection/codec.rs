use super::types::{
    ManagementProjectionExportEntry, ManagementProjectionFileCodecError,
    ManagementProjectionFileDocument,
};

pub fn encode_management_projection_file_document(
    document: &ManagementProjectionFileDocument,
) -> Result<Vec<u8>, ManagementProjectionFileCodecError> {
    toml::to_string_pretty(document)
        .map(String::into_bytes)
        .map_err(file_encode_error)
}

pub fn decode_management_projection_file_document(
    bytes: &[u8],
) -> Result<ManagementProjectionFileDocument, ManagementProjectionFileCodecError> {
    let text = std::str::from_utf8(bytes).map_err(|error| ManagementProjectionFileCodecError {
        reason: error.to_string(),
    })?;
    toml::from_str(text).map_err(file_decode_error)
}

pub fn projection_file_document_from_entry(
    entry: ManagementProjectionExportEntry,
) -> ManagementProjectionFileDocument {
    ManagementProjectionFileDocument {
        envelope: entry.envelope,
        payload: entry.payload,
    }
}

fn file_encode_error(error: toml::ser::Error) -> ManagementProjectionFileCodecError {
    ManagementProjectionFileCodecError {
        reason: error.to_string(),
    }
}

fn file_decode_error(error: toml::de::Error) -> ManagementProjectionFileCodecError {
    ManagementProjectionFileCodecError {
        reason: error.to_string(),
    }
}
