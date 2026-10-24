//! Client-side image pipeline.
//!
//! Images are decoded, down-scaled to the store's big-image threshold, re-encoded (WebP by
//! default) and every registered WordPress sub-size is generated here using the same geometry
//! rules as WordPress's `image_resize_dimensions()`. The store then does zero image processing,
//! which removes the main cause of slow and failing imports on shared hosting.

use crate::model::ImageSize;
use anyhow::{anyhow, Context, Result};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    #[default]
    Webp,
    Jpeg,
    /// Keep the source format (PNG stays PNG, JPEG stays JPEG).
    Original,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MediaSettings {
    pub format: OutputFormat,
    /// 1–100.
    pub quality: u8,
    /// Longest edge for the stored original (WordPress's big_image_size_threshold).
    pub max_dimension: u32,
    pub generate_sizes: bool,
    /// File name template, e.g. `{sku}-{name}-{n}`.
    pub name_template: String,
}

impl Default for MediaSettings {
    fn default() -> Self {
        Self { format: OutputFormat::Webp, quality: 82, max_dimension: 2560, generate_sizes: true, name_template: "{sku}-{name}-{n}".into() }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedSize {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub filename: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct PreparedImage {
    pub filename: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub sizes: Vec<PreparedSize>,
    pub source_bytes: usize,
}

impl PreparedImage {
    pub fn total_bytes(&self) -> usize {
        self.bytes.len() + self.sizes.iter().map(|s| s.bytes.len()).sum::<usize>()
    }
}

/// Where WordPress would crop from the source for a sub-size, and the output dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResizePlan {
    pub src_x: u32,
    pub src_y: u32,
    pub src_w: u32,
    pub src_h: u32,
    pub dst_w: u32,
    pub dst_h: u32,
}

/// Port of WordPress `wp_constrain_dimensions()`.
pub fn constrain(orig_w: u32, orig_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if max_w == 0 && max_h == 0 {
        return (orig_w, orig_h);
    }
    let (ow, oh) = (orig_w as f64, orig_h as f64);
    let width_ratio = if max_w > 0 && orig_w > max_w { max_w as f64 / ow } else { 1.0 };
    let height_ratio = if max_h > 0 && orig_h > max_h { max_h as f64 / oh } else { 1.0 };
    let ratio = width_ratio.min(height_ratio);
    let w = (ow * ratio).round().max(1.0) as u32;
    let h = (oh * ratio).round().max(1.0) as u32;
    (w, h)
}

/// Port of WordPress `image_resize_dimensions()` (centre crop). `None` means WordPress would not
/// create this size (it would be equal to or larger than the original).
pub fn plan_resize(orig_w: u32, orig_h: u32, dest_w: u32, dest_h: u32, crop: bool) -> Option<ResizePlan> {
    if orig_w == 0 || orig_h == 0 || (dest_w == 0 && dest_h == 0) {
        return None;
    }
    let plan = if crop {
        let new_w = if dest_w == 0 { orig_w } else { dest_w.min(orig_w) };
        let new_h = if dest_h == 0 { orig_h } else { dest_h.min(orig_h) };
        let size_ratio = (new_w as f64 / orig_w as f64).max(new_h as f64 / orig_h as f64);
        let crop_w = (new_w as f64 / size_ratio).round() as u32;
        let crop_h = (new_h as f64 / size_ratio).round() as u32;
        ResizePlan {
            src_x: (orig_w - crop_w.min(orig_w)) / 2,
            src_y: (orig_h - crop_h.min(orig_h)) / 2,
            src_w: crop_w.min(orig_w),
            src_h: crop_h.min(orig_h),
            dst_w: new_w,
            dst_h: new_h,
        }
    } else {
        let (w, h) = constrain(orig_w, orig_h, dest_w, dest_h);
        ResizePlan { src_x: 0, src_y: 0, src_w: orig_w, src_h: orig_h, dst_w: w, dst_h: h }
    };
    if plan.dst_w == orig_w && plan.dst_h == orig_h {
        return None;
    }
    // WordPress also skips a crop that would only shave a pixel or two off the original.
    if plan.dst_w >= orig_w && plan.dst_h >= orig_h {
        return None;
    }
    Some(plan)
}

pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut dash = false;
    for c in s.chars().flat_map(|c| deunicode_char(c).chars().collect::<Vec<_>>()) {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn deunicode_char(c: char) -> String {
    // Small transliteration table for the most common Latin accents; everything else becomes a separator.
    let s = match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => "a",
        'æ' | 'Æ' => "ae",
        'ç' | 'Ç' => "c",
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => "i",
        'ñ' | 'Ñ' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' => "o",
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => "u",
        'ý' | 'ÿ' | 'Ý' => "y",
        'ß' => "ss",
        '&' => "and",
        _ => return c.to_string(),
    };
    s.to_string()
}

/// Renders a file-name template such as `{brand}-{sku}-{name}-{n}`. Unknown or empty variables
/// are dropped, and the result is slugified and capped at 80 characters.
pub fn render_name(template: &str, vars: &[(&str, &str)], fallback: &str) -> String {
    let re = regex::Regex::new(r"\{([a-z_]+)\}").expect("valid regex");
    let rendered = re.replace_all(template, |c: &regex::Captures| {
        vars.iter().find(|(k, _)| *k == &c[1]).map(|(_, v)| v.to_string()).unwrap_or_default()
    });
    let mut slug = slugify(&rendered);
    if slug.is_empty() {
        slug = slugify(fallback);
    }
    if slug.is_empty() {
        slug = "image".into();
    }
    slug.chars().take(80).collect::<String>().trim_end_matches('-').to_string()
}

fn encode(img: &DynamicImage, format: OutputFormat, source: Option<ImageFormat>, quality: u8) -> Result<(Vec<u8>, &'static str, &'static str)> {
    let target = match format {
        OutputFormat::Webp => ImageFormat::WebP,
        OutputFormat::Jpeg => ImageFormat::Jpeg,
        OutputFormat::Original => match source {
            Some(ImageFormat::Png) => ImageFormat::Png,
            Some(ImageFormat::WebP) => ImageFormat::WebP,
            Some(ImageFormat::Gif) => ImageFormat::Png,
            _ => ImageFormat::Jpeg,
        },
    };
    match target {
        ImageFormat::WebP => {
            let rgba = img.to_rgba8();
            let enc = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
            let mem = enc.encode(quality.clamp(1, 100) as f32);
            Ok((mem.to_vec(), "image/webp", "webp"))
        }
        ImageFormat::Png => {
            let mut out = std::io::Cursor::new(Vec::new());
            img.write_to(&mut out, ImageFormat::Png)?;
            Ok((out.into_inner(), "image/png", "png"))
        }
        _ => {
            let mut out = Vec::new();
            let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100)).encode_image(&rgb)?;
            Ok((out, "image/jpeg", "jpg"))
        }
    }
}

/// Decodes an image and applies its EXIF orientation, so phone photos stored sideways come out upright
/// (the re-encoded file carries no EXIF, so browsers would otherwise show them rotated).
fn decode_upright(source: &[u8]) -> Result<DynamicImage> {
    use image::ImageDecoder;
    let mut decoder = image::ImageReader::new(std::io::Cursor::new(source))
        .with_guessed_format()?
        .into_decoder()
        .context("Unsupported or corrupt image")?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).context("Unsupported or corrupt image")?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Re-encodes any supported image as an upright JPEG no larger than `max` px on its longest edge,
/// with transparency flattened onto white. Used to embed product photos in catalogue PDFs.
pub fn print_jpeg(source: &[u8], max: u32, quality: u8) -> Result<Vec<u8>> {
    let img = decode_upright(source)?;
    let (w, h) = img.dimensions();
    let img = if w.max(h) > max { img.resize(max, max, FilterType::Triangle) } else { img };
    let rgba = img.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([blend(p[0]), blend(p[1]), blend(p[2])]));
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(30, 100)).encode_image(&rgb)?;
    Ok(out)
}

/// Prepares one image from raw bytes. `stem` is the already-rendered file name without extension.
pub fn prepare(source: &[u8], stem: &str, sizes: &[ImageSize], settings: &MediaSettings) -> Result<PreparedImage> {
    let source_format = image::guess_format(source).ok();
    let mut img = decode_upright(source)?;
    let (w, h) = img.dimensions();
    if settings.max_dimension > 0 && (w > settings.max_dimension || h > settings.max_dimension) {
        let (nw, nh) = constrain(w, h, settings.max_dimension, settings.max_dimension);
        img = img.resize_exact(nw, nh, FilterType::Lanczos3);
    }
    let (w, h) = img.dimensions();
    let (bytes, mime, ext) = encode(&img, settings.format, source_format, settings.quality)?;
    let stem = if stem.is_empty() { "image" } else { stem };

    let mut prepared_sizes: Vec<PreparedSize> = if settings.generate_sizes {
        sizes
            .par_iter()
            .filter_map(|s| plan_resize(w, h, s.width, s.height, s.crop).map(|p| (s, p)))
            .map(|(s, p)| -> Result<PreparedSize> {
                let cropped = img.crop_imm(p.src_x, p.src_y, p.src_w, p.src_h);
                let resized = cropped.resize_exact(p.dst_w, p.dst_h, FilterType::CatmullRom);
                let (b, _, _) = encode(&resized, settings.format, source_format, settings.quality)?;
                Ok(PreparedSize { name: s.name.clone(), width: p.dst_w, height: p.dst_h, filename: format!("{stem}-{}x{}.{ext}", p.dst_w, p.dst_h), bytes: b })
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![]
    };
    prepared_sizes.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(PreparedImage {
        filename: format!("{stem}.{ext}"),
        mime: mime.into(),
        width: w,
        height: h,
        sha256: hex::encode(Sha256::digest(&bytes)),
        bytes,
        sizes: prepared_sizes,
        source_bytes: source.len(),
    })
}

pub fn prepare_file(path: &Path, stem: &str, sizes: &[ImageSize], settings: &MediaSettings) -> Result<PreparedImage> {
    let bytes = std::fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?;
    prepare(&bytes, stem, sizes, settings).with_context(|| format!("Processing {}", path.display()))
}

pub async fn fetch_url(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let res = client.get(url).send().await.with_context(|| format!("Downloading {url}"))?;
    if !res.status().is_success() {
        return Err(anyhow!("Downloading {url} failed with {}", res.status()));
    }
    Ok(res.bytes().await?.to_vec())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

/// Image files in a folder (recursive), for drag-and-drop folder imports.
pub fn scan_folder(dir: &Path) -> Vec<std::path::PathBuf> {
    let exts = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
    let mut out: Vec<_> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()).map(|x| exts.contains(&x.to_ascii_lowercase().as_str())).unwrap_or(false))
        .map(|e| e.into_path())
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn print_jpeg_shrinks_and_flattens() {
        let mut img = image::RgbaImage::new(2000, 1000);
        for p in img.pixels_mut() {
            *p = image::Rgba([255, 0, 0, 0]);
        }
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png).unwrap();
        let jpg = super::print_jpeg(&png, 800, 80).unwrap();
        let out = image::load_from_memory(&jpg).unwrap();
        assert_eq!(out.dimensions(), (800, 400));
        assert!(out.to_rgb8().get_pixel(10, 10)[1] > 240, "transparent pixels become white");
    }

    use super::*;

    #[test]
    fn constrain_matches_wordpress() {
        assert_eq!(constrain(2000, 1000, 300, 300), (300, 150));
        assert_eq!(constrain(1000, 2000, 300, 300), (150, 300));
        assert_eq!(constrain(200, 100, 300, 300), (200, 100));
        assert_eq!(constrain(2000, 1000, 768, 0), (768, 384));
    }

    #[test]
    fn plans_match_wordpress_geometry() {
        // thumbnail 150x150 crop on 800x600 → crop centre 600x600 → 150x150
        let p = plan_resize(800, 600, 150, 150, true).unwrap();
        assert_eq!((p.src_x, p.src_y, p.src_w, p.src_h, p.dst_w, p.dst_h), (100, 0, 600, 600, 150, 150));
        // medium 300x300 fit on 800x600 → 300x225
        let p = plan_resize(800, 600, 300, 300, false).unwrap();
        assert_eq!((p.dst_w, p.dst_h), (300, 225));
        // medium_large 768x0 on 800x600 → 768x576
        let p = plan_resize(800, 600, 768, 0, false).unwrap();
        assert_eq!((p.dst_w, p.dst_h), (768, 576));
        // sizes larger than the original are skipped
        assert!(plan_resize(800, 600, 1024, 1024, false).is_none());
        assert!(plan_resize(100, 100, 150, 150, true).is_none());
        // woocommerce_thumbnail-style crop where only one side is smaller
        let p = plan_resize(400, 120, 300, 300, true).unwrap();
        assert_eq!((p.src_x, p.src_w, p.dst_w, p.dst_h), (50, 300, 300, 120));
        assert!(plan_resize(300, 120, 300, 300, true).is_none());
    }

    #[test]
    fn names_render_and_slugify() {
        assert_eq!(slugify("Crème Brûlée & Co. 50ml"), "creme-brulee-and-co-50ml");
        assert_eq!(render_name("{brand}-{sku}-{name}-{n}", &[("sku", "AB-12"), ("name", "Red Shoe"), ("n", "2")], "x"), "ab-12-red-shoe-2");
        assert_eq!(render_name("{missing}", &[], "Fallback Name"), "fallback-name");
    }

    #[test]
    fn prepares_webp_with_all_sizes() {
        let mut img = image::RgbImage::new(1200, 900);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = image::Rgb([(x % 255) as u8, (y % 255) as u8, 128]);
        }
        let mut src = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img).write_to(&mut src, ImageFormat::Png).unwrap();
        let sizes = vec![
            ImageSize { name: "thumbnail".into(), width: 150, height: 150, crop: true },
            ImageSize { name: "medium".into(), width: 300, height: 300, crop: false },
            ImageSize { name: "large".into(), width: 1024, height: 1024, crop: false },
            ImageSize { name: "2048x2048".into(), width: 2048, height: 2048, crop: false },
        ];
        let out = prepare(src.get_ref(), "red-shoe", &sizes, &MediaSettings::default()).unwrap();
        assert_eq!(out.mime, "image/webp");
        assert_eq!(out.filename, "red-shoe.webp");
        assert_eq!((out.width, out.height), (1200, 900));
        let names: Vec<_> = out.sizes.iter().map(|s| (s.name.as_str(), s.width, s.height)).collect();
        assert_eq!(names, vec![("large", 1024, 768), ("medium", 300, 225), ("thumbnail", 150, 150)]);
        assert_eq!(out.sizes[2].filename, "red-shoe-150x150.webp");
        assert!(out.bytes.len() < src.get_ref().len());
        assert_eq!(out.sha256.len(), 64);
        // deterministic → server-side de-duplication works across re-imports
        let again = prepare(src.get_ref(), "red-shoe", &sizes, &MediaSettings::default()).unwrap();
        assert_eq!(again.sha256, out.sha256);
    }

    #[test]
    fn applies_exif_orientation() {
        // A 300x200 landscape picture stored rotated (200x300) with EXIF orientation 6 (rotate 90° CW).
        let landscape = image::RgbImage::from_fn(300, 200, |x, _| if x < 150 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) });
        let stored = DynamicImage::ImageRgb8(landscape).rotate270();
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95).encode_image(&stored).unwrap();
        // Insert an APP1/EXIF segment with Orientation = 6 right after SOI.
        let tiff: Vec<u8> = [b"MM\0\x2a\0\0\0\x08".as_slice(), &[0, 1], &[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0], &[0, 0, 0, 0]].concat();
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(&tiff);
        let mut with_exif = vec![0xFF, 0xD8, 0xFF, 0xE1];
        with_exif.extend(((app1.len() + 2) as u16).to_be_bytes());
        with_exif.extend(&app1);
        with_exif.extend(&jpeg[2..]);
        let out = prepare(&with_exif, "phone", &[], &MediaSettings { format: OutputFormat::Jpeg, ..Default::default() }).unwrap();
        assert_eq!((out.width, out.height), (300, 200), "should be upright landscape");
        let decoded = image::load_from_memory(&out.bytes).unwrap().to_rgb8();
        assert!(decoded.get_pixel(20, 100)[0] > 200, "left half should be red after rotation");
    }

    #[test]
    fn caps_big_images() {
        let img = DynamicImage::ImageRgb8(image::RgbImage::new(5000, 2500));
        let mut src = std::io::Cursor::new(Vec::new());
        img.write_to(&mut src, ImageFormat::Jpeg).unwrap();
        let out = prepare(src.get_ref(), "big", &[], &MediaSettings { format: OutputFormat::Jpeg, ..Default::default() }).unwrap();
        assert_eq!((out.width, out.height), (2560, 1280));
        assert_eq!(out.mime, "image/jpeg");
    }
}
