//! Minimal PHP `serialize()` support for the one structure we must edit without a PHP runtime:
//! WordPress's `active_plugins` option (a list of strings).

use anyhow::{bail, Result};

/// Parses `a:N:{i:0;s:L:"...";...}` into the list of string values (keys are discarded).
pub fn parse_string_list(input: &str) -> Result<Vec<String>> {
    let b = input.as_bytes();
    let mut i = 0usize;
    let expect = |i: &mut usize, s: &[u8]| -> Result<()> {
        if b.len() < *i + s.len() || &b[*i..*i + s.len()] != s {
            bail!("unexpected PHP serialization near byte {}", *i);
        }
        *i += s.len();
        Ok(())
    };
    let read_int = |i: &mut usize, end: u8| -> Result<usize> {
        let start = *i;
        while *i < b.len() && b[*i] != end {
            *i += 1;
        }
        let n = std::str::from_utf8(&b[start..*i])?.parse::<usize>()?;
        *i += 1;
        Ok(n)
    };
    if input.trim().is_empty() {
        return Ok(vec![]);
    }
    expect(&mut i, b"a:")?;
    let n = read_int(&mut i, b':')?;
    expect(&mut i, b"{")?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        // key: i:N; or s:L:"...";
        match b.get(i) {
            Some(b'i') => {
                expect(&mut i, b"i:")?;
                read_int(&mut i, b';')?;
            }
            Some(b's') => {
                expect(&mut i, b"s:")?;
                let l = read_int(&mut i, b':')?;
                i += l + 3; // "...";
            }
            _ => bail!("unsupported array key at byte {i}"),
        }
        expect(&mut i, b"s:")?;
        let len = read_int(&mut i, b':')?;
        expect(&mut i, b"\"")?;
        let s = std::str::from_utf8(&b[i..i + len])?.to_string();
        i += len;
        expect(&mut i, b"\";")?;
        out.push(s);
    }
    expect(&mut i, b"}")?;
    Ok(out)
}

pub fn serialize_string_list(items: &[String]) -> String {
    let mut s = format!("a:{}:{{", items.len());
    for (i, item) in items.iter().enumerate() {
        s.push_str(&format!("i:{};s:{}:\"{}\";", i, item.len(), item));
    }
    s.push('}');
    s
}


/// General `unserialize()` into JSON (arrays with sequential integer keys become JSON arrays,
/// other arrays become objects). Objects are not supported (WordPress options rarely contain them).
pub fn unserialize(input: &str) -> Result<serde_json::Value> {
    let mut p = Parser { b: input.as_bytes(), i: 0 };
    p.value()
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn until(&mut self, end: u8) -> Result<&str> {
        let start = self.i;
        while self.i < self.b.len() && self.b[self.i] != end {
            self.i += 1;
        }
        if self.i >= self.b.len() {
            bail!("truncated PHP serialization");
        }
        let s = std::str::from_utf8(&self.b[start..self.i])?;
        self.i += 1;
        Ok(s)
    }

    fn value(&mut self) -> Result<serde_json::Value> {
        use serde_json::Value;
        let t = *self.b.get(self.i).ok_or_else(|| anyhow::anyhow!("truncated PHP serialization"))?;
        if t == b'N' {
            self.i += 2;
            return Ok(Value::Null);
        }
        self.i += 2; // "x:"
        Ok(match t {
            b'b' => Value::Bool(self.until(b';')? == "1"),
            b'i' => Value::from(self.until(b';')?.parse::<i64>()?),
            b'd' => {
                let f = self.until(b';')?.parse::<f64>()?;
                serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
            }
            b's' => {
                let len: usize = self.until(b':')?.parse()?;
                self.i += 1; // opening quote
                let end = self.i + len;
                if end > self.b.len() {
                    bail!("string length past end of input");
                }
                let s = String::from_utf8_lossy(&self.b[self.i..end]).into_owned();
                self.i = end + 2; // closing quote + ;
                Value::String(s)
            }
            b'a' => {
                let n: usize = self.until(b':')?.parse()?;
                self.i += 1; // {
                let mut entries = Vec::with_capacity(n);
                for _ in 0..n {
                    let k = self.value()?;
                    let v = self.value()?;
                    entries.push((k, v));
                }
                self.i += 1; // }
                let sequential = entries.iter().enumerate().all(|(idx, (k, _))| k.as_i64() == Some(idx as i64));
                if sequential {
                    Value::Array(entries.into_iter().map(|(_, v)| v).collect())
                } else {
                    let mut m = serde_json::Map::new();
                    for (k, v) in entries {
                        let key = match k {
                            Value::String(s) => s,
                            other => other.to_string(),
                        };
                        m.insert(key, v);
                    }
                    Value::Object(m)
                }
            }
            other => bail!("unsupported PHP type '{}'", other as char),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_active_plugins() {
        let raw = r#"a:2:{i:0;s:27:"woocommerce/woocommerce.php";i:1;s:19:"akismet/akismet.php";}"#;
        let list = parse_string_list(raw).unwrap();
        assert_eq!(list, vec!["woocommerce/woocommerce.php", "akismet/akismet.php"]);
        assert_eq!(serialize_string_list(&list), raw);
    }

    #[test]
    fn handles_non_sequential_keys_and_utf8() {
        let raw = "a:2:{i:3;s:5:\"a.php\";i:7;s:7:\"\u{e9}t.php\";}";
        assert_eq!(parse_string_list(raw).unwrap(), vec!["a.php", "\u{e9}t.php"]);
        assert_eq!(parse_string_list("a:0:{}").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn unserializes_product_attributes() {
        let raw = r#"a:2:{s:7:"pa_size";a:6:{s:4:"name";s:7:"pa_size";s:5:"value";s:0:"";s:8:"position";i:0;s:10:"is_visible";i:1;s:12:"is_variation";i:1;s:11:"is_taxonomy";i:1;}s:6:"fabric";a:6:{s:4:"name";s:6:"Fabric";s:5:"value";s:11:"100% cotton";s:8:"position";i:2;s:10:"is_visible";b:1;s:12:"is_variation";b:0;s:11:"is_taxonomy";i:0;}}"#;
        let v = unserialize(raw).unwrap();
        assert_eq!(v["pa_size"]["is_taxonomy"], 1);
        assert_eq!(v["fabric"]["value"], "100% cotton");
        assert_eq!(unserialize("a:2:{i:0;i:5;i:1;d:1.5;}").unwrap(), serde_json::json!([5, 1.5]));
        assert_eq!(unserialize("N;").unwrap(), serde_json::Value::Null);
    }
}
