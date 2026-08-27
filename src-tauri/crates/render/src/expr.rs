//! ffmpeg filter expressions for keyframed values.
//!
//! ffmpeg has no notion of a keyframe track, so a keyframed number becomes a nested
//! `if(lt(t, …), lerp, …)` chain evaluated per frame. Building these as strings is fiddly
//! and easy to get subtly wrong, so it lives here behind unit tests.

/// One keyframed value: seconds from the start of the clip, and the value there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub t: f32,
    pub v: f32,
}

/// Build a piecewise-linear expression over `time_var`.
///
/// Before the first point and after the last, the value is held flat, which matches how
/// the editor previews it. `time_var` is whatever the target filter calls time — `t` for
/// `rotate`/`geq`, `(on/fps)` for `zoompan`, which counts output frames instead.
pub fn piecewise_linear(points: &[Point], time_var: &str) -> String {
    let mut pts: Vec<Point> = points.to_vec();
    pts.retain(|p| p.t.is_finite() && p.v.is_finite());
    pts.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup_by(|a, b| (a.t - b.t).abs() < 1e-6);

    match pts.len() {
        0 => "0".to_string(),
        1 => num(pts[0].v),
        _ => {
            // Fold from the last segment backwards so the chain nests left to right.
            let last = pts[pts.len() - 1].v;
            let mut expr = num(last);
            for pair in pts.windows(2).rev() {
                let (a, b) = (pair[0], pair[1]);
                expr = format!(
                    "if(lt({time_var},{tb}),{seg},{expr})",
                    tb = num(b.t),
                    seg = segment(a, b, time_var),
                );
            }
            // Hold the first value for anything before the first keyframe.
            format!(
                "if(lt({time_var},{ta}),{va},{expr})",
                ta = num(pts[0].t),
                va = num(pts[0].v)
            )
        }
    }
}

/// Linear interpolation between two points, as an ffmpeg expression.
fn segment(a: Point, b: Point, time_var: &str) -> String {
    let dt = b.t - a.t;
    if dt.abs() < 1e-6 {
        return num(b.v);
    }
    let slope = (b.v - a.v) / dt;
    if slope.abs() < 1e-9 {
        return num(a.v);
    }
    format!(
        "({va}+({slope})*({time_var}-{ta}))",
        va = num(a.v),
        slope = num(slope),
        ta = num(a.t),
    )
}

/// ffmpeg's expression parser is locale-independent and wants a plain decimal; make sure
/// we never emit scientific notation or a bare `-`.
pub fn num(v: f32) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{:.6}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" || s == "-0" {
        "0".to_string()
    } else {
        s
    }
}

/// True when every point holds the same value — the caller can then skip the filter.
pub fn is_constant(points: &[Point], target: f32) -> bool {
    points.iter().all(|p| (p.v - target).abs() < 1e-4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(t: f32, v: f32) -> Point {
        Point { t, v }
    }

    /// Tiny evaluator for the subset of ffmpeg expression syntax we emit, so the tests can
    /// assert on values rather than on string shape.
    fn eval(expr: &str, t: f32) -> f32 {
        Parser {
            s: expr.as_bytes(),
            i: 0,
            t,
        }
        .expr()
    }

    struct Parser<'a> {
        s: &'a [u8],
        i: usize,
        t: f32,
    }

    impl Parser<'_> {
        fn peek(&self) -> u8 {
            *self.s.get(self.i).unwrap_or(&0)
        }
        fn eat(&mut self, c: u8) {
            assert_eq!(self.peek(), c, "expected {} at {}", c as char, self.i);
            self.i += 1;
        }
        fn starts_with(&self, kw: &str) -> bool {
            self.s[self.i..].starts_with(kw.as_bytes())
        }
        fn expr(&mut self) -> f32 {
            let mut v = self.term();
            loop {
                match self.peek() {
                    b'+' => {
                        self.i += 1;
                        v += self.term();
                    }
                    b'-' => {
                        self.i += 1;
                        v -= self.term();
                    }
                    _ => return v,
                }
            }
        }
        fn term(&mut self) -> f32 {
            let mut v = self.atom();
            while self.peek() == b'*' {
                self.i += 1;
                v *= self.atom();
            }
            v
        }
        fn atom(&mut self) -> f32 {
            if self.starts_with("if(") {
                self.i += 3;
                let cond = self.expr();
                self.eat(b',');
                let a = self.expr();
                self.eat(b',');
                let b = self.expr();
                self.eat(b')');
                return if cond != 0.0 { a } else { b };
            }
            if self.starts_with("lt(") {
                self.i += 3;
                let a = self.expr();
                self.eat(b',');
                let b = self.expr();
                self.eat(b')');
                return if a < b { 1.0 } else { 0.0 };
            }
            if self.peek() == b'(' {
                self.i += 1;
                let v = self.expr();
                self.eat(b')');
                return v;
            }
            if self.peek() == b't' {
                self.i += 1;
                return self.t;
            }
            let start = self.i;
            if self.peek() == b'-' {
                self.i += 1;
            }
            while matches!(self.peek(), b'0'..=b'9' | b'.') {
                self.i += 1;
            }
            std::str::from_utf8(&self.s[start..self.i])
                .unwrap()
                .parse()
                .unwrap_or_else(|e| panic!("bad number at {start}: {e}"))
        }
    }

    #[test]
    fn no_points_is_zero() {
        assert_eq!(piecewise_linear(&[], "t"), "0");
    }

    #[test]
    fn one_point_is_a_constant() {
        assert_eq!(piecewise_linear(&[p(0.0, 1.25)], "t"), "1.25");
    }

    #[test]
    fn interpolates_linearly_between_two_points() {
        let e = piecewise_linear(&[p(0.0, 1.0), p(2.0, 2.0)], "t");
        assert!((eval(&e, 0.0) - 1.0).abs() < 1e-4, "{e}");
        assert!((eval(&e, 1.0) - 1.5).abs() < 1e-4, "{e}");
        assert!((eval(&e, 2.0) - 2.0).abs() < 1e-4, "{e}");
    }

    #[test]
    fn holds_the_end_values_outside_the_keyframe_range() {
        let e = piecewise_linear(&[p(1.0, 10.0), p(2.0, 20.0)], "t");
        assert!((eval(&e, 0.0) - 10.0).abs() < 1e-4, "before the first: {e}");
        assert!((eval(&e, 9.0) - 20.0).abs() < 1e-4, "after the last: {e}");
    }

    #[test]
    fn walks_three_segments_in_order() {
        let e = piecewise_linear(&[p(0.0, 0.0), p(1.0, 10.0), p(3.0, 0.0)], "t");
        assert!((eval(&e, 0.5) - 5.0).abs() < 1e-3, "{e}");
        assert!((eval(&e, 1.0) - 10.0).abs() < 1e-3, "{e}");
        assert!((eval(&e, 2.0) - 5.0).abs() < 1e-3, "{e}");
    }

    #[test]
    fn sorts_and_dedupes_unordered_input() {
        let e = piecewise_linear(&[p(2.0, 2.0), p(0.0, 1.0), p(2.0, 99.0)], "t");
        assert!((eval(&e, 1.0) - 1.5).abs() < 1e-4, "{e}");
    }

    #[test]
    fn a_flat_segment_collapses_to_its_value() {
        let e = piecewise_linear(&[p(0.0, 3.0), p(5.0, 3.0)], "t");
        assert!((eval(&e, 2.5) - 3.0).abs() < 1e-4, "{e}");
    }

    #[test]
    fn emits_plain_decimals_ffmpeg_can_parse() {
        assert_eq!(num(1.0), "1", "whole numbers lose their .0");
        assert_eq!(num(1.5), "1.5");
        assert_eq!(num(0.000001), "0.000001", "six decimals survive");
        assert_eq!(
            num(1.0e-7),
            "0",
            "anything finer rounds to zero, never to 1e-7"
        );
        assert_eq!(num(-0.0), "0", "ffmpeg has no use for a signed zero");
        assert_eq!(
            num(f32::NAN),
            "0",
            "a non-finite value never reaches the filter graph"
        );
        assert!(!num(1.0e-7).contains('e'));
    }

    #[test]
    fn detects_constants_so_filters_can_be_skipped() {
        assert!(is_constant(&[p(0.0, 1.0), p(2.0, 1.0)], 1.0));
        assert!(!is_constant(&[p(0.0, 1.0), p(2.0, 1.4)], 1.0));
    }

    #[test]
    fn works_with_the_zoompan_frame_counter() {
        let e = piecewise_linear(&[p(0.0, 1.0), p(2.0, 2.0)], "(on/30)");
        assert!(e.contains("(on/30)"), "{e}");
    }
}
