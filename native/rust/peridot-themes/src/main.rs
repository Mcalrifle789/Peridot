//! peridot-themes — generates Peridot's GUI theme palettes.
//!
//! Each theme is defined by three anchor colors (accent, highlight, primary);
//! the remaining UI roles are derived from them, then every palette is checked
//! against WCAG contrast minimums on the pitch-black background and the bar
//! background. Nothing is written if any theme fails.
//!
//!   peridot-themes <out.js>   validate, then write the JS module
//!   peridot-themes --check    validate and print the contrast table only

use std::fmt::Write as _;
use std::process::ExitCode;

type Rgb = [u8; 3];

struct ThemeDef {
    id: &'static str,
    name: &'static str,
    desc: &'static str,
    accent: Rgb,    // `neon` — signature color: prompt, active items, header mark
    highlight: Rgb, // `chart` — gradient highlight, plan chip
    primary: Rgb,   // `green` — menu items, category labels
    overrides: &'static [(&'static str, Rgb)],
}

const ROLES: [&str; 13] = [
    "neon", "chart", "lime", "green", "mid", "deep", "moss", "dimg", "gray", "white", "red", "yellow", "bar",
];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const GRAY: Rgb = [150, 150, 150];
const LIGHT_GRAY: Rgb = [170, 170, 170];

const THEMES: &[ThemeDef] = &[
    // The original hand-tuned palette, reproduced exactly.
    ThemeDef {
        id: "peridot",
        name: "Peridot",
        desc: "signature peridot green on pitch black",
        accent: [128, 255, 0],
        highlight: [204, 255, 0],
        primary: [0, 220, 60],
        overrides: &[
            ("lime", [57, 255, 20]),
            ("mid", [34, 197, 94]),
            ("deep", [24, 140, 60]),
            ("moss", [110, 150, 90]),
            ("dimg", [70, 110, 60]),
            ("gray", [140, 160, 140]),
            ("white", [235, 255, 235]),
            ("bar", [10, 26, 8]),
        ],
    },
    ThemeDef {
        id: "indigo-bridle-path",
        name: "Indigo Bridle Path",
        desc: "deep indigo trail with saddle-leather tan",
        accent: [150, 136, 255],
        highlight: [230, 196, 146],
        primary: [128, 114, 245],
        overrides: &[("deep", [104, 92, 205])],
    },
    ThemeDef {
        id: "galactic-neon-magenta",
        name: "Galactic Neon Magenta",
        desc: "hot neon magenta in a violet nebula",
        accent: [255, 64, 220],
        highlight: [196, 150, 255],
        primary: [236, 72, 200],
        overrides: &[],
    },
    ThemeDef {
        id: "nyc-yellow",
        name: "NYC Yellow",
        desc: "taxi-cab yellow on midnight asphalt",
        accent: [255, 214, 0],
        highlight: [255, 240, 150],
        primary: [240, 190, 20],
        // warnings can't be yellow on a yellow theme
        overrides: &[("yellow", [255, 140, 50])],
    },
    ThemeDef {
        id: "seattle-blue",
        name: "Seattle Blue",
        desc: "rain-cool Puget Sound blue",
        accent: [86, 176, 255],
        highlight: [176, 222, 255],
        primary: [74, 154, 235],
        overrides: &[],
    },
    ThemeDef {
        id: "cyan-atlantis",
        name: "Cyan Atlantis",
        desc: "luminous deep-sea cyan",
        accent: [0, 240, 255],
        highlight: [150, 255, 245],
        primary: [0, 200, 215],
        overrides: &[],
    },
];

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let ch = |i: usize| (a[i] as f64 + (b[i] as f64 - a[i] as f64) * t).round() as u8;
    [ch(0), ch(1), ch(2)]
}

fn scale(a: Rgb, k: f64) -> Rgb {
    mix(BLACK, a, k)
}

fn derive(t: &ThemeDef) -> Vec<(&'static str, Rgb)> {
    let mut p = vec![
        ("neon", t.accent),
        ("chart", t.highlight),
        ("lime", mix(t.accent, t.highlight, 0.5)),
        ("green", t.primary),
        ("mid", mix(t.primary, t.accent, 0.4)),
        ("deep", scale(t.primary, 0.66)),
        ("moss", mix(t.primary, GRAY, 0.55)),
        ("dimg", scale(mix(t.primary, GRAY, 0.35), 0.67)),
        ("gray", mix(t.primary, LIGHT_GRAY, 0.8)),
        ("white", mix(t.accent, WHITE, 0.88)),
        ("red", [255, 90, 90]),
        ("yellow", [255, 220, 90]),
        ("bar", scale(t.primary, 0.11)),
    ];
    for (role, color) in t.overrides {
        let slot = p.iter_mut().find(|(r, _)| r == role).unwrap_or_else(|| panic!("unknown role {role}"));
        slot.1 = *color;
    }
    p
}

fn luminance(c: Rgb) -> f64 {
    let lin = |v: u8| {
        let s = v as f64 / 255.0;
        if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

fn distance(a: Rgb, b: Rgb) -> f64 {
    (0..3).map(|i| (a[i] as f64 - b[i] as f64).powi(2)).sum::<f64>().sqrt()
}

fn get(p: &[(&str, Rgb)], role: &str) -> Rgb {
    p.iter().find(|(r, _)| *r == role).map(|(_, c)| *c).expect("role present")
}

/// Returns human-readable failures for one palette.
fn validate(p: &[(&str, Rgb)]) -> Vec<String> {
    let mut fails = Vec::new();
    let bar = get(p, "bar");
    // (role, background, background name, minimum ratio)
    let mut rules: Vec<(&str, Rgb, &str, f64)> = ["neon", "chart", "lime", "green", "mid", "moss", "gray", "white", "red", "yellow"]
        .iter()
        .map(|r| (*r, BLACK, "black", 4.5))
        .collect();
    rules.extend([
        ("deep", BLACK, "black", 3.0),  // rules, prompt glyphs
        ("dimg", BLACK, "black", 3.0),  // hints, structure lines
        ("neon", bar, "bar", 4.5),      // header mark
        ("moss", bar, "bar", 4.5),      // header labels
        ("dimg", bar, "bar", 2.5),      // header subtitle
    ]);
    for (role, bg, bg_name, min) in rules {
        let ratio = contrast(get(p, role), bg);
        if ratio < min {
            fails.push(format!("{role} on {bg_name}: {ratio:.2} < {min}"));
        }
    }
    // Warnings and errors must stand apart from the theme's own colors.
    for status in ["yellow", "red"] {
        for role in ["neon", "chart", "green"] {
            let d = distance(get(p, status), get(p, role));
            if d < 60.0 {
                fails.push(format!("{status} too close to {role} (distance {d:.0} < 60)"));
            }
        }
    }
    fails
}

fn js_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn render_js(themes: &[(&ThemeDef, Vec<(&'static str, Rgb)>)]) -> String {
    let mut out = String::new();
    out.push_str("// Generated by native/rust/peridot-themes — do not edit by hand.\n");
    out.push_str("// Regenerate: npm run build:themes\n");
    out.push_str("export const THEMES = [\n");
    for (t, p) in themes {
        out.push_str("  {\n");
        let _ = writeln!(out, "    id: {},", js_string(t.id));
        let _ = writeln!(out, "    name: {},", js_string(t.name));
        let _ = writeln!(out, "    desc: {},", js_string(t.desc));
        out.push_str("    palette: {\n");
        for role in ROLES {
            let c = get(p, role);
            let _ = writeln!(out, "      {role}: [{}, {}, {}],", c[0], c[1], c[2]);
        }
        out.push_str("    },\n  },\n");
    }
    out.push_str("];\n");
    out
}

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    let Some(arg) = arg else {
        eprintln!("usage: peridot-themes <out.js> | --check");
        return ExitCode::from(2);
    };

    let built: Vec<_> = THEMES.iter().map(|t| (t, derive(t))).collect();
    let mut ok = true;
    for (t, p) in &built {
        let fails = validate(p);
        let accent = get(p, "neon");
        println!(
            "{:<24} accent #{:02X}{:02X}{:02X}  contrast {:>5.2}  {}",
            t.name,
            accent[0], accent[1], accent[2],
            contrast(accent, BLACK),
            if fails.is_empty() { "ok" } else { "FAIL" }
        );
        for f in &fails {
            println!("    - {f}");
        }
        ok &= fails.is_empty();
    }
    if !ok {
        eprintln!("theme validation failed — nothing written");
        return ExitCode::from(1);
    }
    if arg == "--check" {
        return ExitCode::SUCCESS;
    }
    if let Err(e) = std::fs::write(&arg, render_js(&built)) {
        eprintln!("cannot write {arg}: {e}");
        return ExitCode::from(1);
    }
    println!("wrote {arg}: {} themes", built.len());
    ExitCode::SUCCESS
}
