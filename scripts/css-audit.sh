#!/bin/sh
# Keeps app.css on the design system. tokens.css owns every colour, so a colour literal
# in app.css is a token that was never named; and spacing is a 4px grid (2/4/8/12/16/24/32,
# the --sp-* scale), so an offset or padding off it is a one-off that will drift. Exits 1
# on any hit, and prints each one with its line.
f=src/styles/app.css
colour=$(grep -nE '#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(' "$f")
grid=$(grep -nE '^\s*(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)(-(top|right|bottom|left|block|inline)(-(start|end))?)?\s*:[^;]*(^|[^0-9.])(3|5|6|7|9|10|11|13|14|15|17|18|19|20|21|22|23|25|26|27|28|29|30|31|33|34|35|36)px' "$f")
size=$(grep -nE '\b[0-9]+\.[0-9]+px' "$f")
fail=0
if [ -n "$colour" ]; then echo "colour literals in $f (name a token in tokens.css):"; echo "$colour"; fail=1; fi
if [ -n "$grid" ]; then echo "off-grid spacing in $f (use the --sp-* scale):"; echo "$grid"; fail=1; fi
if [ -n "$size" ]; then echo "fractional px in $f (use a scale step):"; echo "$size"; fail=1; fi
[ $fail -eq 0 ] && echo "audit:css — $f is on the token scales"
exit $fail
