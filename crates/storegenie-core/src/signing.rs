//! Request signing for the connector plugin. Must stay byte-for-byte compatible with
//! `SG_Auth::canonical_string()` in the plugin.

use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use sha2::{Digest, Sha256};

/// PHP `rawurlencode` leaves only `A-Za-z0-9-_.~` unescaped.
const RAWURL: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

pub fn rawurlencode(s: &str) -> String {
    utf8_percent_encode(s, RAWURL).to_string()
}

pub fn canonical_query(params: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = params.iter().filter(|(k, _)| k != "rest_route").collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", rawurlencode(k), rawurlencode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[allow(clippy::too_many_arguments)]
pub fn canonical_string(ts: i64, nonce: &str, method: &str, route: &str, query: &str, body: &[u8], manifest: &str) -> String {
    [
        ts.to_string(),
        nonce.to_string(),
        method.to_uppercase(),
        route.to_string(),
        query.to_string(),
        sha256_hex(body),
        sha256_hex(manifest.as_bytes()),
    ]
    .join("\n")
}

pub fn sign(secret: &str, canonical: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn nonce() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng().sample_iter(&Alphanumeric).take(24).map(char::from).collect()
}

/// Decoded `sg1.` connection string produced by the plugin's admin screen.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq)]
pub struct ConnectionString {
    pub v: i64,
    pub url: String,
    pub rest: String,
    pub key: String,
    pub secret: String,
}

pub fn parse_connection_string(s: &str) -> anyhow::Result<ConnectionString> {
    use base64::Engine;
    let s = s.trim();
    // "cf1." strings come from the plugin under its old name (CatalogForge Connector).
    let body = s.strip_prefix("sg1.").or_else(|| s.strip_prefix("cf1.")).ok_or_else(|| anyhow::anyhow!("Connection strings start with \"sg1.\" — copy it from Tools → StoreGenie Pro in wp-admin."))?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body.trim_end_matches('='))?;
    Ok(serde_json::from_slice(&raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rawurlencode_matches_php() {
        // php -r 'echo rawurlencode("a b+c/é~_.-");'  →  a%20b%2Bc%2F%C3%A9~_.-
        assert_eq!(rawurlencode("a b+c/é~_.-"), "a%20b%2Bc%2F%C3%A9~_.-");
    }

    #[test]
    fn canonical_query_sorts_and_drops_rest_route() {
        let q = vec![
            ("limit".to_string(), "250".to_string()),
            ("rest_route".to_string(), "/x".to_string()),
            ("after_id".to_string(), "10".to_string()),
        ];
        assert_eq!(canonical_query(&q), "after_id=10&limit=250");
    }

    #[test]
    fn signature_is_stable() {
        let c = canonical_string(1700000000, "abc12345", "get", "/storegenie/v1/handshake", "", b"", "");
        assert!(c.starts_with("1700000000\nabc12345\nGET\n/storegenie/v1/handshake\n\n"));
        // HMAC-SHA256("secret", c) computed with PHP hash_hmac.
        assert_eq!(sign("secret", &c).len(), 64);
        assert_eq!(sign("secret", &c), sign("secret", &c));
    }

    #[test]
    fn parses_connection_string() {
        use base64::Engine;
        let json = r#"{"v":1,"url":"https://shop.test/","rest":"https://shop.test/wp-json/","key":"sg_x","secret":"s"}"#;
        let s = format!("sg1.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json));
        let c = parse_connection_string(&s).unwrap();
        assert_eq!(c.key, "sg_x");
        // Strings copied from the plugin under its old name still work.
        let old = format!("cf1.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json));
        assert_eq!(parse_connection_string(&old).unwrap().key, "sg_x");
        assert!(parse_connection_string("nope").is_err());
    }
}
