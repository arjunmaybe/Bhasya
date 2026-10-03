//! Bhasya shared core (Rust execution of the frozen canonical contracts).
//! Mirrors `packages/core`: text hashing, context fingerprints, anchor validation.
//! Phase 1 uses the TypeScript execution in the API; this crate pins the
//! contract so the later Tauri/desktop phase shares identical semantics.

use sha2::{Digest, Sha256};

/// Collapse whitespace and trim — identical rule to `normalizeForHash` in TS.
pub fn normalize_for_hash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    hex::encode(h.finalize())
}

/// Canonical text hash: sha256 of whitespace-normalized text.
pub fn text_hash(text: &str) -> String {
    sha256_hex(&normalize_for_hash(text))
}

/// Context fingerprint: hash of structural path + 120-char prefix + selection + 120-char suffix.
pub fn context_fingerprint(structural_path: &str, prefix: &str, selected: &str, suffix: &str) -> String {
    let take_last = |s: &str, n: usize| -> String {
        let chars: Vec<char> = s.chars().collect();
        let start = chars.len().saturating_sub(n);
        chars[start..].iter().collect()
    };
    let take_first = |s: &str, n: usize| -> String { s.chars().take(n).collect() };
    let canon = format!(
        "{}\n{}\n{}\n{}",
        normalize_for_hash(structural_path),
        normalize_for_hash(&take_last(prefix, 120)),
        normalize_for_hash(selected),
        normalize_for_hash(&take_first(suffix, 120)),
    );
    sha256_hex(&canon)
}

/// Validate anchor offsets against the passage text (half-open [start, end)).
pub fn validate_offsets(passage_len: usize, start: usize, end: usize) -> bool {
    start <= end && end <= passage_len
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_is_whitespace_insensitive() {
        assert_eq!(text_hash("hello   world"), text_hash("hello world"));
    }
    #[test]
    fn offsets_validate() {
        assert!(validate_offsets(10, 2, 5));
        assert!(!validate_offsets(10, 5, 2));
        assert!(!validate_offsets(10, 0, 11));
    }
}

// Minimal hex encoder to avoid an extra dependency.
mod hex {
    const CHARS: &[u8; 16] = b"0123456789abcdef";
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let mut s = String::with_capacity(bytes.as_ref().len() * 2);
        for b in bytes.as_ref() {
            s.push(CHARS[(b >> 4) as usize] as char);
            s.push(CHARS[(b & 0xf) as usize] as char);
        }
        s
    }
}
